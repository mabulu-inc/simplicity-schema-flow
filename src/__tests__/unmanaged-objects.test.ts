import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { parseTable } from '../schema/parser.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

const TABLE = `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: tenant_id, type: bigint }
  - { name: during, type: tstzrange }
  - { name: n, type: integer }
`;

async function sql(project: TestProject, text: string): Promise<pg.QueryResult> {
  const pool = new pg.Pool({ connectionString: project.config.connectionString });
  try {
    await pool.query(`SET search_path TO "${project.schema}"`);
    return await pool.query(text);
  } finally {
    await pool.end();
  }
}

async function plan(project: TestProject) {
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive: true, pgSchema: project.schema });
}

interface Kind {
  kind: string;
  /** The `unmanaged:` key that covers this kind. */
  key: string;
  /** Creates the object, named `x_<suffix>`, as a second author would. */
  create: (suffix: string) => string;
  exists: (suffix: string) => string;
  drop: string;
  /** Whether a second, unmatched object of this kind can sit on the same table. */
  stale: boolean;
}

const KINDS: Kind[] = [
  {
    kind: 'index',
    key: 'indexes',
    create: (s) => `CREATE INDEX x_${s} ON t (tenant_id, n) WHERE tenant_id = 298`,
    exists: (s) => `SELECT 1 FROM pg_class WHERE relname = 'x_${s}'`,
    drop: 'drop_index',
    stale: true,
  },
  {
    kind: 'unique constraint',
    key: 'indexes',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} UNIQUE (tenant_id, n)`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_unique_constraint',
    stale: false,
  },
  {
    kind: 'check',
    key: 'checks',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} CHECK (n >= 0)`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_check',
    stale: true,
  },
  {
    kind: 'exclusion constraint',
    key: 'exclusion_constraints',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} EXCLUDE USING gist (during WITH &&)`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_exclusion_constraint',
    stale: false,
  },
  {
    kind: 'trigger',
    key: 'triggers',
    // The function is standalone, so it lives outside the managed schema.
    create: (s) =>
      `CREATE SCHEMA IF NOT EXISTS x_app;
       CREATE OR REPLACE FUNCTION x_app.noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER x_${s} BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION x_app.noop()`,
    exists: (s) => `SELECT 1 FROM pg_trigger WHERE tgname = 'x_${s}'`,
    drop: 'drop_trigger',
    stale: true,
  },
  {
    kind: 'policy',
    key: 'policies',
    create: (s) => `CREATE POLICY x_${s} ON t FOR SELECT USING (tenant_id = 298)`,
    exists: (s) => `SELECT 1 FROM pg_policy WHERE polname = 'x_${s}'`,
    drop: 'drop_policy',
    stale: true,
  },
];

// schema-flow treated every undeclared object on a managed table as stale, so
// one routine `run --allow-destructive` dropped indexes an application had
// created per tenant — with no error, only slower queries later (issue #77).
// A table's YAML now declares, by name pattern, which objects someone else owns.
describe('unmanaged objects on a managed table (#77)', () => {
  it.each(KINDS)('keeps a $kind matching an unmanaged pattern and drops one that does not', async (k) => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': `${TABLE}unmanaged:\n  ${k.key}: ['x_mark*']\n` });
      await project.migrate();
      await sql(project, k.create('marked'));
      if (k.stale) await sql(project, k.create('stale'));

      const p = await plan(project);
      expect(p.unmanaged).toEqual([{ table: 't', name: 'x_marked' }]);
      expect(p.operations.filter((o) => o.objectName.includes('x_marked'))).toEqual([]);
      if (k.stale) {
        expect(p.operations.filter((o) => o.objectName.includes('x_stale')).map((o) => o.type)).toEqual([k.drop]);
      }

      await project.migrate({ allowDestructive: true });
      expect((await sql(project, k.exists('marked'))).rowCount).toBe(1);
      expect((await sql(project, k.exists('stale'))).rowCount).toBe(0);

      const drift = await project.drift();
      expect(drift.items.filter((i) => i.object.includes('x_marked'))).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('a pattern covers only its own kind, and only whole names', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // `x_?` matches x_a but not x_ab; a `checks` pattern doesn't cover an index.
      writeSchema(project.dir, { 'tables/t.yaml': `${TABLE}unmanaged:\n  indexes: ['x_?']\n  checks: ['x_idx']\n` });
      await project.migrate();
      await sql(project, `CREATE INDEX x_a ON t (n)`);
      await sql(project, `CREATE INDEX x_ab ON t (n)`);
      await sql(project, `CREATE INDEX x_idx ON t (n)`);

      const p = await plan(project);
      expect(p.unmanaged).toEqual([{ table: 't', name: 'x_a' }]);
      expect(p.operations.map((o) => `${o.type} ${o.objectName}`).sort()).toEqual([
        'drop_index x_ab',
        'drop_index x_idx',
      ]);
    } finally {
      await project.cleanup();
    }
  });

  it('a comment is not a marker', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE });
      await project.migrate();
      await sql(project, `CREATE INDEX x_note ON t (n)`);
      await sql(project, `COMMENT ON INDEX x_note IS 'schema-flow:unmanaged'`);

      const p = await plan(project);
      expect(p.unmanaged).toEqual([]);
      expect(p.operations.map((o) => o.type)).toEqual(['drop_index']);
    } finally {
      await project.cleanup();
    }
  });

  it('an object the YAML declares stays managed, even if a pattern matches it', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE });
      await project.migrate();
      await sql(project, `CREATE INDEX x_declared ON t (n)`);

      writeSchema(project.dir, {
        'tables/t.yaml': `${TABLE}indexes:\n  - { name: x_declared, columns: [tenant_id] }\nunmanaged:\n  indexes: ['x_*']\n`,
      });
      const p = await plan(project);
      expect(p.unmanaged).toEqual([]);
      expect(p.operations.map((o) => o.type)).toEqual(['drop_index', 'add_index']);
    } finally {
      await project.cleanup();
    }
  });

  it('rejects an unknown kind or a non-list of patterns', () => {
    expect(() => parseTable(`${TABLE}unmanaged:\n  tables: ['x']\n`)).toThrow(/unmanaged/);
    expect(() => parseTable(`${TABLE}unmanaged:\n  indexes: 'x_*'\n`)).toThrow(/unmanaged/);
  });
});
