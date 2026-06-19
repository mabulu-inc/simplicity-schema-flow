/**
 * A function return-type change requires DROP FUNCTION … CASCADE, which also
 * drops any policies/views that reference it. This exercises the full apply
 * behaviour (issue #62):
 *   - declared dependents dropped by CASCADE are recreated automatically by
 *     the post-apply convergence re-plan, so one `run` converges;
 *   - an UNDECLARED dependent that CASCADE will drop is surfaced as a warning
 *     rather than vanishing silently.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runPipeline, getPlan } from '../cli/pipeline.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

let schemaCount = 0;
function uniqueSchema(): string {
  return `cascade_conv_${Date.now()}_${schemaCount++}`;
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

describe('function CASCADE convergence + undeclared dependents (issue #62)', () => {
  let tmpDir: string;
  let pgSchema: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-conv-'));
    pgSchema = uniqueSchema();
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`CREATE SCHEMA "${pgSchema}"`);
      await client.query(`SET search_path TO "${pgSchema}"`);
      // Long-lived DB: function returns integer, with two views on it —
      // one we will declare in YAML, one we will not.
      await client.query(`CREATE FUNCTION current_user_id() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
      await client.query(`CREATE VIEW v_declared AS SELECT current_user_id() AS uid`);
      await client.query(`CREATE VIEW v_undeclared AS SELECT current_user_id() AS uid`);
    } finally {
      client.release();
    }

    fs.mkdirSync(path.join(tmpDir, 'functions'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'views'), { recursive: true });
    // Declared: the function (now bigint) and only the v_declared view.
    fs.writeFileSync(
      path.join(tmpDir, 'functions', 'current_user_id.yaml'),
      `name: current_user_id\nlanguage: sql\nreturns: bigint\nbody: 'SELECT 1::bigint'\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'views', 'v_declared.yaml'),
      `name: v_declared\nquery: SELECT current_user_id() AS uid\n`,
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

  it('recreates the declared dependent, warns about the undeclared one, and converges', async () => {
    const warnings: string[] = [];
    const logger = createLogger({
      verbose: false,
      quiet: false,
      json: false,
      stderr: (m) => warnings.push(m),
      stdout: () => {},
      color: false,
    });

    await runPipeline(baseConfig(tmpDir, pgSchema, true), logger);

    const client = await getPool(DATABASE_URL).connect();
    try {
      // Function was changed to bigint via DROP+CREATE.
      const ret = await client.query(
        `SELECT pg_get_function_result(p.oid) AS r FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = 'current_user_id'`,
        [pgSchema],
      );
      expect(ret.rows[0].r).toBe('bigint');

      // Declared view: CASCADE-dropped, then recreated by convergence.
      const declared = await client.query(`SELECT to_regclass($1) AS reg`, [`"${pgSchema}".v_declared`]);
      expect(declared.rows[0].reg).not.toBeNull();

      // Undeclared view: dropped by CASCADE, not recreated (not in schema).
      const undeclared = await client.query(`SELECT to_regclass($1) AS reg`, [`"${pgSchema}".v_undeclared`]);
      expect(undeclared.rows[0].reg).toBeNull();
    } finally {
      client.release();
    }

    // The user was warned that the undeclared dependent would be lost.
    const undeclaredWarning = warnings.find((w) => w.includes('v_undeclared'));
    expect(undeclaredWarning).toBeDefined();
    expect(undeclaredWarning!.toLowerCase()).toContain('warn');

    // One run converged: a fresh plan reports zero operations.
    const plan = await getPlan(baseConfig(tmpDir, pgSchema, true), logger);
    expect(plan.operations).toHaveLength(0);
  });

  it('blocks the change without --allow-destructive and does not touch the function or its dependents', async () => {
    const logger = createLogger({ verbose: false, quiet: true, json: false, stdout: () => {}, stderr: () => {} });

    await runPipeline(baseConfig(tmpDir, pgSchema, false), logger);

    const client = await getPool(DATABASE_URL).connect();
    try {
      // Still integer — nothing dropped or replaced.
      const ret = await client.query(
        `SELECT pg_get_function_result(p.oid) AS r FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = 'current_user_id'`,
        [pgSchema],
      );
      expect(ret.rows[0].r).toBe('integer');
      const undeclared = await client.query(`SELECT to_regclass($1) AS reg`, [`"${pgSchema}".v_undeclared`]);
      expect(undeclared.rows[0].reg).not.toBeNull();
    } finally {
      client.release();
    }
  });
});
