import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { execute, acquireAdvisoryLock, releaseAdvisoryLock } from '../index.js';
import type { Operation } from '../../planner/index.js';
import type { SchemaFile } from '../../core/files.js';
import { createLogger } from '../../core/logger.js';
import { closePool, getPool } from '../../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

let schemaCount = 0;
function uniqueSchema(): string {
  return `exec_test_${Date.now()}_${schemaCount++}`;
}

const logger = createLogger({ verbose: false, quiet: true, json: false });

describe('Executor', () => {
  afterAll(async () => {
    await closePool();
  });

  describe('advisory locking', () => {
    it('should acquire and release an advisory lock', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const acquired = await acquireAdvisoryLock(client);
        expect(acquired).toBe(true);
        await releaseAdvisoryLock(client);
      } finally {
        client.release();
      }
    });

    it('should fail to acquire lock if already held by another session', async () => {
      const pool = getPool(DATABASE_URL);
      const client1 = await pool.connect();
      const client2 = await pool.connect();
      try {
        const first = await acquireAdvisoryLock(client1);
        expect(first).toBe(true);
        const second = await acquireAdvisoryLock(client2);
        expect(second).toBe(false);
        await releaseAdvisoryLock(client1);
      } finally {
        client1.release();
        client2.release();
      }
    });
  });

  describe('execute operations', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
      } finally {
        client.release();
      }
    });

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      } finally {
        client.release();
      }
    });

    it('should execute a create_table operation', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: `CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY, "name" text NOT NULL)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(1);
      expect(result.dryRun).toBe(false);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'users'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('should execute multiple operations in phase order', async () => {
      const ops: Operation[] = [
        {
          type: 'set_comment',
          phase: 14,
          objectName: 'users',
          sql: `COMMENT ON TABLE "${testSchema}"."users" IS 'User accounts'`,
          destructive: false,
        },
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: `CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT obj_description(c.oid) as comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = 'users'`,
          [testSchema],
        );
        expect(res.rows[0].comment).toBe('User accounts');
      } finally {
        client.release();
      }
    });

    it('should not execute anything in dry-run mode', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'should_not_exist',
          sql: `CREATE TABLE "${testSchema}"."should_not_exist" ("id" integer)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        dryRun: true,
        logger,
      });

      expect(result.executed).toBe(0);
      expect(result.dryRun).toBe(true);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'should_not_exist'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should validate mode: execute in a transaction that is rolled back', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'validated_table',
          sql: `CREATE TABLE "${testSchema}"."validated_table" ("id" integer)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        validateOnly: true,
        logger,
      });

      expect(result.executed).toBe(1);
      expect(result.validated).toBe(true);

      // Table should NOT exist (rolled back)
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'validated_table'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should rollback on error during execution', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'good_table',
          sql: `CREATE TABLE "${testSchema}"."good_table" ("id" integer)`,
          destructive: false,
        },
        {
          type: 'create_table',
          phase: 6,
          objectName: 'bad_table',
          sql: `CREATE TABLE "${testSchema}"."bad_table" (INVALID SQL HERE)`,
          destructive: false,
        },
      ];

      await expect(
        execute({ connectionString: DATABASE_URL, operations: ops, logger }),
      ).rejects.toThrow();

      // good_table should NOT exist (transaction rolled back)
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'good_table'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should ensure _simplicity schema and history table are created', async () => {
      // Drop _simplicity if it exists to test creation
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('DROP SCHEMA IF EXISTS _simplicity CASCADE');
      } finally {
        client.release();
      }

      await execute({ connectionString: DATABASE_URL, operations: [], logger });

      const client2 = await pool.connect();
      try {
        const res = await client2.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '_simplicity' AND table_name = 'history'`,
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client2.release();
      }
    });
  });

  describe('pre/post scripts', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
      } finally {
        client.release();
      }
    });

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      } finally {
        client.release();
      }
    });

    it('should execute pre-scripts before operations', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-test-'));
      const preSqlPath = path.join(tmpDir, 'pre.sql');
      await fs.writeFile(
        preSqlPath,
        `CREATE TABLE "${testSchema}"."from_pre_script" ("id" integer)`,
      );

      const { hashFile } = await import('../../core/files.js');
      const hash = await hashFile(preSqlPath);

      const preScripts: SchemaFile[] = [
        {
          relativePath: `pre/${testSchema}_pre.sql`,
          absolutePath: preSqlPath,
          phase: 'pre',
          hash,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: [],
        preScripts,
        logger,
      });

      expect(result.preScriptsRun).toBe(1);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'from_pre_script'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }

      await fs.rm(tmpDir, { recursive: true });
    });

    it('should skip pre-scripts that have not changed (hash match)', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-test-'));
      const preSqlPath = path.join(tmpDir, 'pre.sql');
      await fs.writeFile(preSqlPath, `SELECT 1`);

      const { hashFile } = await import('../../core/files.js');
      const hash = await hashFile(preSqlPath);

      // Use a unique relative path so it doesn't collide with other tests
      const relPath = `pre/${testSchema}_check.sql`;
      const preScripts: SchemaFile[] = [
        {
          relativePath: relPath,
          absolutePath: preSqlPath,
          phase: 'pre',
          hash,
        },
      ];

      // Run once — should execute
      const result1 = await execute({
        connectionString: DATABASE_URL,
        operations: [],
        preScripts,
        logger,
      });
      expect(result1.preScriptsRun).toBe(1);

      // Run again — should skip
      const result2 = await execute({
        connectionString: DATABASE_URL,
        operations: [],
        preScripts,
        logger,
      });

      expect(result2.preScriptsRun).toBe(0);
      expect(result2.skippedScripts).toBe(1);

      await fs.rm(tmpDir, { recursive: true });
    });

    it('should execute post-scripts after operations', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-test-'));
      const postSqlPath = path.join(tmpDir, 'post.sql');
      await fs.writeFile(
        postSqlPath,
        `CREATE TABLE "${testSchema}"."from_post_script" ("id" integer)`,
      );

      const { hashFile } = await import('../../core/files.js');
      const hash = await hashFile(postSqlPath);

      const postScripts: SchemaFile[] = [
        {
          relativePath: `post/${testSchema}_post.sql`,
          absolutePath: postSqlPath,
          phase: 'post',
          hash,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: [],
        postScripts,
        logger,
      });

      expect(result.postScriptsRun).toBe(1);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'from_post_script'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }

      await fs.rm(tmpDir, { recursive: true });
    });

    it('should execute concurrent operations outside the transaction', async () => {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
      // First create a table, then add a CONCURRENTLY index — both should succeed.
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'indexed_table',
          sql: `CREATE TABLE "${testSchema}"."indexed_table" ("id" uuid PRIMARY KEY, "email" text NOT NULL)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_indexed_table_email',
          sql: `CREATE INDEX CONCURRENTLY "idx_indexed_table_email" ON "${testSchema}"."indexed_table" USING btree ("email")`,
          destructive: false,
          concurrent: true,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      // Both operations should execute
      expect(result.executed).toBe(2);

      // Verify the index was actually created
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'indexed_table' AND indexname = 'idx_indexed_table_email'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('should skip concurrent operations in validate mode', async () => {
      // In validate mode, we run transactional ops in a rolled-back transaction
      // but concurrent ops cannot be validated this way, so they are skipped
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'val_table',
          sql: `CREATE TABLE "${testSchema}"."val_table" ("id" uuid PRIMARY KEY, "email" text)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_val_email',
          sql: `CREATE INDEX CONCURRENTLY "idx_val_email" ON "${testSchema}"."val_table" USING btree ("email")`,
          destructive: false,
          concurrent: true,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        validateOnly: true,
        logger,
      });

      // Only the transactional op executed (then rolled back)
      expect(result.executed).toBe(1);
      expect(result.validated).toBe(true);

      // Table should NOT exist (rolled back)
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'val_table'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should not run post-scripts in validate mode', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-test-'));
      const postSqlPath = path.join(tmpDir, 'post.sql');
      await fs.writeFile(postSqlPath, `SELECT 1`);

      const { hashFile } = await import('../../core/files.js');
      const hash = await hashFile(postSqlPath);

      const postScripts: SchemaFile[] = [
        {
          relativePath: `post/${testSchema}_validate_post.sql`,
          absolutePath: postSqlPath,
          phase: 'post',
          hash,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: [],
        postScripts,
        validateOnly: true,
        logger,
      });

      expect(result.postScriptsRun).toBe(0);
      expect(result.validated).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
