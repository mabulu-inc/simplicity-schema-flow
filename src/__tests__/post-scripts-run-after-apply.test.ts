/**
 * Post-scripts run strictly AFTER the declarative apply, so a backfill can
 * reference tables/columns created in the same run. A failing post-script
 * must abort the run and stay out of history so the next run retries it —
 * never silently swallowed and marked applied.
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

let n = 0;
const uniqueSchema = () => `post_after_apply_${Date.now()}_${n++}`;

function emptyDesired(): DesiredState {
  return { tables: [], enums: [], functions: [], views: [], materializedViews: [], roles: [], extensions: null };
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

describe('post-scripts run after the declarative apply', () => {
  let testSchema: string;

  beforeEach(async () => {
    testSchema = uniqueSchema();
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`CREATE SCHEMA "${testSchema}"`);
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
  afterAll(async () => {
    await closePool();
  });

  it('post-script that DELETEs a freshly-created table succeeds (runs AFTER apply)', async () => {
    // Desired: brand-new table `t`. Fresh schema — nothing exists yet.
    const desired = emptyDesired();
    desired.tables = [{ table: 't', columns: [{ name: 'id', type: 'integer', primary_key: true }] }];
    const plan = buildPlan(desired, emptyActual(), { pgSchema: testSchema });

    // Post-script references the table created in the SAME run.
    const tmpDir = await mkdtemp(join(tmpdir(), 'post-after-apply-'));
    const postPath = join(tmpDir, 'touch.sql');
    await writeFile(postPath, `DELETE FROM "${testSchema}"."t";`);
    const postPathRel = `post/${testSchema}_touch.sql`;
    const schemaPathRel = `tables/${testSchema}_t.yaml`;
    const postScripts: SchemaFile[] = [
      { relativePath: postPathRel, absolutePath: postPath, phase: 'post', hash: await hashFile(postPath) },
    ];
    // The declarative table file recorded alongside the run.
    const schemaFiles: SchemaFile[] = [
      { relativePath: schemaPathRel, absolutePath: join(tmpDir, 't.yaml'), phase: 'schema', hash: 'deadbeef' },
    ];

    // If post ran BEFORE the apply, this would throw 42P01. It must NOT throw.
    const result = await execute({
      connectionString: DATABASE_URL,
      operations: plan.operations,
      postScripts,
      schemaFiles,
      pgSchema: testSchema,
      logger,
    });
    expect(result.postScriptsRun).toBe(1);

    // Table exists, post-script recorded, and — the timestamp fix — the schema
    // file's applied_at is no later than the post-script's, matching true order.
    const c = await getPool(DATABASE_URL).connect();
    try {
      const exists = await c.query(`SELECT to_regclass($1) AS reg`, [`"${testSchema}"."t"`]);
      expect(exists.rows[0].reg).not.toBeNull();
      const hist = await c.query(
        `SELECT file_path, applied_at FROM _smplcty_schema_flow.history WHERE file_path = ANY($1)`,
        [[postPathRel, schemaPathRel]],
      );
      const byPath = new Map(hist.rows.map((r) => [r.file_path, r.applied_at as Date]));
      expect(byPath.has(postPathRel)).toBe(true);
      expect(byPath.has(schemaPathRel)).toBe(true);
      expect(byPath.get(schemaPathRel)!.getTime()).toBeLessThanOrEqual(byPath.get(postPathRel)!.getTime());
    } finally {
      c.release();
    }
    await rm(tmpDir, { recursive: true });
  });

  it('a FAILING post-script aborts the run and is NOT recorded in history', async () => {
    const desired = emptyDesired();
    desired.tables = [{ table: 't', columns: [{ name: 'id', type: 'integer', primary_key: true }] }];
    const plan = buildPlan(desired, emptyActual(), { pgSchema: testSchema });

    const tmpDir = await mkdtemp(join(tmpdir(), 'post-after-apply-'));
    const postPath = join(tmpDir, 'bad.sql');
    await writeFile(postPath, `DELETE FROM "${testSchema}"."nonexistent_table";`);
    const postScripts: SchemaFile[] = [
      {
        relativePath: `post/${testSchema}_bad.sql`,
        absolutePath: postPath,
        phase: 'post',
        hash: await hashFile(postPath),
      },
    ];

    await expect(
      execute({
        connectionString: DATABASE_URL,
        operations: plan.operations,
        postScripts,
        pgSchema: testSchema,
        logger,
      }),
    ).rejects.toThrow();

    const c = await getPool(DATABASE_URL).connect();
    try {
      const hist = await c.query(`SELECT count(*)::int AS cnt FROM _smplcty_schema_flow.history WHERE file_path = $1`, [
        `post/${testSchema}_bad.sql`,
      ]);
      expect(hist.rows[0].cnt).toBe(0); // NOT recorded → will retry next run
    } finally {
      c.release();
    }
    await rm(tmpDir, { recursive: true });
  });
});
