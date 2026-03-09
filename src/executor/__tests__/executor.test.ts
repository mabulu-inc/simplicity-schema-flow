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

  describe('safe NOT NULL pattern', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY, "email" text)`);
        // Insert a row so VALIDATE CONSTRAINT actually has data to check
        await client.query(`INSERT INTO "${testSchema}"."users" (id, email) VALUES (gen_random_uuid(), 'test@example.com')`);
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

    it('executes the 4-step safe NOT NULL pattern successfully', async () => {
      const checkName = 'chk_users_email_not_null';
      const ops: Operation[] = [
        {
          type: 'add_check_not_valid',
          phase: 6,
          objectName: 'users.email',
          sql: `ALTER TABLE "${testSchema}"."users" ADD CONSTRAINT "${checkName}" CHECK ("email" IS NOT NULL) NOT VALID`,
          destructive: false,
        },
        {
          type: 'validate_constraint',
          phase: 6,
          objectName: `users.${checkName}`,
          sql: `ALTER TABLE "${testSchema}"."users" VALIDATE CONSTRAINT "${checkName}"`,
          destructive: false,
        },
        {
          type: 'alter_column',
          phase: 6,
          objectName: 'users.email',
          sql: `ALTER TABLE "${testSchema}"."users" ALTER COLUMN "email" SET NOT NULL`,
          destructive: false,
        },
        {
          type: 'drop_check',
          phase: 6,
          objectName: `users.${checkName}`,
          sql: `ALTER TABLE "${testSchema}"."users" DROP CONSTRAINT "${checkName}"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(4);

      // Verify the column is now NOT NULL
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
          [testSchema],
        );
        expect(res.rows[0].is_nullable).toBe('NO');

        // Verify the temporary check constraint was dropped
        const constraints = await client.query(
          `SELECT conname FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = $1 AND conname = $2`,
          [testSchema, checkName],
        );
        expect(constraints.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  describe('safe unique constraint pattern', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY, "email" text NOT NULL, "tenant_id" uuid NOT NULL)`);
        await client.query(`INSERT INTO "${testSchema}"."users" (id, email, tenant_id) VALUES (gen_random_uuid(), 'a@b.com', gen_random_uuid())`);
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

    it('executes the 2-step safe unique constraint pattern successfully', async () => {
      const ucName = 'uq_users_email_tenant';
      const ops: Operation[] = [
        {
          type: 'add_index',
          phase: 7,
          objectName: ucName,
          sql: `CREATE UNIQUE INDEX CONCURRENTLY "${ucName}" ON "${testSchema}"."users" ("email", "tenant_id")`,
          destructive: false,
          concurrent: true,
        },
        {
          type: 'add_unique_constraint',
          phase: 8,
          objectName: `users.${ucName}`,
          sql: `ALTER TABLE "${testSchema}"."users" ADD CONSTRAINT "${ucName}" UNIQUE USING INDEX "${ucName}"`,
          destructive: false,
          concurrent: true,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify the unique constraint exists
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT conname, contype FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = $1 AND conname = $2`,
          [testSchema, ucName],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].contype).toBe('u'); // unique constraint

        // Verify uniqueness is enforced: inserting a duplicate should fail
        await expect(
          client.query(`INSERT INTO "${testSchema}"."users" (id, email, tenant_id) VALUES (gen_random_uuid(), 'a@b.com', (SELECT tenant_id FROM "${testSchema}"."users" LIMIT 1))`),
        ).rejects.toThrow(/unique/i);
      } finally {
        client.release();
      }
    });
  });

  describe('function and sequence grants', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        // Create a role for grant testing
        await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_grant_role') THEN CREATE ROLE test_grant_role NOLOGIN; END IF; END $$`);
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

    it('executes grant_function operation successfully', async () => {
      const ops: Operation[] = [
        {
          type: 'create_function',
          phase: 5,
          objectName: 'my_func',
          sql: `CREATE OR REPLACE FUNCTION "${testSchema}"."my_func"() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER`,
          destructive: false,
        },
        {
          type: 'grant_function',
          phase: 13,
          objectName: 'my_func.test_grant_role',
          sql: `GRANT EXECUTE ON FUNCTION "${testSchema}"."my_func"() TO "test_grant_role"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify the grant exists
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT has_function_privilege('test_grant_role', '"${testSchema}"."my_func"()', 'EXECUTE') AS has_priv`,
        );
        expect(res.rows[0].has_priv).toBe(true);
      } finally {
        client.release();
      }
    });

    it('executes grant_sequence operation successfully', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'items',
          sql: `CREATE TABLE "${testSchema}"."items" ("id" serial PRIMARY KEY, "name" text)`,
          destructive: false,
        },
        {
          type: 'grant_sequence',
          phase: 13,
          objectName: 'items_id_seq.test_grant_role',
          sql: `GRANT USAGE, SELECT ON SEQUENCE "${testSchema}"."items_id_seq" TO "test_grant_role"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify the sequence grant exists
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT has_sequence_privilege('test_grant_role', '"${testSchema}"."items_id_seq"', 'USAGE') AS has_priv`,
        );
        expect(res.rows[0].has_priv).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  describe('role membership', () => {
    const groupRole = `test_group_${Date.now()}`;
    const memberRole = `test_member_${Date.now()}`;

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`DROP ROLE IF EXISTS "${memberRole}"`);
        await client.query(`DROP ROLE IF EXISTS "${groupRole}"`);
      } finally {
        client.release();
      }
    });

    it('executes grant_membership operation successfully', async () => {
      const ops: Operation[] = [
        {
          type: 'create_role',
          phase: 4,
          objectName: groupRole,
          sql: `CREATE ROLE "${groupRole}" NOLOGIN`,
          destructive: false,
        },
        {
          type: 'create_role',
          phase: 4,
          objectName: memberRole,
          sql: `CREATE ROLE "${memberRole}" NOLOGIN`,
          destructive: false,
        },
        {
          type: 'grant_membership',
          phase: 4,
          objectName: `${memberRole}.${groupRole}`,
          sql: `GRANT "${groupRole}" TO "${memberRole}"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(3);

      // Verify the membership exists
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT 1 FROM pg_auth_members
           WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
             AND member = (SELECT oid FROM pg_roles WHERE rolname = $2)`,
          [groupRole, memberRole],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('executes alter_role with all attributes', async () => {
      const ops: Operation[] = [
        {
          type: 'create_role',
          phase: 4,
          objectName: memberRole,
          sql: `CREATE ROLE "${memberRole}" NOLOGIN`,
          destructive: false,
        },
        {
          type: 'alter_role',
          phase: 4,
          objectName: memberRole,
          sql: `ALTER ROLE "${memberRole}" LOGIN CREATEDB CONNECTION LIMIT 5`,
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
          `SELECT rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = $1`,
          [memberRole],
        );
        expect(res.rows[0].rolcanlogin).toBe(true);
        expect(res.rows[0].rolcreatedb).toBe(true);
        expect(res.rows[0].rolconnlimit).toBe(5);
      } finally {
        client.release();
      }
    });
  });

  describe('materialized view operations', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        // Create a source table for the materialized view
        await client.query(`CREATE TABLE "${testSchema}"."orders" ("id" serial PRIMARY KEY, "user_id" integer NOT NULL, "amount" numeric)`);
        await client.query(`INSERT INTO "${testSchema}"."orders" ("user_id", "amount") VALUES (1, 100), (1, 200), (2, 50)`);
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

    it('executes materialized view with grants, comment, and refresh', async () => {
      // Create the role first
      const grantRole = `mv_grant_role_${Date.now()}`;
      const pool = getPool(DATABASE_URL);
      let client = await pool.connect();
      try {
        await client.query(`CREATE ROLE "${grantRole}" NOLOGIN`);
      } finally {
        client.release();
      }

      const ops: Operation[] = [
        {
          type: 'create_materialized_view',
          phase: 10,
          objectName: 'user_stats',
          sql: `CREATE MATERIALIZED VIEW "${testSchema}"."user_stats" AS SELECT user_id, count(*) AS order_count FROM "${testSchema}"."orders" GROUP BY user_id`,
          destructive: false,
        },
        {
          type: 'refresh_materialized_view',
          phase: 10,
          objectName: 'user_stats',
          sql: `REFRESH MATERIALIZED VIEW "${testSchema}"."user_stats"`,
          destructive: false,
        },
        {
          type: 'grant_table',
          phase: 13,
          objectName: `user_stats.${grantRole}`,
          sql: `GRANT SELECT ON "${testSchema}"."user_stats" TO "${grantRole}"`,
          destructive: false,
        },
        {
          type: 'set_comment',
          phase: 14,
          objectName: 'user_stats',
          sql: `COMMENT ON MATERIALIZED VIEW "${testSchema}"."user_stats" IS 'Aggregated user order statistics'`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(4);

      // Verify materialized view exists and has data
      client = await pool.connect();
      try {
        const mvRes = await client.query(`SELECT * FROM "${testSchema}"."user_stats" ORDER BY user_id`);
        expect(mvRes.rows.length).toBe(2);
        expect(mvRes.rows[0].user_id).toBe(1);
        expect(Number(mvRes.rows[0].order_count)).toBe(2);

        // Verify grant
        const grantRes = await client.query(
          `SELECT has_table_privilege('${grantRole}', '"${testSchema}"."user_stats"', 'SELECT') AS has_priv`,
        );
        expect(grantRes.rows[0].has_priv).toBe(true);

        // Verify comment
        const commentRes = await client.query(
          `SELECT obj_description(c.oid) AS comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = 'user_stats' AND n.nspname = $1`,
          [testSchema],
        );
        expect(commentRes.rows[0].comment).toBe('Aggregated user order statistics');
      } finally {
        client.release();
        // Clean up the role
        const c2 = await pool.connect();
        try {
          await c2.query(`REVOKE ALL ON "${testSchema}"."user_stats" FROM "${grantRole}"`);
          await c2.query(`DROP ROLE IF EXISTS "${grantRole}"`);
        } finally {
          c2.release();
        }
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
