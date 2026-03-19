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

const DATABASE_URL = process.env.DATABASE_URL!;

describe('tracker', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  beforeAll(async () => {
    pool = getPool(DATABASE_URL);
  });

  beforeEach(async () => {
    client = await pool.connect();
    // Create a fresh _smplcty_schema_flow schema for this test by using search_path
    // We'll drop and recreate _smplcty_schema_flow to ensure clean state
    await client.query('DROP SCHEMA IF EXISTS _smplcty_schema_flow CASCADE');
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
      expect(columns).toEqual(['file_path', 'file_hash', 'phase', 'applied_at']);
    });
  });

  describe('recordFile and getFileHash', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('records a file and retrieves its hash', async () => {
      await recordFile(client, 'tables/users.yaml', 'abc123', 'schema');

      const hash = await getFileHash(client, 'tables/users.yaml');
      expect(hash).toBe('abc123');
    });

    it('returns null for unknown file', async () => {
      const hash = await getFileHash(client, 'nonexistent.yaml');
      expect(hash).toBeNull();
    });

    it('upserts on duplicate file_path', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash1', 'schema');
      await recordFile(client, 'tables/users.yaml', 'hash2', 'schema');

      const hash = await getFileHash(client, 'tables/users.yaml');
      expect(hash).toBe('hash2');
    });
  });

  describe('getHistory', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('returns empty array when no files are tracked', async () => {
      const history = await getHistory(client);
      expect(history).toEqual([]);
    });

    it('returns all tracked files ordered by path', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash1', 'schema');
      await recordFile(client, 'pre/setup.sql', 'hash2', 'pre');
      await recordFile(client, 'post/cleanup.sql', 'hash3', 'post');

      const history = await getHistory(client);
      expect(history).toHaveLength(3);
      expect(history[0].filePath).toBe('post/cleanup.sql');
      expect(history[1].filePath).toBe('pre/setup.sql');
      expect(history[2].filePath).toBe('tables/users.yaml');
    });

    it('returns correct entry fields', async () => {
      await recordFile(client, 'tables/users.yaml', 'abc123', 'schema');

      const history = await getHistory(client);
      expect(history[0].filePath).toBe('tables/users.yaml');
      expect(history[0].fileHash).toBe('abc123');
      expect(history[0].phase).toBe('schema');
      expect(history[0].appliedAt).toBeInstanceOf(Date);
    });
  });

  describe('fileNeedsApply', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('returns true for new file', async () => {
      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'newhash');
      expect(needs).toBe(true);
    });

    it('returns false when hash matches', async () => {
      await recordFile(client, 'tables/users.yaml', 'samehash', 'schema');

      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'samehash');
      expect(needs).toBe(false);
    });

    it('returns true when hash differs', async () => {
      await recordFile(client, 'tables/users.yaml', 'oldhash', 'schema');

      const needs = await fileNeedsApply(client, 'tables/users.yaml', 'newhash');
      expect(needs).toBe(true);
    });
  });

  describe('removeFileHistory', () => {
    beforeEach(async () => {
      await ensureHistoryTable(client);
    });

    it('removes existing entry and returns true', async () => {
      await recordFile(client, 'tables/users.yaml', 'hash', 'schema');

      const removed = await removeFileHistory(client, 'tables/users.yaml');
      expect(removed).toBe(true);

      const hash = await getFileHash(client, 'tables/users.yaml');
      expect(hash).toBeNull();
    });

    it('returns false for nonexistent entry', async () => {
      const removed = await removeFileHistory(client, 'nonexistent.yaml');
      expect(removed).toBe(false);
    });
  });
});
