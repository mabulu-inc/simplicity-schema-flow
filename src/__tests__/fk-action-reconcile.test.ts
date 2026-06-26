import { describe, it, expect, afterAll } from 'vitest';
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

// Before this fix the planner only set FK referential actions when a column was
// first created; an existing FK whose on_delete/on_update drifted from the YAML
// was reported by `drift` forever but never reconciled by `plan`/`run` (the
// `drop_foreign_key` op existed but was never emitted). This pins the round-trip.
describe('FK referential-action reconciliation (#66 follow-up)', () => {
  const schema = (onDelete: string, onUpdate = 'NO ACTION') => ({
    'tables/parent.yaml': `
table: parent
columns:
  - name: id
    type: bigserial
    primary_key: true
`,
    'tables/child.yaml': `
table: child
columns:
  - name: id
    type: bigserial
    primary_key: true
  - name: parent_id
    type: bigint
    references:
      table: parent
      column: id
      on_delete: ${onDelete}
      on_update: ${onUpdate}
`,
  });

  it('drop+re-adds an existing FK whose on_delete changed, then converges', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // 1. Create the FK as ON DELETE RESTRICT.
      writeSchema(project.dir, schema('RESTRICT'));
      await project.migrate();

      // 2. Change the YAML to ON DELETE SET NULL — the planner must now emit a
      //    drop + re-add (it has no ALTER for an FK's referential actions).
      writeSchema(project.dir, schema('SET NULL'));
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: project.config.pgSchema });
      expect(plan.operations.some((o) => o.type === 'drop_foreign_key')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'add_foreign_key_not_valid')).toBe(true);
      // A referential-action change re-adds immediately, so it is NOT blocked
      // as destructive.
      expect(plan.blocked.some((o) => o.type === 'drop_foreign_key')).toBe(false);

      // 3. Apply.
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // 4. The live FK now actually says SET NULL.
      const { rows } = await import('pg').then(async ({ default: pg }) => {
        const pool = new pg.Pool({ connectionString: project.config.connectionString });
        try {
          return await pool.query(
            `SELECT con.confdeltype FROM pg_constraint con
             JOIN pg_class c ON c.oid=con.conrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE con.contype='f' AND c.relname='child' AND n.nspname=$1`,
            [project.config.pgSchema],
          );
        } finally {
          await pool.end();
        }
      });
      expect(rows[0].confdeltype).toBe('n'); // n = SET NULL

      // 5. Re-plan is a clean no-op for FKs (converged + idempotent).
      const re = await buildDesiredAndActual(project.config, logger);
      const replan = buildPlan(re.desired, re.actual, { allowDestructive: false, pgSchema: project.config.pgSchema });
      expect(replan.operations.filter((o) => o.type.includes('foreign_key'))).toHaveLength(0);

      // 6. And drift no longer reports the FK action.
      const report = await project.drift();
      expect(report.items.filter((i) => i.detail?.includes('FK on_'))).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('gates a pure FK removal behind --allow-destructive', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, schema('RESTRICT'));
      await project.migrate();

      // Drop the FK from the YAML entirely (keep the plain column).
      writeSchema(project.dir, {
        'tables/parent.yaml': `
table: parent
columns:
  - name: id
    type: bigserial
    primary_key: true
`,
        'tables/child.yaml': `
table: child
columns:
  - name: id
    type: bigserial
    primary_key: true
  - name: parent_id
    type: bigint
`,
      });
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: project.config.pgSchema });
      // Removing the FK with nothing to replace it loses enforcement → blocked.
      expect(plan.blocked.some((o) => o.type === 'drop_foreign_key')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'drop_foreign_key')).toBe(false);
    } finally {
      await project.cleanup();
    }
  });
});
