import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  ensureHistoryTable,
  getHistory,
  getFileHash,
  recordFile,
  fileNeedsApply,
  removeFileHistory,
} from '../tracker.js';
import { getPool, closePool } from '../db.js';
import type { Logger } from '../logger.js';

const DATABASE_URL = process.env.DATABASE_URL!;

describe('tracker', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  beforeAll(async () => {
    pool = getPool(DATABASE_URL);
  });

  beforeEach(async () => {
    client = await pool.connect();
    // Clean state for each test
    await client.query('DROP SCHEMA IF EXISTS _smplcty_schema_flow CASCADE');
    await client.query('DROP SCHEMA IF EXISTS _simplicity CASCADE');
    await client.query('DROP TABLE IF EXISTS public.test_dw_table CASCADE');
    await client.query('DROP FUNCTION IF EXISTS public._simplicity_dw_fn_test_table_val() CASCADE');
    await client.query('DROP FUNCTION IF EXISTS public._smplcty_sf_dw_fn_test_table_val() CASCADE');
  });

  afterEach(async () => {
    if (client) {
      await client.query('DROP SCHEMA IF EXISTS _smplcty_schema_flow CASCADE');
      client.release();
    }
  });

  afterAll(async () => {
    await closePool();
  });

  describe('ensureHistoryTable', () => {
    it('creates _smplcty_schema_flow schema and history table', async () => {
      await ensureHistoryTable(client);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = '_smplcty_schema_flow' AND table_name = 'history'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it('is idempotent — can be called multiple times', async () => {
      await ensureHistoryTable(client);
      await ensureHistoryTable(client);

      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = '_smplcty_schema_flow' AND table_name = 'history'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it('creates correct columns', async () => {
      await ensureHistoryTable(client);

      const result = await client.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = '_smplcty_schema_flow' AND table_name = 'history'
        ORDER BY ordinal_position
      `);
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toEqual(['file_path', 'file_hash', 'phase', 'pg_schema', 'applied_at']);
    });
  });

  describe('recordFile and getFileHash', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('records a file and retrieves its hash', async () => {
      await recordFile(client, 'tables/users.yaml', 'abc123', 'schema', 'public');

      const hash = await getFileHash(client, 'tables/users.yaml', 'public');
      expect(hash).toBe('abc123');
    });

    it('returns null for unknown file', async () => {
      const hash = await getFileHash(client, 'nonexistent.yaml', 'public');
      expect(hash).toBeNull();
    });

    it('upserts on duplicate file_path within the same pgSchema', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash1', 'schema', 'public');
      await recordFile(client, 'tables/users.yaml', 'hash2', 'schema', 'public');

      const hash = await getFileHash(client, 'tables/users.yaml', 'public');
      expect(hash).toBe('hash2');
    });

    it('isolates file_path entries across pgSchemas', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash_a', 'schema', 'app');
      await recordFile(client, 'tables/users.yaml', 'hash_b', 'schema', 'reports');

      expect(await getFileHash(client, 'tables/users.yaml', 'app')).toBe('hash_a');
      expect(await getFileHash(client, 'tables/users.yaml', 'reports')).toBe('hash_b');
    });
  });

  describe('getHistory', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('returns empty array when no files are tracked', async () => {
      const history = await getHistory(client, 'public');
      expect(history).toEqual([]);
    });

    it('returns all tracked files for a pgSchema ordered by path', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash1', 'schema', 'public');
      await recordFile(client, 'pre/setup.sql', 'hash2', 'pre', 'public');
      await recordFile(client, 'post/cleanup.sql', 'hash3', 'post', 'public');

      const history = await getHistory(client, 'public');
      expect(history).toHaveLength(3);
      expect(history[0].filePath).toBe('post/cleanup.sql');
      expect(history[1].filePath).toBe('pre/setup.sql');
      expect(history[2].filePath).toBe('tables/users.yaml');
    });

    it('returns correct entry fields', async () => {
      await recordFile(client, 'tables/users.yaml', 'abc123', 'schema', 'public');

      const history = await getHistory(client, 'public');
      expect(history[0].filePath).toBe('tables/users.yaml');
      expect(history[0].fileHash).toBe('abc123');
      expect(history[0].phase).toBe('schema');
      expect(history[0].appliedAt).toBeInstanceOf(Date);
    });

    it('does not leak across pgSchemas', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash_a', 'schema', 'app');
      await recordFile(client, 'tables/orders.yaml', 'hash_b', 'schema', 'reports');

      const appHistory = await getHistory(client, 'app');
      expect(appHistory).toHaveLength(1);
      expect(appHistory[0].filePath).toBe('tables/users.yaml');
    });
  });

  describe('fileNeedsApply', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('returns true for new file', async () => {
      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'newhash', 'public');
      expect(needs).toBe(true);
    });

    it('returns false when hash matches', async () => {
      await recordFile(client, 'tables/users.yaml', 'samehash', 'schema', 'public');

      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'samehash', 'public');
      expect(needs).toBe(false);
    });

    it('returns true when hash differs', async () => {
      await recordFile(client, 'tables/users.yaml', 'oldhash', 'schema', 'public');

      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'newhash', 'public');
      expect(needs).toBe(true);
    });

    it('returns true when the same file_path is recorded under a different pgSchema', async () => {
      await recordFile(client, 'tables/users.yaml', 'samehash', 'schema', 'app');

      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'samehash', 'reports');
      expect(needs).toBe(true);
    });
  });

  describe('removeFileHistory', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('removes existing entry and returns true', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash', 'schema', 'public');

      const removed = await removeFileHistory(client, 'tables/users.yaml', 'public');
      expect(removed).toBe(true);

      const hash = await getFileHash(client, 'tables/users.yaml', 'public');
      expect(hash).toBeNull();
    });

    it('returns false for nonexistent entry', async () => {
      const removed = await removeFileHistory(client, 'nonexistent.yaml', 'public');
      expect(removed).toBe(false);
    });
  });

  describe('schema migration (_simplicity → _smplcty_schema_flow)', () => {
    let logger: Logger;
    let logMessages: { level: string; message: string }[];

    beforeEach(async () => {
      logMessages = [];
      logger = {
        debug: (msg: string) => logMessages.push({ level: 'debug', message: msg }),
        info: (msg: string) => logMessages.push({ level: 'info', message: msg }),
        warn: (msg: string) => logMessages.push({ level: 'warn', message: msg }),
        error: (msg: string) => logMessages.push({ level: 'error', message: msg }),
      };
      // Clean up legacy artifacts from prior runs
      await client.query('DROP SCHEMA IF EXISTS _simplicity CASCADE');
      await client.query('DROP TABLE IF EXISTS public.test_dw_table CASCADE');
      await client.query('DROP FUNCTION IF EXISTS public._simplicity_dw_fn_test_table_val() CASCADE');
      await client.query('DROP FUNCTION IF EXISTS public._smplcty_sf_dw_fn_test_table_val() CASCADE');
    });

    afterEach(async () => {
      await client.query('DROP SCHEMA IF EXISTS _simplicity CASCADE');
      await client.query('DROP TABLE IF EXISTS public.test_dw_table CASCADE');
      await client.query('DROP FUNCTION IF EXISTS public._simplicity_dw_fn_test_table_val() CASCADE');
      await client.query('DROP FUNCTION IF EXISTS public._smplcty_sf_dw_fn_test_table_val() CASCADE');
    });

    it('fresh install — no _simplicity schema, works normally', async () => {
      await ensureHistoryTable(client, logger);

      const result = await client.query(`
        SELECT nspname FROM pg_namespace WHERE nspname = '_smplcty_schema_flow'
      `);
      expect(result.rows).toHaveLength(1);

      // No migration messages logged
      const migrationLogs = logMessages.filter((l) => l.message.includes('_simplicity'));
      expect(migrationLogs).toHaveLength(0);
    });

    it('renames _simplicity to _smplcty_schema_flow when only old schema exists', async () => {
      // Set up legacy schema with history table and data
      await client.query('CREATE SCHEMA _simplicity');
      await client.query(`
        CREATE TABLE _simplicity.history (
          file_path  text PRIMARY KEY,
          file_hash  text NOT NULL,
          phase      text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        INSERT INTO _simplicity.history (file_path, file_hash, phase)
        VALUES ('tables/users.yaml', 'legacy_hash', 'schema')
      `);

      await ensureHistoryTable(client, logger);

      // Old schema should no longer exist
      const oldSchema = await client.query(`
        SELECT nspname FROM pg_namespace WHERE nspname = '_simplicity'
      `);
      expect(oldSchema.rows).toHaveLength(0);

      // New schema should exist with the migrated data
      const newSchema = await client.query(`
        SELECT nspname FROM pg_namespace WHERE nspname = '_smplcty_schema_flow'
      `);
      expect(newSchema.rows).toHaveLength(1);

      // Data should be preserved. Legacy rows back-fill pg_schema='public'
      // via the ALTER TABLE ADD COLUMN default applied in the upgrade.
      const history = await getHistory(client, 'public');
      expect(history).toHaveLength(1);
      expect(history[0].filePath).toBe('tables/users.yaml');
      expect(history[0].fileHash).toBe('legacy_hash');

      // Info-level migration message should be logged
      const infoLogs = logMessages.filter(
        (l) => l.level === 'info' && l.message.includes('_simplicity') && l.message.includes('_smplcty_schema_flow'),
      );
      expect(infoLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('preserves snapshots and expand_state tables during migration', async () => {
      // Set up legacy schema with additional tables
      await client.query('CREATE SCHEMA _simplicity');
      await client.query(`
        CREATE TABLE _simplicity.history (
          file_path  text PRIMARY KEY,
          file_hash  text NOT NULL,
          phase      text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE _simplicity.snapshots (
          id serial PRIMARY KEY,
          data text NOT NULL
        )
      `);
      await client.query(`INSERT INTO _simplicity.snapshots (data) VALUES ('snapshot_data')`);
      await client.query(`
        CREATE TABLE _simplicity.expand_state (
          id serial PRIMARY KEY,
          state text NOT NULL
        )
      `);
      await client.query(`INSERT INTO _simplicity.expand_state (state) VALUES ('expand_data')`);

      await ensureHistoryTable(client, logger);

      // Verify all data was preserved in new schema
      const snapshots = await client.query('SELECT data FROM _smplcty_schema_flow.snapshots');
      expect(snapshots.rows).toHaveLength(1);
      expect(snapshots.rows[0].data).toBe('snapshot_data');

      const expandState = await client.query('SELECT state FROM _smplcty_schema_flow.expand_state');
      expect(expandState.rows).toHaveLength(1);
      expect(expandState.rows[0].state).toBe('expand_data');
    });

    it('logs warning and leaves _simplicity alone when both schemas exist', async () => {
      // Create both schemas
      await client.query('CREATE SCHEMA _simplicity');
      await client.query(`
        CREATE TABLE _simplicity.history (
          file_path  text PRIMARY KEY,
          file_hash  text NOT NULL,
          phase      text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        INSERT INTO _simplicity.history (file_path, file_hash, phase)
        VALUES ('tables/old.yaml', 'old_hash', 'schema')
      `);
      await client.query('CREATE SCHEMA _smplcty_schema_flow');

      await ensureHistoryTable(client, logger);

      // Old schema should still exist (not renamed)
      const oldSchema = await client.query(`
        SELECT nspname FROM pg_namespace WHERE nspname = '_simplicity'
      `);
      expect(oldSchema.rows).toHaveLength(1);

      // Warning should be logged
      const warnings = logMessages.filter((l) => l.level === 'warn' && l.message.includes('_simplicity'));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it('renames dual-write triggers with old _simplicity_dw_ prefix', async () => {
      // Create legacy schema and a table with a dual-write trigger using old prefix
      await client.query('CREATE SCHEMA _simplicity');
      await client.query(`
        CREATE TABLE _simplicity.history (
          file_path  text PRIMARY KEY,
          file_hash  text NOT NULL,
          phase      text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query('CREATE TABLE public.test_dw_table (id serial PRIMARY KEY, val text)');
      await client.query(`
        CREATE FUNCTION public._simplicity_dw_fn_test_table_val()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `);
      await client.query(`
        CREATE TRIGGER _simplicity_dw_test_table_val
        BEFORE INSERT ON public.test_dw_table
        FOR EACH ROW EXECUTE FUNCTION public._simplicity_dw_fn_test_table_val()
      `);

      await ensureHistoryTable(client, logger);

      // Trigger should be renamed to new prefix
      const triggers = await client.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgname = '_smplcty_sf_dw_test_table_val'
      `);
      expect(triggers.rows).toHaveLength(1);

      // Old trigger name should no longer exist
      const oldTriggers = await client.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgname = '_simplicity_dw_test_table_val'
      `);
      expect(oldTriggers.rows).toHaveLength(0);

      // Function should be renamed too
      const fns = await client.query(`
        SELECT proname FROM pg_proc
        WHERE proname = '_smplcty_sf_dw_fn_test_table_val'
      `);
      expect(fns.rows).toHaveLength(1);

      // Old function name should no longer exist
      const oldFns = await client.query(`
        SELECT proname FROM pg_proc
        WHERE proname = '_simplicity_dw_fn_test_table_val'
      `);
      expect(oldFns.rows).toHaveLength(0);
    });

    it('works without a logger argument (backward compatible)', async () => {
      await ensureHistoryTable(client);

      const result = await client.query(`
        SELECT nspname FROM pg_namespace WHERE nspname = '_smplcty_schema_flow'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });
});
