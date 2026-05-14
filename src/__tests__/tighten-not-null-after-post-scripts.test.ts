/**
 * NOT NULL enforcement is deferred to a tighten phase that runs AFTER
 * post-scripts. This lets consumers ship a single revision that:
 *   - adds a new column declared `nullable: false`
 *   - includes a post-script that backfills it
 * and have one `run` invocation land both the backfill AND the NOT NULL,
 * instead of needing two revisions split across releases.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { execute } from '../executor/index.js';
import type { SchemaFile } from '../core/files.js';
import { hashFile } from '../core/files.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `tighten_test_${Date.now()}_${schemaCount++}`;
}

function emptyDesired(): DesiredState {
  return {
    tables: [],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions: null,
  };
}

function emptyActual(): ActualState {
  return {
    tables: new Map(),
    enums: new Map(),
    functions: new Map(),
    views: new Map(),
    materializedViews: new Map(),
    roles: new Map(),
    extensions: [],
  };
}

describe('NOT NULL tighten phase (runs after post-scripts)', () => {
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

  afterAll(async () => {
    await closePool();
  });

  it('one run lands both the post-script backfill and the NOT NULL', async () => {
    // Pre-existing table with rows whose audit column is nullable.
    const pool = getPool(DATABASE_URL);
    const setupClient = await pool.connect();
    try {
      await setupClient.query(`CREATE TABLE "${testSchema}"."events" ("id" integer PRIMARY KEY)`);
      await setupClient.query(`INSERT INTO "${testSchema}"."events" (id) VALUES (1), (2), (3)`);
    } finally {
      setupClient.release();
    }

    // Desired: add an "audited_at" column declared NOT NULL.
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'events',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'audited_at', type: 'timestamptz', nullable: false },
        ],
      },
    ];

    // Actual: table has rows but no audited_at yet.
    const actual = emptyActual();
    actual.tables.set('events', {
      table: 'events',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });

    const plan = buildPlan(desired, actual, { pgSchema: testSchema });

    // ADD COLUMN exists, no inline NOT NULL, plus a tighten_not_null op.
    const addOps = plan.operations.filter((o) => o.type === 'add_column');
    expect(addOps).toHaveLength(1);
    expect(addOps[0].sql).not.toContain('NOT NULL');

    const tightenOps = plan.operations.filter((o) => o.type === 'tighten_not_null');
    expect(tightenOps).toHaveLength(1);
    expect(tightenOps[0].objectName).toBe('events.audited_at');

    // Post-script backfills the new column for every existing row.
    const tmpDir = await mkdtemp(join(tmpdir(), 'tighten-test-'));
    const postSqlPath = join(tmpDir, 'backfill.sql');
    await writeFile(
      postSqlPath,
      `UPDATE "${testSchema}"."events" SET audited_at = '2020-01-01T00:00:00Z' WHERE audited_at IS NULL;`,
    );
    const postScripts: SchemaFile[] = [
      {
        relativePath: `post/${testSchema}_backfill.sql`,
        absolutePath: postSqlPath,
        phase: 'post',
        hash: await hashFile(postSqlPath),
      },
    ];

    try {
      const result = await execute({
        connectionString: DATABASE_URL,
        operations: plan.operations,
        postScripts,
        pgSchema: testSchema,
        logger,
      });

      // add_column + tighten_not_null both ran.
      expect(result.executed).toBeGreaterThanOrEqual(2);
      expect(result.postScriptsRun).toBe(1);

      // Column is NOT NULL and rows are backfilled.
      const verifyClient = await pool.connect();
      try {
        const nn = await verifyClient.query(
          `SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'events' AND column_name = 'audited_at'`,
          [testSchema],
        );
        expect(nn.rows[0].is_nullable).toBe('NO');

        const filled = await verifyClient.query(
          `SELECT count(*)::int AS cnt FROM "${testSchema}"."events" WHERE audited_at IS NULL`,
        );
        expect(filled.rows[0].cnt).toBe(0);

        // The check constraint added during tighten was dropped — only the
        // SET NOT NULL survives.
        const constraints = await verifyClient.query(
          `SELECT conname FROM pg_constraint
           WHERE conname = $1`,
          ['chk_events_audited_at_not_null'],
        );
        expect(constraints.rows).toHaveLength(0);
      } finally {
        verifyClient.release();
      }
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('tighten fails clearly when the column still has NULL rows', async () => {
    // Same setup but no backfill — VALIDATE should fail loudly.
    const pool = getPool(DATABASE_URL);
    const setupClient = await pool.connect();
    try {
      await setupClient.query(`CREATE TABLE "${testSchema}"."events" ("id" integer PRIMARY KEY)`);
      await setupClient.query(`INSERT INTO "${testSchema}"."events" (id) VALUES (1)`);
    } finally {
      setupClient.release();
    }

    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'events',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'audited_at', type: 'timestamptz', nullable: false },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('events', {
      table: 'events',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });

    const plan = buildPlan(desired, actual, { pgSchema: testSchema });

    // No post-script — column will still contain a NULL when tighten runs.
    await expect(
      execute({
        connectionString: DATABASE_URL,
        operations: plan.operations,
        pgSchema: testSchema,
        logger,
      }),
    ).rejects.toThrow(/audited_at/);

    // Column should still be nullable — tighten rolled back atomically.
    const verifyClient = await pool.connect();
    try {
      const nn = await verifyClient.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'events' AND column_name = 'audited_at'`,
        [testSchema],
      );
      expect(nn.rows[0].is_nullable).toBe('YES');
    } finally {
      verifyClient.release();
    }
  });

  it('does not emit tighten on re-run against an already-tightened column', async () => {
    // Run once to land the NOT NULL.
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text', nullable: false },
        ],
        seeds: [{ id: 1, email: 'a@b.com' }],
      },
    ];

    const plan1 = buildPlan(desired, emptyActual(), { pgSchema: testSchema });
    expect(plan1.operations.filter((o) => o.type === 'tighten_not_null')).toHaveLength(1);
    await execute({
      connectionString: DATABASE_URL,
      operations: plan1.operations,
      pgSchema: testSchema,
      logger,
    });

    // Simulate a re-plan against the now-populated DB. Manually construct
    // actual to mirror what the introspector would see after the first run.
    const actualAfter = emptyActual();
    actualAfter.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text', nullable: false },
      ],
    });
    const plan2 = buildPlan(desired, actualAfter, { pgSchema: testSchema });
    expect(plan2.operations.filter((o) => o.type === 'tighten_not_null')).toHaveLength(0);
  });
});
