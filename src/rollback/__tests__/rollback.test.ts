import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import {
  ensureSnapshotsTable,
  saveSnapshot,
  getLatestSnapshot,
  listSnapshots,
  computeRollback,
  runDown,
} from '../index.js';
import type { Operation } from '../../planner/index.js';
import { closePool, getPool } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `rb_test_${Date.now()}_${schemaCount++}`;
}

describe('Rollback', () => {
  afterAll(async () => {
    await closePool();
  });

  describe('ensureSnapshotsTable', () => {
    it('should create _simplicity.snapshots table', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureSnapshotsTable(client);

        const res = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '_simplicity' AND table_name = 'snapshots'`,
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('should be idempotent', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureSnapshotsTable(client);
        await ensureSnapshotsTable(client);
        // No error means idempotent
      } finally {
        client.release();
      }
    });
  });

  describe('saveSnapshot / getLatestSnapshot', () => {
    beforeEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureSnapshotsTable(client);
        await client.query('DELETE FROM _simplicity.snapshots');
      } finally {
        client.release();
      }
    });

    it('should save and retrieve a snapshot', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops: Operation[] = [
          {
            type: 'create_table',
            phase: 6,
            objectName: 'users',
            sql: 'CREATE TABLE "public"."users" ("id" uuid PRIMARY KEY)',
            destructive: false,
          },
        ];

        await saveSnapshot(client, ops, 'public');
        const snapshot = await getLatestSnapshot(client);

        expect(snapshot).not.toBeNull();
        expect(snapshot!.operations).toHaveLength(1);
        expect(snapshot!.operations[0].type).toBe('create_table');
        expect(snapshot!.operations[0].objectName).toBe('users');
        expect(snapshot!.pgSchema).toBe('public');
        expect(snapshot!.id).toBeGreaterThan(0);
        expect(snapshot!.createdAt).toBeInstanceOf(Date);
      } finally {
        client.release();
      }
    });

    it('should return null when no snapshots exist', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const snapshot = await getLatestSnapshot(client);
        expect(snapshot).toBeNull();
      } finally {
        client.release();
      }
    });

    it('should return the most recent snapshot', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops1: Operation[] = [
          { type: 'create_table', phase: 6, objectName: 'first', sql: 'SELECT 1', destructive: false },
        ];
        const ops2: Operation[] = [
          { type: 'create_table', phase: 6, objectName: 'second', sql: 'SELECT 2', destructive: false },
        ];

        await saveSnapshot(client, ops1, 'public');
        await saveSnapshot(client, ops2, 'public');
        const snapshot = await getLatestSnapshot(client);

        expect(snapshot!.operations[0].objectName).toBe('second');
      } finally {
        client.release();
      }
    });
  });

  describe('listSnapshots', () => {
    beforeEach(async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureSnapshotsTable(client);
        await client.query('DELETE FROM _simplicity.snapshots');
      } finally {
        client.release();
      }
    });

    it('should list all snapshots in reverse chronological order', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await saveSnapshot(
          client,
          [{ type: 'create_table', phase: 6, objectName: 'first', sql: 'S1', destructive: false }],
          'public',
        );
        await saveSnapshot(
          client,
          [{ type: 'create_table', phase: 6, objectName: 'second', sql: 'S2', destructive: false }],
          'public',
        );

        const list = await listSnapshots(client);
        expect(list).toHaveLength(2);
        expect(list[0].operations[0].objectName).toBe('second');
        expect(list[1].operations[0].objectName).toBe('first');
      } finally {
        client.release();
      }
    });
  });

  describe('computeRollback', () => {
    it('should reverse create_table to DROP TABLE', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'create_table', phase: 6, objectName: 'users', sql: 'CREATE TABLE ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP TABLE IF EXISTS "public"."users"');
      expect(result.operations[0].type).toBe('drop_table');
      expect(result.operations[0].destructive).toBe(true);
    });

    it('should reverse add_column to ALTER TABLE DROP COLUMN', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'add_column', phase: 6, objectName: 'users.email', sql: 'ALTER TABLE ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "email"');
      expect(result.operations[0].type).toBe('drop_column');
    });

    it('should reverse create_enum to DROP TYPE', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'create_enum', phase: 3, objectName: 'status', sql: 'CREATE TYPE ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP TYPE IF EXISTS "public"."status"');
    });

    it('should reverse add_index to DROP INDEX', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'add_index', phase: 7, objectName: 'idx_users_email', sql: 'CREATE INDEX ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP INDEX IF EXISTS "public"."idx_users_email"');
      expect(result.operations[0].type).toBe('drop_index');
    });

    it('should reverse create_function to DROP FUNCTION', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'create_function',
            phase: 5,
            objectName: 'update_timestamp',
            sql: 'CREATE FUNCTION ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP FUNCTION IF EXISTS "public"."update_timestamp"');
    });

    it('should reverse create_view to DROP VIEW', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'create_view', phase: 9, objectName: 'active_users', sql: 'CREATE VIEW ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP VIEW IF EXISTS "public"."active_users"');
    });

    it('should reverse create_materialized_view to DROP MATERIALIZED VIEW', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'create_materialized_view',
            phase: 10,
            objectName: 'user_stats',
            sql: 'CREATE MATERIALIZED VIEW ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP MATERIALIZED VIEW IF EXISTS "public"."user_stats"');
    });

    it('should reverse create_trigger to DROP TRIGGER', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'create_trigger',
            phase: 11,
            objectName: 'users.set_updated_at',
            sql: 'CREATE TRIGGER ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP TRIGGER IF EXISTS "set_updated_at" ON "public"."users"');
    });

    it('should reverse enable_rls to DISABLE ROW LEVEL SECURITY', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'enable_rls', phase: 12, objectName: 'users', sql: 'ALTER TABLE ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('ALTER TABLE "public"."users" DISABLE ROW LEVEL SECURITY');
    });

    it('should reverse create_policy to DROP POLICY', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'create_policy',
            phase: 12,
            objectName: 'users.users_own_data',
            sql: 'CREATE POLICY ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP POLICY IF EXISTS "users_own_data" ON "public"."users"');
    });

    it('should reverse create_extension to DROP EXTENSION', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'create_extension',
            phase: 2,
            objectName: 'pgcrypto',
            sql: 'CREATE EXTENSION ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP EXTENSION IF EXISTS "pgcrypto"');
    });

    it('should reverse create_role to DROP ROLE', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'create_role', phase: 4, objectName: 'app_readonly', sql: 'CREATE ROLE ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('DROP ROLE IF EXISTS "app_readonly"');
    });

    it('should reverse add_foreign_key to DROP CONSTRAINT', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'add_foreign_key',
            phase: 8,
            objectName: 'orders.fk_orders_user_id',
            sql: 'ALTER TABLE ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe(
        'ALTER TABLE "public"."orders" DROP CONSTRAINT IF EXISTS "fk_orders_user_id"',
      );
    });

    it('should reverse add_foreign_key_not_valid to DROP CONSTRAINT', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'add_foreign_key_not_valid',
            phase: 8,
            objectName: 'orders.fk_orders_user_id',
            sql: 'ALTER TABLE ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe(
        'ALTER TABLE "public"."orders" DROP CONSTRAINT IF EXISTS "fk_orders_user_id"',
      );
    });

    it('should reverse add_check to DROP CONSTRAINT', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'add_check',
            phase: 6,
            objectName: 'users.email_not_empty',
            sql: 'ALTER TABLE ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS "email_not_empty"');
    });

    it('should reverse add_unique_constraint to DROP CONSTRAINT', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'add_unique_constraint',
            phase: 6,
            objectName: 'users.uq_email',
            sql: 'ALTER TABLE ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS "uq_email"');
    });

    it('should reverse grant_table to REVOKE', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          {
            type: 'grant_table',
            phase: 13,
            objectName: 'users.app_readonly',
            sql: 'GRANT SELECT ON "public"."users" TO "app_readonly"',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].sql).toBe('REVOKE ALL ON "public"."users" FROM "app_readonly"');
      expect(result.operations[0].type).toBe('revoke_table');
    });

    it('should skip irreversible operations', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'add_enum_value', phase: 3, objectName: 'status', sql: 'ALTER TYPE ...', destructive: false },
          { type: 'alter_column', phase: 6, objectName: 'users.email', sql: 'ALTER TABLE ...', destructive: false },
          { type: 'add_seed', phase: 15, objectName: 'users', sql: 'INSERT INTO ...', destructive: false },
          {
            type: 'validate_constraint',
            phase: 8,
            objectName: 'orders.fk',
            sql: 'ALTER TABLE ...',
            destructive: false,
          },
          { type: 'set_comment', phase: 14, objectName: 'users', sql: 'COMMENT ON ...', destructive: false },
          {
            type: 'refresh_materialized_view',
            phase: 10,
            objectName: 'user_stats',
            sql: 'REFRESH ...',
            destructive: false,
          },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThan(0);
    });

    it('should reverse operations in reverse order', () => {
      const result = computeRollback({
        id: 1,
        operations: [
          { type: 'create_table', phase: 6, objectName: 'users', sql: 'CREATE TABLE ...', destructive: false },
          { type: 'add_column', phase: 6, objectName: 'users.email', sql: 'ALTER TABLE ...', destructive: false },
          { type: 'add_index', phase: 7, objectName: 'idx_users_email', sql: 'CREATE INDEX ...', destructive: false },
        ],
        pgSchema: 'public',
        createdAt: new Date(),
      });

      expect(result.operations).toHaveLength(3);
      // Reversed: index dropped first, then column, then table
      expect(result.operations[0].type).toBe('drop_index');
      expect(result.operations[1].type).toBe('drop_column');
      expect(result.operations[2].type).toBe('drop_table');
    });
  });

  describe('runDown (integration)', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
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
      } finally {
        client.release();
      }
    });

    it('should rollback a created table', async () => {
      const pool = getPool(DATABASE_URL);

      // First, create a table
      const client = await pool.connect();
      try {
        await client.query(`CREATE TABLE "${testSchema}"."rollback_test" ("id" uuid PRIMARY KEY)`);

        // Save a snapshot of the create_table operation
        await saveSnapshot(
          client,
          [
            {
              type: 'create_table',
              phase: 6,
              objectName: 'rollback_test',
              sql: `CREATE TABLE "${testSchema}"."rollback_test" ("id" uuid PRIMARY KEY)`,
              destructive: false,
            },
          ],
          testSchema,
        );
      } finally {
        client.release();
      }

      // Verify table exists
      const client2 = await pool.connect();
      try {
        const res = await client2.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rollback_test'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client2.release();
      }

      // Run rollback
      const result = await runDown(DATABASE_URL, { logger });

      expect(result.executed).toBeGreaterThan(0);

      // Verify table is dropped
      const client3 = await pool.connect();
      try {
        const res = await client3.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rollback_test'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client3.release();
      }
    });

    it('should rollback multiple operations in correct order', async () => {
      const pool = getPool(DATABASE_URL);

      // Create table and add column
      const client = await pool.connect();
      try {
        await client.query(`CREATE TABLE "${testSchema}"."multi_rb" ("id" uuid PRIMARY KEY)`);
        await client.query(`ALTER TABLE "${testSchema}"."multi_rb" ADD COLUMN "name" text`);

        await saveSnapshot(
          client,
          [
            {
              type: 'create_table',
              phase: 6,
              objectName: 'multi_rb',
              sql: `CREATE TABLE "${testSchema}"."multi_rb" ("id" uuid PRIMARY KEY)`,
              destructive: false,
            },
            {
              type: 'add_column',
              phase: 6,
              objectName: 'multi_rb.name',
              sql: `ALTER TABLE "${testSchema}"."multi_rb" ADD COLUMN "name" text`,
              destructive: false,
            },
          ],
          testSchema,
        );
      } finally {
        client.release();
      }

      const result = await runDown(DATABASE_URL, { logger });
      expect(result.executed).toBe(2);

      // Table should be gone (column dropped first, then table)
      const client2 = await pool.connect();
      try {
        const res = await client2.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'multi_rb'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(0);
      } finally {
        client2.release();
      }
    });

    it('should throw when no snapshots exist', async () => {
      await expect(runDown(DATABASE_URL, { logger })).rejects.toThrow('No migration snapshot found');
    });

    it('should delete the snapshot after successful rollback', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE TABLE "${testSchema}"."del_snap" ("id" integer)`);
        await saveSnapshot(
          client,
          [
            {
              type: 'create_table',
              phase: 6,
              objectName: 'del_snap',
              sql: `CREATE TABLE "${testSchema}"."del_snap" ("id" integer)`,
              destructive: false,
            },
          ],
          testSchema,
        );
      } finally {
        client.release();
      }

      await runDown(DATABASE_URL, { logger });

      // Snapshot should be removed
      const client2 = await pool.connect();
      try {
        const snapshot = await getLatestSnapshot(client2);
        expect(snapshot).toBeNull();
      } finally {
        client2.release();
      }
    });
  });
});
