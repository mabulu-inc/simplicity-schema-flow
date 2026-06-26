import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { execute } from '../executor/index.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

async function withClient<T>(connStr: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function funcExists(connStr: string, schema: string, name: string): Promise<boolean> {
  return withClient(connStr, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2`,
      [schema, name],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

// A declared function so discovery has something, and to prove declared
// functions are NOT dropped.
const KEPT_FN = `
name: keep_fn
language: sql
returns: integer
args:
  - { name: x, type: integer }
body: "SELECT x"
`;

describe('drop undeclared functions (#66 follow-up)', () => {
  it('drops a function in the DB but absent from the YAML, gated behind --allow-destructive', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      writeSchema(project.dir, { 'functions/keep_fn.yaml': KEPT_FN });
      await project.migrate();

      // An undeclared function created out-of-band.
      await withClient(project.config.connectionString, (c) =>
        c.query(`CREATE FUNCTION "${s}".orphan_fn(a integer, b text) RETURNS text LANGUAGE sql AS 'SELECT b'`),
      );

      const { desired, actual } = await buildDesiredAndActual(project.config, logger);

      // Without the flag: the drop is blocked, not executed.
      const safe = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(safe.operations.some((o) => o.type === 'drop_function')).toBe(false);
      expect(safe.blocked.some((o) => o.type === 'drop_function' && o.objectName === 'orphan_fn')).toBe(true);

      // With the flag: it's an executable op, with the correct overload-safe signature,
      // and the declared keep_fn is left alone.
      const destr = buildPlan(desired, actual, { allowDestructive: true, pgSchema: s });
      const drop = destr.operations.find((o) => o.type === 'drop_function' && o.objectName === 'orphan_fn');
      expect(drop).toBeDefined();
      expect(drop!.sql).toMatch(/DROP FUNCTION IF EXISTS .*orphan_fn"\(integer, text\)/);
      expect(destr.operations.some((o) => o.type === 'drop_function' && o.objectName === 'keep_fn')).toBe(false);

      // Apply → the function is gone; re-plan is a clean no-op.
      await execute({
        connectionString: project.config.connectionString,
        operations: destr.operations,
        pgSchema: s,
        logger,
      });
      expect(await funcExists(project.config.connectionString, s, 'orphan_fn')).toBe(false);
      expect(await funcExists(project.config.connectionString, s, 'keep_fn')).toBe(true);

      const re = await buildDesiredAndActual(project.config, logger);
      const replan = buildPlan(re.desired, re.actual, { allowDestructive: true, pgSchema: s });
      expect(replan.operations.some((o) => o.type === 'drop_function')).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it('never drops extension-owned functions', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      writeSchema(project.dir, { 'functions/keep_fn.yaml': KEPT_FN });
      await project.migrate();

      // pgcrypto installs functions (digest, crypt, gen_salt, …) into the schema,
      // owned by the extension. They must never be treated as undeclared.
      await withClient(project.config.connectionString, (c) =>
        c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA "${s}"`),
      );

      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: true, pgSchema: s });
      const dropped = plan.operations.filter((o) => o.type === 'drop_function').map((o) => o.objectName);
      for (const extFn of ['digest', 'crypt', 'gen_salt', 'encrypt', 'hmac']) {
        expect(dropped).not.toContain(extFn);
      }
    } finally {
      await project.cleanup();
    }
  });
});
