import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
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

describe('composite (multi-column) foreign keys', () => {
  // ─── Parser ──────────────────────────────────────────────────
  it('parses the table-level foreign_keys mapping form', () => {
    const t = parseTable(`
table: child
columns:
  - { name: x, type: bigint }
  - { name: y, type: bigint }
foreign_keys:
  - references: parent
    map: { x: a, y: b }
    on_delete: RESTRICT
    on_update: CASCADE
`);
    expect(t.foreign_keys).toEqual([
      {
        columns: ['x', 'y'],
        references: { table: 'parent', columns: ['a', 'b'] },
        on_delete: 'RESTRICT',
        on_update: 'CASCADE',
      },
    ]);
  });

  it('rejects a single-column table-level foreign key (use column references instead)', () => {
    expect(() =>
      parseTable(`
table: child
columns:
  - { name: x, type: bigint }
foreign_keys:
  - references: parent
    map: { x: a }
`),
    ).toThrow(/two or more columns/);
  });

  it('rejects a map column that is not on the table', () => {
    expect(() =>
      parseTable(`
table: child
columns:
  - { name: x, type: bigint }
  - { name: y, type: bigint }
foreign_keys:
  - references: parent
    map: { x: a, nope: b }
`),
    ).toThrow(/not a column of this table/);
  });

  // ─── End to end ──────────────────────────────────────────────
  function schema(onDelete: string) {
    return {
      'tables/parent.yaml': `
table: parent
columns:
  - { name: a, type: bigint }
  - { name: b, type: bigint }
primary_key: [a, b]
`,
      'tables/child.yaml': `
table: child
columns:
  - name: id
    type: bigserial
    primary_key: true
  - { name: x, type: bigint }
  - { name: y, type: bigint }
foreign_keys:
  - references: parent
    map: { x: a, y: b }
    on_delete: ${onDelete}
`,
    };
  }

  async function fkCols(connStr: string, pgSchema: string): Promise<{ cols: number; on_delete: string }> {
    const pool = new pg.Pool({ connectionString: connStr });
    try {
      const r = await pool.query(
        `SELECT array_length(con.conkey,1) AS cols, con.confdeltype AS on_delete
         FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE con.contype='f' AND c.relname='child' AND n.nspname=$1`,
        [pgSchema],
      );
      return { cols: r.rows[0]?.cols ?? 0, on_delete: r.rows[0]?.on_delete ?? '' };
    } finally {
      await pool.end();
    }
  }

  it('creates, converges, reconciles, and drops a composite FK', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      // 1. Create.
      writeSchema(project.dir, schema('RESTRICT'));
      await project.migrate();

      // The real FK spans both columns with the declared action.
      let live = await fkCols(project.config.connectionString, s);
      expect(live.cols).toBe(2);
      expect(live.on_delete).toBe('r'); // RESTRICT

      // 2. Idempotent: re-plan emits no FK ops, drift is clean.
      let { desired, actual } = await buildDesiredAndActual(project.config, logger);
      let plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.operations.filter((o) => o.type.includes('foreign_key'))).toHaveLength(0);
      const report = await project.drift();
      expect(report.items.filter((i) => i.detail?.includes('composite FK'))).toEqual([]);

      // 3. Reconcile a referential-action change (drop + re-add, non-destructive).
      writeSchema(project.dir, schema('CASCADE'));
      ({ desired, actual } = await buildDesiredAndActual(project.config, logger));
      plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.operations.some((o) => o.type === 'drop_foreign_key')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'add_foreign_key_not_valid')).toBe(true);
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: s,
        logger,
      });
      live = await fkCols(project.config.connectionString, s);
      expect(live.cols).toBe(2);
      expect(live.on_delete).toBe('c'); // CASCADE — still composite

      // 4. Removing foreign_keys from the YAML is a destructive drop (gated).
      writeSchema(project.dir, {
        ...schema('CASCADE'),
        'tables/child.yaml': `
table: child
columns:
  - name: id
    type: bigserial
    primary_key: true
  - { name: x, type: bigint }
  - { name: y, type: bigint }
`,
      });
      ({ desired, actual } = await buildDesiredAndActual(project.config, logger));
      plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.blocked.some((o) => o.type === 'drop_foreign_key')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'drop_foreign_key')).toBe(false);
    } finally {
      await project.cleanup();
    }
  });
});
