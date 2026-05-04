import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { execute } from '../index.js';
import type { Operation } from '../../planner/index.js';
import { createLogger } from '../../core/logger.js';
import { closePool, getPool } from '../../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `errctx_test_${Date.now()}_${schemaCount++}`;
}

describe('Executor: error context (#27)', () => {
  let testSchema: string;

  afterAll(async () => {
    await closePool();
  });

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

  it('wraps a transactional op error with op type, name, and SQL', async () => {
    const sql = `ALTER TABLE "${testSchema}"."nope" ADD COLUMN "x" integer`;
    const ops: Operation[] = [
      {
        type: 'add_column',
        phase: 6,
        objectName: 'nope.x',
        sql,
        destructive: false,
      },
    ];

    let caught: Error | null = null;
    try {
      await execute({ connectionString: DATABASE_URL, operations: ops, logger });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    const msg = caught!.message;
    // Operation type and target must appear in the wrapped message so the
    // user can correlate against the plan output.
    expect(msg).toContain('add_column');
    expect(msg).toContain('nope.x');
    // The original Postgres error must survive — losing it would be worse
    // than the original bug.
    expect(msg).toMatch(/relation .* does not exist/i);
    // The SQL must be present so the user can see what was attempted.
    expect(msg).toContain(sql);
  });

  it('wraps a concurrent op error with op type, name, and SQL', async () => {
    const sql = `CREATE INDEX CONCURRENTLY "idx_nope" ON "${testSchema}"."missing" ("col")`;
    const ops: Operation[] = [
      {
        type: 'add_index',
        phase: 7,
        objectName: 'idx_nope',
        sql,
        destructive: false,
        concurrent: true,
      },
    ];

    let caught: Error | null = null;
    try {
      await execute({ connectionString: DATABASE_URL, operations: ops, logger });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    const msg = caught!.message;
    expect(msg).toContain('add_index');
    expect(msg).toContain('idx_nope');
    expect(msg).toMatch(/relation .* does not exist/i);
    expect(msg).toContain(sql);
  });

  it("matches the issue's lock-timeout repro: lock_timeout error carries op label and SQL", async () => {
    // Issue #27 explicit repro: another session holds an ACCESS EXCLUSIVE lock
    // on a table while a migration with a short lock_timeout tries to alter
    // it. Pre-fix this surfaced as a bare `canceling statement due to lock
    // timeout` with no clue which op was affected.
    const pool = getPool(DATABASE_URL);
    await pool.query(`CREATE TABLE "${testSchema}"."loads" ("id" integer PRIMARY KEY)`);

    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "${testSchema}"."loads" IN ACCESS EXCLUSIVE MODE`);

    const sql = `ALTER TABLE "${testSchema}"."loads" ADD COLUMN "tmp_col" integer`;
    const ops: Operation[] = [{ type: 'add_column', phase: 6, objectName: 'loads.tmp_col', sql, destructive: false }];

    let caught: Error | null = null;
    try {
      await execute({
        connectionString: DATABASE_URL,
        operations: ops,
        lockTimeout: 500,
        logger,
      });
    } catch (err) {
      caught = err as Error;
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('add_column');
    expect(caught!.message).toContain('loads.tmp_col');
    expect(caught!.message).toMatch(/canceling statement due to lock timeout/i);
    expect(caught!.message).toContain(sql);
  });

  it('preserves the underlying Postgres error code on the wrapped error', async () => {
    // Wrapping mustn't strip useful properties from the original pg error —
    // callers (e.g. drift --apply) inspect `.code` to classify failures.
    const ops: Operation[] = [
      {
        type: 'add_column',
        phase: 6,
        objectName: 'missing.x',
        sql: `ALTER TABLE "${testSchema}"."missing" ADD COLUMN "x" integer`,
        destructive: false,
      },
    ];

    let caught: { code?: string } | null = null;
    try {
      await execute({ connectionString: DATABASE_URL, operations: ops, logger });
    } catch (err) {
      caught = err as { code?: string };
    }

    expect(caught).not.toBeNull();
    // 42P01 = undefined_table
    expect(caught!.code).toBe('42P01');
  });
});
