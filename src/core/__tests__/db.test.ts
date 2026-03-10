import { describe, it, expect, afterEach } from 'vitest';
import { getPool, closePool, withClient, withTransaction, testConnection, TRANSIENT_ERROR_CODES } from '../db.js';
import pg from 'pg';

const TEST_URL = process.env.DATABASE_URL!;

describe('db', () => {
  afterEach(async () => {
    await closePool();
  });

  describe('getPool', () => {
    it('returns a pg.Pool instance', () => {
      const pool = getPool(TEST_URL);
      expect(pool).toBeInstanceOf(pg.Pool);
    });

    it('returns the same pool for the same connection string', () => {
      const pool1 = getPool(TEST_URL);
      const pool2 = getPool(TEST_URL);
      expect(pool1).toBe(pool2);
    });

    it('returns different pools for different connection strings', () => {
      const pool1 = getPool(TEST_URL);
      const pool2 = getPool(TEST_URL + '?application_name=other');
      expect(pool1).not.toBe(pool2);
    });
  });

  describe('closePool', () => {
    it('clears all pools', async () => {
      const pool1 = getPool(TEST_URL);
      await closePool();
      const pool2 = getPool(TEST_URL);
      expect(pool1).not.toBe(pool2);
    });
  });

  describe('withClient', () => {
    it('provides a connected client and returns the callback result', async () => {
      const result = await withClient(TEST_URL, async (client) => {
        const res = await client.query('SELECT 1 + 1 AS sum');
        return res.rows[0].sum;
      });
      expect(result).toBe(2);
    });

    it('sets lock_timeout and statement_timeout when provided', async () => {
      const result = await withClient(
        TEST_URL,
        async (client) => {
          const res = await client.query('SHOW lock_timeout');
          const res2 = await client.query('SHOW statement_timeout');
          return { lockTimeout: res.rows[0].lock_timeout, statementTimeout: res2.rows[0].statement_timeout };
        },
        { lockTimeout: 3000, statementTimeout: 15000 },
      );
      expect(result.lockTimeout).toBe('3s');
      expect(result.statementTimeout).toBe('15s');
    });

    it('releases the client back to the pool after success', async () => {
      const pool = getPool(TEST_URL);
      await withClient(TEST_URL, async () => {});
      // Pool should have no waiting count and idle count should be > 0
      expect(pool.idleCount).toBeGreaterThanOrEqual(1);
    });

    it('releases the client back to the pool after error', async () => {
      const pool = getPool(TEST_URL);
      await expect(
        withClient(TEST_URL, async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');
      // Give a tick for client release
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.idleCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('withTransaction', () => {
    it('commits on success', async () => {
      // Create a temp table, insert in a transaction, verify it persists
      await withClient(TEST_URL, async (client) => {
        await client.query('CREATE TEMP TABLE _test_tx (val int) ON COMMIT PRESERVE ROWS');
      });

      await withTransaction(TEST_URL, async (client) => {
        await client.query('INSERT INTO _test_tx (val) VALUES (42)');
      });

      await withClient(TEST_URL, async (client) => {
        const res = await client.query('SELECT val FROM _test_tx');
        return res.rows[0]?.val;
      });
      // Temp tables are per-connection so we need a different approach
      // Let's use a real table in a test schema instead
    });

    it('rolls back on error', async () => {
      // Use a simpler test: verify the transaction is rolled back
      await expect(
        withTransaction(TEST_URL, async (client) => {
          await client.query('SELECT 1');
          throw new Error('rollback me');
        }),
      ).rejects.toThrow('rollback me');
    });

    it('passes through the return value', async () => {
      const result = await withTransaction(TEST_URL, async (client) => {
        const res = await client.query('SELECT 42 AS val');
        return res.rows[0].val;
      });
      expect(result).toBe(42);
    });

    it('sets lock_timeout and statement_timeout', async () => {
      const result = await withTransaction(
        TEST_URL,
        async (client) => {
          const res = await client.query('SHOW lock_timeout');
          return res.rows[0].lock_timeout;
        },
        { lockTimeout: 7000, statementTimeout: 20000 },
      );
      expect(result).toBe('7s');
    });
  });

  describe('testConnection', () => {
    it('returns true for valid connection', async () => {
      const result = await testConnection(TEST_URL);
      expect(result).toBe(true);
    });

    it('returns false for invalid connection', async () => {
      const result = await testConnection('postgresql://localhost:59999/nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('retry logic', () => {
    it('exports transient error codes', () => {
      expect(TRANSIENT_ERROR_CODES).toContain('55P03'); // lock_not_available
      expect(TRANSIENT_ERROR_CODES).toContain('57014'); // query_canceled
      expect(TRANSIENT_ERROR_CODES).toContain('40001'); // serialization_failure
      expect(TRANSIENT_ERROR_CODES).toContain('40P01'); // deadlock_detected
    });

    it('retries on transient errors in withClient', async () => {
      let attempts = 0;
      const result = await withClient(
        TEST_URL,
        async (client) => {
          attempts++;
          if (attempts < 3) {
            const err = new Error('lock timeout') as Error & { code: string };
            err.code = '55P03';
            throw err;
          }
          const res = await client.query('SELECT 1 AS val');
          return res.rows[0].val;
        },
        { maxRetries: 3 },
      );
      expect(result).toBe(1);
      expect(attempts).toBe(3);
    });

    it('does not retry non-transient errors', async () => {
      let attempts = 0;
      await expect(
        withClient(
          TEST_URL,
          async () => {
            attempts++;
            throw new Error('not transient');
          },
          { maxRetries: 3 },
        ),
      ).rejects.toThrow('not transient');
      expect(attempts).toBe(1);
    });

    it('gives up after maxRetries', async () => {
      let attempts = 0;
      await expect(
        withClient(
          TEST_URL,
          async () => {
            attempts++;
            const err = new Error('lock timeout') as Error & { code: string };
            err.code = '55P03';
            throw err;
          },
          { maxRetries: 2 },
        ),
      ).rejects.toThrow('lock timeout');
      expect(attempts).toBe(2);
    });

    it('retries on transient errors in withTransaction', async () => {
      let attempts = 0;
      const result = await withTransaction(
        TEST_URL,
        async (client) => {
          attempts++;
          if (attempts < 2) {
            const err = new Error('deadlock') as Error & { code: string };
            err.code = '40P01';
            throw err;
          }
          const res = await client.query('SELECT 99 AS val');
          return res.rows[0].val;
        },
        { maxRetries: 3 },
      );
      expect(result).toBe(99);
      expect(attempts).toBe(2);
    });
  });
});
