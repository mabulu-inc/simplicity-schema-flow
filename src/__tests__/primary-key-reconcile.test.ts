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

async function query<T = Record<string, unknown>>(project: TestProject, sql: string): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: project.config.connectionString });
  try {
    await pool.query(`SET search_path TO "${project.schema}"`);
    return (await pool.query(sql)).rows as T[];
  } finally {
    await pool.end();
  }
}

/** The live primary key: its name and columns in key order, or null. */
async function livePk(project: TestProject, table: string): Promise<{ name: string; columns: string[] } | null> {
  const rows = await query<{ name: string; columns: string[] }>(
    project,
    `SELECT con.conname AS name,
            array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum))::text[] AS columns
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      WHERE con.contype = 'p' AND c.relname = '${table}' AND n.nspname = '${project.schema}'
      GROUP BY con.conname`,
  );
  return rows[0] ?? null;
}

async function replan(project: TestProject, allowDestructive = true) {
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive, pgSchema: project.schema });
}

// Postgres drops a constraint that contains a dropped column, so a plan that
// swapped a PK column used to leave the table with no primary key at all and
// report `0 blocked` — the planner never diffed `primary_key` on an existing
// table (issue #76).
describe('primary key reconciliation (#76)', () => {
  it('replaces a composite PK whose column the plan drops', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint,      nullable: false }
  - { name: k, type: timestamptz, nullable: false }
primary_key: [a, k]
`,
      });
      await project.migrate();
      await query(project, `INSERT INTO t VALUES (1, '2026-01-01T00:00:00Z'), (2, '2026-01-02T00:00:00Z')`);

      // The new key column needs a backfill before it can be part of a key; a
      // post-script supplies it, so the PK must be added after post-scripts.
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, nullable: false }
  - { name: d, type: date,   nullable: false }
primary_key: [a, d]
`,
        'post/backfill-d.sql': `UPDATE t SET d = DATE '2026-01-01' WHERE d IS NULL;`,
      });

      const blocked = await replan(project, false);
      expect(blocked.blocked.map((o) => o.type)).toEqual(
        expect.arrayContaining(['drop_column', 'replace_primary_key']),
      );

      await project.migrate({ allowDestructive: true });
      expect(await livePk(project, 't')).toEqual({ name: 't_pkey', columns: ['a', 'd'] });

      const again = await replan(project);
      expect(again.operations).toEqual([]);
      expect(again.blocked).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('replaces a PK whose columns all survive, keeping the old key until the new one is built', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, primary_key: true }
  - { name: b, type: bigint, nullable: false }
`,
      });
      await project.migrate();

      // `a` leaves the key and becomes nullable again; `b` joins it.
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint }
  - { name: b, type: bigint, nullable: false }
primary_key: [b]
primary_key_name: t_by_b
`,
      });
      await project.migrate({ allowDestructive: true });

      expect(await livePk(project, 't')).toEqual({ name: 't_by_b', columns: ['b'] });
      const [a] = await query<{ is_nullable: string }>(
        project,
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = '${project.schema}' AND table_name = 't' AND column_name = 'a'`,
      );
      expect(a.is_nullable).toBe('YES');

      const again = await replan(project);
      expect(again.operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('adds a PK to an existing table without one, unblocked', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, nullable: false }
`,
      });
      await project.migrate();

      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, primary_key: true }
`,
      });
      const plan = await replan(project, false);
      expect(plan.blocked).toEqual([]);
      expect(plan.operations.map((o) => o.type)).toContain('add_primary_key');

      await project.migrate();
      expect(await livePk(project, 't')).toEqual({ name: 't_pkey', columns: ['a'] });
      expect((await replan(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('renames a PK whose declared name changed, without rebuilding it', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, nullable: false }
  - { name: b, type: bigint, nullable: false }
primary_key: [a, b]
`,
      });
      await project.migrate();

      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, nullable: false }
  - { name: b, type: bigint, nullable: false }
primary_key: [a, b]
primary_key_name: t_ab
`,
      });
      const plan = await replan(project, false);
      expect(plan.blocked).toEqual([]);
      expect(plan.operations.map((o) => o.sql)).toEqual([
        expect.stringContaining('RENAME CONSTRAINT "t_pkey" TO "t_ab"'),
      ]);

      await project.migrate();
      expect(await livePk(project, 't')).toEqual({ name: 't_ab', columns: ['a', 'b'] });
      expect((await replan(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('drops a PK the YAML no longer declares, only with --allow-destructive', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, primary_key: true }
`,
      });
      await project.migrate();

      writeSchema(project.dir, {
        'tables/t.yaml': `
table: t
columns:
  - { name: a, type: bigint, nullable: false }
`,
      });
      const plan = await replan(project, false);
      expect(plan.blocked.map((o) => o.type)).toEqual(['drop_primary_key']);

      await project.migrate();
      expect(await livePk(project, 't')).not.toBeNull();

      await project.migrate({ allowDestructive: true });
      expect(await livePk(project, 't')).toBeNull();
      expect((await replan(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });
});
