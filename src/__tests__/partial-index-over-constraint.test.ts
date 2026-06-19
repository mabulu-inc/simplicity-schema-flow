/**
 * A declared partial unique index (`unique: true` + `where:`) whose name
 * collides with an existing plain UNIQUE constraint must reconcile: drop the
 * constraint, build the partial index. Previously `CREATE … IF NOT EXISTS`
 * silently no-opped against the existing object and the plan never converged
 * (issue #61). Driven through the real apply so we observe on-disk state.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runPipeline } from '../cli/pipeline.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

let schemaCount = 0;
function uniqueSchema(): string {
  return `partial_idx_${Date.now()}_${schemaCount++}`;
}

function baseConfig(tmpDir: string, pgSchema: string, allowDestructive: boolean) {
  return {
    connectionString: DATABASE_URL,
    baseDir: tmpDir,
    pgSchema,
    dryRun: false,
    allowDestructive,
    skipChecks: false,
    lockTimeout: 5000,
    statementTimeout: 30000,
    maxRetries: 3,
    historyTable: 'history',
    verbose: false,
    quiet: false,
    json: false,
  };
}

async function indexDef(pgSchema: string, name: string): Promise<string | null> {
  const client = await getPool(DATABASE_URL).connect();
  try {
    const r = await client.query(
      `SELECT pg_get_indexdef(c.oid) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [pgSchema, name],
    );
    return r.rows.length ? (r.rows[0].def as string) : null;
  } finally {
    client.release();
  }
}

async function hasUniqueConstraint(pgSchema: string, name: string): Promise<boolean> {
  const client = await getPool(DATABASE_URL).connect();
  try {
    const r = await client.query(
      `SELECT 1 FROM pg_constraint con
       JOIN pg_namespace n ON n.oid = con.connamespace
       WHERE n.nspname = $1 AND con.conname = $2 AND con.contype = 'u'`,
      [pgSchema, name],
    );
    return r.rows.length > 0;
  } finally {
    client.release();
  }
}

describe('partial unique index over a same-named UNIQUE constraint (issue #61)', () => {
  let tmpDir: string;
  let pgSchema: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-idx-'));
    pgSchema = uniqueSchema();
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`CREATE SCHEMA "${pgSchema}"`);
      // Long-lived DB predating the partial-unique design: a plain UNIQUE
      // constraint on name.
      await client.query(
        `CREATE TABLE "${pgSchema}".tenants (
           id serial PRIMARY KEY,
           name text NOT NULL,
           deleted_at timestamptz,
           CONSTRAINT tenants_name_key UNIQUE (name)
         )`,
      );
    } finally {
      client.release();
    }

    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tables', 'tenants.yaml'),
      `table: tenants
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
  - name: deleted_at
    type: timestamptz
indexes:
  - columns: [name]
    unique: true
    where: deleted_at IS NULL
    name: tenants_name_key
`,
    );
  });

  afterEach(async () => {
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${pgSchema}" CASCADE`);
    } finally {
      client.release();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closePool();
  });

  it('drops the constraint, builds the partial index, and converges (--allow-destructive)', async () => {
    const logger = createLogger({ verbose: false, quiet: true, json: false, stdout: () => {}, stderr: () => {} });

    await runPipeline(baseConfig(tmpDir, pgSchema, true), logger);

    // The object on disk is now the partial unique index, not the old
    // non-partial constraint.
    const def = await indexDef(pgSchema, 'tenants_name_key');
    expect(def).not.toBeNull();
    expect(def!.toUpperCase()).toContain('UNIQUE');
    expect(def!.toUpperCase()).toContain('WHERE');
    expect(def!.toLowerCase()).toContain('deleted_at is null');
    expect(await hasUniqueConstraint(pgSchema, 'tenants_name_key')).toBe(false);

    // Converges: a second run applies nothing.
    const second = await runPipeline(baseConfig(tmpDir, pgSchema, true), logger);
    expect(second.executed).toBe(0);
  });

  it('without --allow-destructive: nothing is applied and the constraint is left intact', async () => {
    const logger = createLogger({ verbose: false, quiet: true, json: false, stdout: () => {}, stderr: () => {} });

    const result = await runPipeline(baseConfig(tmpDir, pgSchema, false), logger);

    // No misleading "Added index" — the create that can't succeed is not
    // attempted while the reconciling drop is blocked.
    expect(result.executed).toBe(0);
    // The original constraint is untouched; the index is still non-partial.
    expect(await hasUniqueConstraint(pgSchema, 'tenants_name_key')).toBe(true);
    const def = await indexDef(pgSchema, 'tenants_name_key');
    expect(def!.toUpperCase()).not.toContain('WHERE');
  });
});
