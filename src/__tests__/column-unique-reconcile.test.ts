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

async function uniqueCount(connStr: string, schema: string, table: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: connStr });
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE con.contype='u' AND c.relname=$2 AND ns.nspname=$1`,
      [schema, table],
    );
    return r.rows[0].n as number;
  } finally {
    await pool.end();
  }
}

// Before this fix the planner created a column-level `unique:` only when the
// whole table was created; an existing column that gained `unique: true` was
// reported by drift forever but never reconciled by plan/run. (issue #66)
describe('column-level unique reconciliation (#66 follow-up)', () => {
  it('adds the constraint when an existing column gains unique, then converges', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      // 1. Column exists WITHOUT a unique (the productionnow legacy_id state).
      writeSchema(project.dir, {
        'tables/regions.yaml': `
table: regions
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: legacy_id, type: bigint }
`,
      });
      await project.migrate();
      expect(await uniqueCount(project.config.connectionString, s, 'regions')).toBe(0);

      // 2. Declare it unique → plan must now add the constraint.
      writeSchema(project.dir, {
        'tables/regions.yaml': `
table: regions
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: legacy_id, type: bigint, unique: true }
`,
      });
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.operations.some((o) => o.type === 'add_unique_constraint')).toBe(true);

      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: s,
        logger,
      });

      // The unique constraint now exists, named `<table>_<col>_key`.
      expect(await uniqueCount(project.config.connectionString, s, 'regions')).toBe(1);

      // 3. Converged + idempotent: re-plan has no unique op, drift is clean.
      const re = await buildDesiredAndActual(project.config, logger);
      const replan = buildPlan(re.desired, re.actual, { allowDestructive: false, pgSchema: s });
      expect(
        replan.operations.some((o) => o.type === 'add_unique_constraint' || o.type === 'drop_unique_constraint'),
      ).toBe(false);
      const report = await project.drift();
      expect(report.items.filter((i) => i.object.includes('legacy_id'))).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('gates dropping a column-level unique behind --allow-destructive', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      writeSchema(project.dir, {
        'tables/regions.yaml': `
table: regions
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: legacy_id, type: bigint, unique: true }
`,
      });
      await project.migrate();
      expect(await uniqueCount(project.config.connectionString, s, 'regions')).toBe(1);

      // Remove the unique flag → a destructive drop, gated.
      writeSchema(project.dir, {
        'tables/regions.yaml': `
table: regions
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: legacy_id, type: bigint }
`,
      });
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.blocked.some((o) => o.type === 'drop_unique_constraint')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'drop_unique_constraint')).toBe(false);
    } finally {
      await project.cleanup();
    }
  });
});
