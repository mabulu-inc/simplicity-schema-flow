/**
 * Per-table transaction grouping is how schema-flow applies the declarative
 * diff: one transaction per table, each guarded by `lock_timeout` and retried
 * on lock contention, so a large migration threads through live writers instead
 * of holding every table's `ACCESS EXCLUSIVE` until a single final commit.
 *
 * These tests pin the three behaviours that make that safe:
 *   1. grouping cuts one transaction per consecutive same-table run,
 *   2. a contended group retries and ultimately succeeds once the lock frees,
 *   3. an exhausted retry budget fails with the contended table named.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { execute, lockGroupKey, groupByLockKey } from '../executor/index.js';
import type { Operation } from '../planner/index.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `online_test_${Date.now()}_${schemaCount++}`;
}

function op(partial: Partial<Operation> & Pick<Operation, 'type' | 'objectName' | 'sql'>): Operation {
  return { phase: 6, destructive: false, ...partial };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-table transaction grouping', () => {
  afterAll(async () => {
    await closePool();
  });

  describe('grouping (pure)', () => {
    it('derives the lock-group key from the table name before the first dot', () => {
      expect(lockGroupKey(op({ type: 'create_table', objectName: 'orders', sql: '' }))).toBe('orders');
      expect(lockGroupKey(op({ type: 'add_foreign_key_not_valid', objectName: 'orders.fk_user', sql: '' }))).toBe(
        'orders',
      );
    });

    it('keeps a naturally atomic FK pair in one group and cuts a new group per table', () => {
      const ops: Operation[] = [
        op({ type: 'drop_foreign_key', objectName: 'orders.fk_user', sql: '', phase: 8 }),
        op({ type: 'add_foreign_key_not_valid', objectName: 'orders.fk_user', sql: '', phase: 8 }),
        op({ type: 'validate_constraint', objectName: 'orders.fk_user', sql: '', phase: 8 }),
        op({ type: 'drop_foreign_key', objectName: 'items.fk_order', sql: '', phase: 8 }),
        op({ type: 'add_foreign_key_not_valid', objectName: 'items.fk_order', sql: '', phase: 8 }),
      ];
      const groups = groupByLockKey(ops);
      expect(groups.map((g) => g.map((o) => o.objectName))).toEqual([
        ['orders.fk_user', 'orders.fk_user', 'orders.fk_user'],
        ['items.fk_order', 'items.fk_order'],
      ]);
    });
  });

  describe('execution against Postgres', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const client = await getPool(DATABASE_URL).connect();
      try {
        await client.query(`CREATE SCHEMA "${testSchema}"`);
        await client.query(`CREATE TABLE "${testSchema}"."t" ("id" integer)`);
      } finally {
        client.release();
      }
    });

    afterEach(async () => {
      const client = await getPool(DATABASE_URL).connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      } finally {
        client.release();
      }
    });

    it('retries a lock-blocked group and succeeds once the lock frees', async () => {
      // Hold ACCESS EXCLUSIVE on "t" from a second session, then release it
      // mid-run. The migration's group should time out, back off, retry, and
      // land the column once the blocker lets go.
      const blocker = await getPool(DATABASE_URL).connect();
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE "${testSchema}"."t" IN ACCESS EXCLUSIVE MODE`);

      // Release after enough time for at least one lock_timeout/backoff cycle.
      const release = (async () => {
        await sleep(700);
        await blocker.query('COMMIT');
        blocker.release();
      })();

      const ops: Operation[] = [
        op({
          type: 'add_column',
          objectName: 't.added',
          sql: `ALTER TABLE "${testSchema}"."t" ADD COLUMN IF NOT EXISTS "added" integer`,
        }),
      ];

      const result = await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        pgSchema: testSchema,
        lockTimeout: 200,
        maxRetries: 20,
        logger,
      });
      await release;

      expect(result.executed).toBe(1);
      const client = await getPool(DATABASE_URL).connect();
      try {
        const res = await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 't' AND column_name = 'added'`,
          [testSchema],
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('fails with the contended table named when the retry budget is exhausted', async () => {
      const blocker = await getPool(DATABASE_URL).connect();
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE "${testSchema}"."t" IN ACCESS EXCLUSIVE MODE`);

      const ops: Operation[] = [
        op({
          type: 'add_column',
          objectName: 't.added',
          sql: `ALTER TABLE "${testSchema}"."t" ADD COLUMN IF NOT EXISTS "added" integer`,
        }),
      ];

      try {
        await expect(
          execute({
            connectionString: DATABASE_URL,
            operations: ops,
            pgSchema: testSchema,
            lockTimeout: 100,
            maxRetries: 2,
            logger,
          }),
        ).rejects.toThrow(/Could not acquire lock on table "t" after 2 attempt\(s\)/);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
    });
  });
});
