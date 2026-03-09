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

  describe('schema grants', () => {
    const schemaGrantRole = `test_schema_grant_${Date.now()}`;

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`REVOKE ALL ON SCHEMA public FROM "${schemaGrantRole}"`).catch(() => {});
        await client.query(`DROP ROLE IF EXISTS "${schemaGrantRole}"`);
      } finally {
        client.release();
      }
    });

    it('executes grant_schema operation successfully', async () => {
      const ops: Operation[] = [
        {
          type: 'create_role',
          phase: 4,
          objectName: schemaGrantRole,
          sql: `CREATE ROLE "${schemaGrantRole}" NOLOGIN`,
          destructive: false,
        },
        {
          type: 'grant_schema',
          phase: 13,
          objectName: `public.${schemaGrantRole}`,
          sql: `GRANT USAGE ON SCHEMA "public" TO "${schemaGrantRole}"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify the schema usage grant exists
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT has_schema_privilege('${schemaGrantRole}', 'public', 'USAGE') AS has_priv`,
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

    it('creates role with all attributes', async () => {
      const ops: Operation[] = [
        {
          type: 'create_role',
          phase: 4,
          objectName: memberRole,
          sql: `CREATE ROLE "${memberRole}" LOGIN CREATEDB CREATEROLE NOINHERIT BYPASSRLS REPLICATION CONNECTION LIMIT 3`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(1);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT rolcanlogin, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolreplication, rolconnlimit
           FROM pg_roles WHERE rolname = $1`,
          [memberRole],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].rolcanlogin).toBe(true);
        expect(res.rows[0].rolcreatedb).toBe(true);
        expect(res.rows[0].rolcreaterole).toBe(true);
        expect(res.rows[0].rolinherit).toBe(false);
        expect(res.rows[0].rolbypassrls).toBe(true);
        expect(res.rows[0].rolreplication).toBe(true);
        expect(res.rows[0].rolconnlimit).toBe(3);
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

    it('should create index with gin method', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'gin_table',
          sql: `CREATE TABLE "${testSchema}"."gin_table" ("id" uuid PRIMARY KEY, "tags" text[] NOT NULL)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_gin_table_tags',
          sql: `CREATE INDEX CONCURRENTLY "idx_gin_table_tags" ON "${testSchema}"."gin_table" USING gin ("tags")`,
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

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_gin_table_tags'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].indexdef).toContain('USING gin');
      } finally {
        client.release();
      }
    });

    it('should create partial index with WHERE clause', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'partial_idx_table',
          sql: `CREATE TABLE "${testSchema}"."partial_idx_table" ("id" uuid PRIMARY KEY, "email" text NOT NULL, "active" boolean NOT NULL DEFAULT true)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_partial_email',
          sql: `CREATE INDEX CONCURRENTLY "idx_partial_email" ON "${testSchema}"."partial_idx_table" USING btree ("email") WHERE active = true`,
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

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_partial_email'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].indexdef).toContain('WHERE');
        expect(res.rows[0].indexdef).toContain('active');
      } finally {
        client.release();
      }
    });

    it('should create covering index with INCLUDE', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'cover_idx_table',
          sql: `CREATE TABLE "${testSchema}"."cover_idx_table" ("id" uuid PRIMARY KEY, "email" text NOT NULL, "name" text)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_cover_email',
          sql: `CREATE INDEX CONCURRENTLY "idx_cover_email" ON "${testSchema}"."cover_idx_table" USING btree ("email") INCLUDE ("name")`,
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

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_cover_email'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].indexdef).toContain('INCLUDE');
        expect(res.rows[0].indexdef).toContain('name');
      } finally {
        client.release();
      }
    });

    it('should create index with opclass', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'opclass_table',
          sql: `CREATE TABLE "${testSchema}"."opclass_table" ("id" uuid PRIMARY KEY, "email" text NOT NULL)`,
          destructive: false,
        },
        {
          type: 'add_index',
          phase: 7,
          objectName: 'idx_opclass_email',
          sql: `CREATE INDEX CONCURRENTLY "idx_opclass_email" ON "${testSchema}"."opclass_table" USING btree ("email" text_pattern_ops)`,
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

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_opclass_email'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].indexdef).toContain('text_pattern_ops');
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

  describe('auto snapshot capture', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        // Ensure snapshots table exists and is clean
        const { ensureSnapshotsTable } = await import('../../rollback/index.js');
        await ensureSnapshotsTable(client);
        await client.query('DELETE FROM _simplicity.snapshots');
      } finally {
        client.release();
      }
    });

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        await client.query('DELETE FROM _simplicity.snapshots');
      } finally {
        client.release();
      }
    });

    it('should auto-save a snapshot before executing operations', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'snapshot_test',
          sql: `CREATE TABLE "${testSchema}"."snapshot_test" ("id" uuid PRIMARY KEY)`,
          destructive: false,
        },
      ];

      await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        pgSchema: testSchema,
        logger,
      });

      // Verify a snapshot was auto-saved
      const { getLatestSnapshot } = await import('../../rollback/index.js');
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const snapshot = await getLatestSnapshot(client);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.operations).toHaveLength(1);
        expect(snapshot!.operations[0].type).toBe('create_table');
        expect(snapshot!.operations[0].objectName).toBe('snapshot_test');
        expect(snapshot!.pgSchema).toBe(testSchema);
      } finally {
        client.release();
      }
    });

    it('should not save a snapshot in dry-run mode', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'dry_run_snap',
          sql: `CREATE TABLE "${testSchema}"."dry_run_snap" ("id" integer)`,
          destructive: false,
        },
      ];

      await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        pgSchema: testSchema,
        dryRun: true,
        logger,
      });

      const { getLatestSnapshot } = await import('../../rollback/index.js');
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const snapshot = await getLatestSnapshot(client);
        expect(snapshot).toBeNull();
      } finally {
        client.release();
      }
    });

    it('should not save a snapshot when there are no operations', async () => {
      await execute({
        connectionString: DATABASE_URL,
        operations: [],
        pgSchema: testSchema,
        logger,
      });

      const { getLatestSnapshot } = await import('../../rollback/index.js');
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const snapshot = await getLatestSnapshot(client);
        expect(snapshot).toBeNull();
      } finally {
        client.release();
      }
    });

    it('should allow runDown to rollback using the auto-captured snapshot', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'rollback_auto',
          sql: `CREATE TABLE "${testSchema}"."rollback_auto" ("id" uuid PRIMARY KEY, "name" text)`,
          destructive: false,
        },
      ];

      // Run migration — should auto-capture snapshot
      await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        pgSchema: testSchema,
        logger,
      });

      // Verify table exists
      const pool = getPool(DATABASE_URL);
      let client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rollback_auto'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }

      // Run down — should use auto-captured snapshot
      const { runDown } = await import('../../rollback/index.js');
      const result = await runDown(DATABASE_URL, { logger });
      expect(result.executed).toBeGreaterThan(0);

      // Verify table is gone
      client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rollback_auto'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  describe('precheck execution', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}"."users" ("id" serial PRIMARY KEY, "email" text NOT NULL)`);
        await client.query(`INSERT INTO "${testSchema}"."users" (email) VALUES ('a@b.com'), ('c@d.com')`);
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

    it('should pass when precheck query returns truthy value', async () => {
      const ops: Operation[] = [
        {
          type: 'run_precheck',
          phase: 0,
          objectName: 'users.check_has_rows',
          sql: `SELECT count(*) > 0 FROM "${testSchema}"."users"`,
          destructive: false,
          precheckMessage: 'No users exist',
        },
        {
          type: 'add_column',
          phase: 6,
          objectName: 'users.status',
          sql: `ALTER TABLE "${testSchema}"."users" ADD COLUMN "status" text DEFAULT 'active'`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      // Precheck + add_column both executed
      expect(result.executed).toBe(2);

      // Verify column was added
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'status'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('should abort migration when precheck query returns falsy value', async () => {
      const ops: Operation[] = [
        {
          type: 'run_precheck',
          phase: 0,
          objectName: 'users.no_orphans',
          sql: `SELECT count(*) = 0 FROM "${testSchema}"."users" WHERE email = 'a@b.com'`,
          destructive: false,
          precheckMessage: 'Orphaned rows exist — clean up before migration',
        },
        {
          type: 'add_column',
          phase: 6,
          objectName: 'users.new_col',
          sql: `ALTER TABLE "${testSchema}"."users" ADD COLUMN "new_col" text`,
          destructive: false,
        },
      ];

      await expect(
        execute({ connectionString: DATABASE_URL, operations: ops, logger }),
      ).rejects.toThrow('Precheck failed: Orphaned rows exist — clean up before migration');

      // The add_column should NOT have been applied
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'new_col'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should abort when precheck returns null', async () => {
      const ops: Operation[] = [
        {
          type: 'run_precheck',
          phase: 0,
          objectName: 'users.null_check',
          sql: `SELECT null::boolean`,
          destructive: false,
          precheckMessage: 'Check returned null',
        },
      ];

      await expect(
        execute({ connectionString: DATABASE_URL, operations: ops, logger }),
      ).rejects.toThrow('Precheck failed: Check returned null');
    });

    it('should pass multiple prechecks when all return truthy', async () => {
      const ops: Operation[] = [
        {
          type: 'run_precheck',
          phase: 0,
          objectName: 'users.check1',
          sql: `SELECT count(*) > 0 FROM "${testSchema}"."users"`,
          destructive: false,
          precheckMessage: 'Check 1 failed',
        },
        {
          type: 'run_precheck',
          phase: 0,
          objectName: 'users.check2',
          sql: `SELECT true`,
          destructive: false,
          precheckMessage: 'Check 2 failed',
        },
        {
          type: 'create_table',
          phase: 6,
          objectName: 'orders',
          sql: `CREATE TABLE "${testSchema}"."orders" ("id" serial PRIMARY KEY)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(3);
    });

    it('should create a table with a generated column', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'line_items',
          sql: `CREATE TABLE "${testSchema}"."line_items" (
  "id" serial PRIMARY KEY,
  "price" numeric NOT NULL,
  "quantity" integer NOT NULL,
  "total" numeric GENERATED ALWAYS AS (price * quantity) STORED
)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });
      expect(result.executed).toBe(1);

      // Insert data and verify generated column computes correctly
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`INSERT INTO "${testSchema}"."line_items" (price, quantity) VALUES (10.50, 3)`);
        const res = await client.query(`SELECT total FROM "${testSchema}"."line_items" WHERE id = 1`);
        expect(Number(res.rows[0].total)).toBe(31.5);
      } finally {
        client.release();
      }
    });

    it('should execute column-level grant operations', async () => {
      // Create a role for testing
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      const roleName = `col_grant_role_${Date.now()}`;
      try {
        await client.query(`CREATE ROLE "${roleName}"`);
      } finally {
        client.release();
      }

      try {
        // Create table first
        const createOps: Operation[] = [
          {
            type: 'create_table',
            phase: 6,
            objectName: 'accounts',
            sql: `CREATE TABLE "${testSchema}"."accounts" ("id" uuid PRIMARY KEY, "email" text NOT NULL, "secret" text)`,
            destructive: false,
          },
        ];

        await execute({
          connectionString: DATABASE_URL,
          operations: createOps,
          pgSchema: testSchema,
          logger,
        });

        // Now grant column-level SELECT on id and email only
        const grantOps: Operation[] = [
          {
            type: 'grant_column',
            phase: 13,
            objectName: `accounts.${roleName}`,
            sql: `GRANT SELECT ("id", "email") ON "${testSchema}"."accounts" TO "${roleName}"`,
            destructive: false,
          },
        ];

        const result = await execute({
          connectionString: DATABASE_URL,
          operations: grantOps,
          pgSchema: testSchema,
          logger,
        });
        expect(result.executed).toBe(1);

        // Verify the grant exists by querying column_privileges
        const verifyClient = await pool.connect();
        try {
          const res = await verifyClient.query(
            `SELECT column_name FROM information_schema.column_privileges
             WHERE table_schema = $1 AND table_name = 'accounts'
             AND grantee = $2 AND privilege_type = 'SELECT'
             ORDER BY column_name`,
            [testSchema, roleName],
          );
          expect(res.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['email', 'id']);
        } finally {
          verifyClient.release();
        }
      } finally {
        const cleanClient = await pool.connect();
        try {
          await cleanClient.query(`REVOKE ALL ON "${testSchema}"."accounts" FROM "${roleName}"`).catch(() => {});
          await cleanClient.query(`DROP ROLE IF EXISTS "${roleName}"`);
        } finally {
          cleanClient.release();
        }
      }
    });
  });

  describe('composite primary keys', () => {
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

    it('should create a table with a composite primary key and enforce it', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'order_items',
          sql: `CREATE TABLE "${testSchema}"."order_items" (
  "order_id" uuid,
  "product_id" uuid,
  "quantity" integer NOT NULL,
  PRIMARY KEY ("order_id", "product_id")
)`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
        pgSchema: testSchema,
      });
      expect(result.executed).toBe(1);

      // Verify composite PK exists and enforces uniqueness
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        // Insert a row
        await client.query(
          `INSERT INTO "${testSchema}"."order_items" (order_id, product_id, quantity) VALUES ($1, $2, 1)`,
          ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
        );
        // Same PK should fail
        await expect(
          client.query(
            `INSERT INTO "${testSchema}"."order_items" (order_id, product_id, quantity) VALUES ($1, $2, 2)`,
            ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
          ),
        ).rejects.toThrow(/duplicate key|unique constraint/);
        // Different combination should succeed
        await client.query(
          `INSERT INTO "${testSchema}"."order_items" (order_id, product_id, quantity) VALUES ($1, $2, 3)`,
          ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003'],
        );
        const res = await client.query(`SELECT count(*) FROM "${testSchema}"."order_items"`);
        expect(Number(res.rows[0].count)).toBe(2);
      } finally {
        client.release();
      }
    });
  });

  describe('seed upsert execution', () => {
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

    it('should insert seed data into a new table', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'statuses',
          sql: `CREATE TABLE "${testSchema}"."statuses" ("id" integer PRIMARY KEY, "name" text NOT NULL)`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'statuses',
          sql: `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (1, 'active') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'statuses',
          sql: `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (2, 'inactive') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(3);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT id, name FROM "${testSchema}"."statuses" ORDER BY id`,
        );
        expect(res.rows).toHaveLength(2);
        expect(res.rows[0]).toEqual({ id: 1, name: 'active' });
        expect(res.rows[1]).toEqual({ id: 2, name: 'inactive' });
      } finally {
        client.release();
      }
    });

    it('should upsert seed data — update on conflict', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        // Create table and insert initial data
        await client.query(
          `CREATE TABLE "${testSchema}"."statuses" ("id" integer PRIMARY KEY, "name" text NOT NULL)`,
        );
        await client.query(
          `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (1, 'old_name'), (2, 'old_inactive')`,
        );
      } finally {
        client.release();
      }

      // Run seed upsert — should update existing rows
      const ops: Operation[] = [
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'statuses',
          sql: `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (1, 'active') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'statuses',
          sql: `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (2, 'inactive') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'statuses',
          sql: `INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (3, 'pending') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(3);

      const client2 = pool.connect();
      const c = await client2;
      try {
        const res = await c.query(
          `SELECT id, name FROM "${testSchema}"."statuses" ORDER BY id`,
        );
        expect(res.rows).toHaveLength(3);
        expect(res.rows[0]).toEqual({ id: 1, name: 'active' });
        expect(res.rows[1]).toEqual({ id: 2, name: 'inactive' });
        expect(res.rows[2]).toEqual({ id: 3, name: 'pending' });
      } finally {
        c.release();
      }
    });

    it('should handle seeds with uuid primary keys', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: `CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY, "email" text NOT NULL, "name" text)`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'users',
          sql: `INSERT INTO "${testSchema}"."users" ("id", "email", "name") VALUES ('00000000-0000-0000-0000-000000000001', 'admin@example.com', 'Admin') ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name"`,
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
          `SELECT id, email, name FROM "${testSchema}"."users"`,
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].email).toBe('admin@example.com');
        expect(res.rows[0].name).toBe('Admin');
      } finally {
        client.release();
      }
    });

    it('should handle seeds with null values and booleans', async () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'settings',
          sql: `CREATE TABLE "${testSchema}"."settings" ("key" text PRIMARY KEY, "value" text, "enabled" boolean NOT NULL DEFAULT true)`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'settings',
          sql: `INSERT INTO "${testSchema}"."settings" ("key", "value", "enabled") VALUES ('maintenance', NULL, FALSE) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "enabled" = EXCLUDED."enabled"`,
          destructive: false,
        },
        {
          type: 'add_seed',
          phase: 15,
          objectName: 'settings',
          sql: `INSERT INTO "${testSchema}"."settings" ("key", "value", "enabled") VALUES ('notifications', 'email', TRUE) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "enabled" = EXCLUDED."enabled"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(3);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT key, value, enabled FROM "${testSchema}"."settings" ORDER BY key`,
        );
        expect(res.rows).toHaveLength(2);
        expect(res.rows[0]).toEqual({ key: 'maintenance', value: null, enabled: false });
        expect(res.rows[1]).toEqual({ key: 'notifications', value: 'email', enabled: true });
      } finally {
        client.release();
      }
    });
  });

  describe('foreign key options', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}"."users" (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
        await client.query(`CREATE TABLE "${testSchema}"."orders" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid)`);
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

    it('executes FK with ON DELETE CASCADE and ON UPDATE SET NULL', async () => {
      const ops: Operation[] = [
        {
          type: 'add_foreign_key_not_valid',
          phase: 8,
          objectName: 'orders.user_id',
          sql: `ALTER TABLE "${testSchema}"."orders" ADD CONSTRAINT "fk_orders_user_id_users" FOREIGN KEY ("user_id") REFERENCES "${testSchema}"."users" ("id") ON DELETE CASCADE ON UPDATE SET NULL NOT VALID`,
          destructive: false,
        },
        {
          type: 'validate_constraint',
          phase: 8,
          objectName: 'orders.fk_orders_user_id_users',
          sql: `ALTER TABLE "${testSchema}"."orders" VALIDATE CONSTRAINT "fk_orders_user_id_users"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify FK options via pg_constraint
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT confdeltype, confupdtype FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = $1 AND c.conname = $2 AND c.contype = 'f'`,
          [testSchema, 'fk_orders_user_id_users'],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].confdeltype).toBe('c'); // CASCADE
        expect(res.rows[0].confupdtype).toBe('n'); // SET NULL
      } finally {
        client.release();
      }
    });

    it('executes FK with DEFERRABLE INITIALLY DEFERRED', async () => {
      const ops: Operation[] = [
        {
          type: 'add_foreign_key_not_valid',
          phase: 8,
          objectName: 'orders.user_id',
          sql: `ALTER TABLE "${testSchema}"."orders" ADD CONSTRAINT "fk_orders_user_id_users" FOREIGN KEY ("user_id") REFERENCES "${testSchema}"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID`,
          destructive: false,
        },
        {
          type: 'validate_constraint',
          phase: 8,
          objectName: 'orders.fk_orders_user_id_users',
          sql: `ALTER TABLE "${testSchema}"."orders" VALIDATE CONSTRAINT "fk_orders_user_id_users"`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
      });

      expect(result.executed).toBe(2);

      // Verify deferrable flags via pg_constraint
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT condeferrable, condeferred FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = $1 AND c.conname = $2 AND c.contype = 'f'`,
          [testSchema, 'fk_orders_user_id_users'],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].condeferrable).toBe(true);
        expect(res.rows[0].condeferred).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  describe('function options', () => {
    const testSchema = `exec_fn_opts_${Date.now()}`;

    beforeEach(async () => {
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

    it('creates function with all options (parallel, strict, leakproof, cost, set)', async () => {
      const ops: Operation[] = [
        {
          type: 'create_function',
          phase: 5,
          objectName: 'full_opts_func',
          sql: `CREATE OR REPLACE FUNCTION "${testSchema}"."full_opts_func"(x integer) RETURNS integer AS $$ SELECT x * 2 $$ LANGUAGE sql IMMUTABLE SECURITY DEFINER PARALLEL SAFE STRICT LEAKPROOF COST 200 SET search_path = public`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
        pgSchema: testSchema,
      });
      expect(result.executed).toBe(1);

      // Verify function attributes from pg_proc
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT p.provolatile, p.proparallel, p.proisstrict, p.proleakproof,
                  p.procost, p.prosecdef, p.proconfig
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.proname = 'full_opts_func'`,
          [testSchema],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].provolatile).toBe('i'); // immutable
        expect(res.rows[0].proparallel).toBe('s'); // safe
        expect(res.rows[0].proisstrict).toBe(true);
        expect(res.rows[0].proleakproof).toBe(true);
        expect(res.rows[0].procost).toBe(200);
        expect(res.rows[0].prosecdef).toBe(true);
        expect(res.rows[0].proconfig).toEqual(['search_path=public']);
      } finally {
        client.release();
      }
    });

    it('creates function with ROWS for set-returning function', async () => {
      const ops: Operation[] = [
        {
          type: 'create_function',
          phase: 5,
          objectName: 'set_func',
          sql: `CREATE OR REPLACE FUNCTION "${testSchema}"."set_func"() RETURNS SETOF integer AS $$ SELECT generate_series(1, 10) $$ LANGUAGE sql VOLATILE SECURITY INVOKER ROWS 10`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
        pgSchema: testSchema,
      });
      expect(result.executed).toBe(1);

      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT p.prorows FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.proname = 'set_func'`,
          [testSchema],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].prorows).toBe(10);
      } finally {
        client.release();
      }
    });
  });

  // ─── Trigger for_each and when clause (T-042) ──────────────────

  describe('trigger for_each and when clause', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}".orders (id uuid PRIMARY KEY, total numeric DEFAULT 0)`);
        await client.query(`
          CREATE OR REPLACE FUNCTION "${testSchema}".log_truncate() RETURNS trigger AS $$
          BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION "${testSchema}".update_timestamp() RETURNS trigger AS $$
          BEGIN NEW.total := NEW.total; RETURN NEW; END; $$ LANGUAGE plpgsql
        `);
      } finally {
        client.release();
      }
    });

    afterEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA "${testSchema}" CASCADE`);
      } finally {
        client.release();
      }
    });

    it('creates trigger with FOR EACH STATEMENT', async () => {
      const ops: Operation[] = [
        {
          type: 'create_trigger',
          phase: 11,
          objectName: 'orders.trg_truncate_log',
          sql: `CREATE TRIGGER "trg_truncate_log" AFTER TRUNCATE ON "${testSchema}"."orders" FOR EACH STATEMENT EXECUTE FUNCTION "${testSchema}".log_truncate()`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
        pgSchema: testSchema,
      });
      expect(result.executed).toBe(1);

      // Verify trigger exists with correct for_each
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT t.tgname,
                  CASE WHEN (t.tgtype & 1) != 0 THEN 'ROW' ELSE 'STATEMENT' END AS for_each
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class cls ON cls.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
           WHERE cls.relname = 'orders' AND ns.nspname = $1 AND t.tgname = 'trg_truncate_log'`,
          [testSchema],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].for_each).toBe('STATEMENT');
      } finally {
        client.release();
      }
    });

    it('creates trigger with WHEN clause', async () => {
      const ops: Operation[] = [
        {
          type: 'create_trigger',
          phase: 11,
          objectName: 'orders.trg_update_check',
          sql: `CREATE TRIGGER "trg_update_check" BEFORE UPDATE ON "${testSchema}"."orders" FOR EACH ROW WHEN (OLD.total IS DISTINCT FROM NEW.total) EXECUTE FUNCTION "${testSchema}".update_timestamp()`,
          destructive: false,
        },
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        logger,
        pgSchema: testSchema,
      });
      expect(result.executed).toBe(1);

      // Verify trigger exists with when clause
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT t.tgname,
                  t.tgqual IS NOT NULL AS has_when
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class cls ON cls.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
           WHERE cls.relname = 'orders' AND ns.nspname = $1 AND t.tgname = 'trg_update_check'`,
          [testSchema],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].has_when).toBe(true);
      } finally {
        client.release();
      }
    });
  });
});
