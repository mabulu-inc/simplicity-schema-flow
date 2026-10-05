import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

async function definition(project: TestProject, sql: string): Promise<string | null> {
  const pool = new pg.Pool({ connectionString: project.config.connectionString });
  try {
    const r = await pool.query(sql, [project.schema]);
    return (r.rows[0]?.def as string | undefined) ?? null;
  } finally {
    await pool.end();
  }
}

const constraintDef = (project: TestProject, name: string) =>
  definition(
    project,
    `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = $1 AND con.conname = '${name}'`,
  );

const indexDef = (project: TestProject, name: string) =>
  definition(project, `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND indexname = '${name}'`);

async function plan(project: TestProject, allowDestructive: boolean) {
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive, pgSchema: project.schema });
}

/**
 * Applies `before`, switches to `after`, and checks the recreate it forces is
 * blocked as a pair without --allow-destructive — nothing reported executed,
 * the live definition unchanged — then applied and converged with it.
 */
async function expectBlockedRecreate(
  before: string,
  after: string,
  liveDef: (project: TestProject) => Promise<string | null>,
  createType: string,
) {
  const project = await useTestProject(DATABASE_URL);
  try {
    writeSchema(project.dir, { 'tables/t.yaml': before });
    await project.migrate();
    const original = await liveDef(project);
    expect(original).not.toBeNull();

    writeSchema(project.dir, { 'tables/t.yaml': after });
    const gated = await plan(project, false);
    expect(gated.operations).toEqual([]);
    expect(gated.blocked.map((o) => o.type)).toContain(createType);

    const result = await project.migrate();
    expect(result.executedOperations).toEqual([]);
    expect(await liveDef(project)).toBe(original);

    await project.migrate({ allowDestructive: true });
    expect(await liveDef(project)).not.toBe(original);
    const again = await plan(project, true);
    expect(again.operations).toEqual([]);
  } finally {
    await project.cleanup();
  }
}

// A recreate's drop is destructive; its create is guarded on a name the
// blocked drop left in place, so it used to no-op while being reported as
// "Added …" and counted as executed (issue #80).
describe('a blocked recreate is reported as blocked, not executed (#80)', () => {
  it('unique constraint whose columns changed', async () => {
    await expectBlockedRecreate(
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: a, type: bigint }
  - { name: b, type: bigint }
indexes:
  - { name: t_key, columns: [a, b], unique: true, as_constraint: true }
`,
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: a, type: bigint }
  - { name: b, type: bigint }
indexes:
  - { name: t_key, columns: [a], unique: true, as_constraint: true }
`,
      (p) => constraintDef(p, 't_key'),
      'add_unique_constraint',
    );
  });

  it('plain index whose definition changed', async () => {
    await expectBlockedRecreate(
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: a, type: bigint }
  - { name: b, type: bigint }
indexes:
  - { name: t_ab, columns: [a, b] }
`,
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: a, type: bigint }
  - { name: b, type: bigint }
indexes:
  - { name: t_ab, columns: [a, b], where: 'a IS NOT NULL' }
`,
      (p) => indexDef(p, 't_ab'),
      'add_index',
    );
  });

  it('exclusion constraint whose definition changed', async () => {
    await expectBlockedRecreate(
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: during, type: tstzrange }
exclusion_constraints:
  - name: t_no_overlap
    elements: [{ column: during, operator: '&&' }]
`,
      `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: during, type: tstzrange }
exclusion_constraints:
  - name: t_no_overlap
    elements: [{ column: during, operator: '&&' }]
    where: 'id > 0'
`,
      (p) => constraintDef(p, 't_no_overlap'),
      'add_exclusion_constraint',
    );
  });
});
