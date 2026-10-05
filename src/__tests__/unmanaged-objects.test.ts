import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { generateFromDb } from '../scaffold/index.js';
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
  /** Creates the object, named `x_<suffix>`, as a second author would. */
  create: (suffix: string) => string;
  comment: (suffix: string, text: string) => string;
  exists: (suffix: string) => string;
  drop: string;
}

const KINDS: Kind[] = [
  {
    kind: 'index',
    create: (s) => `CREATE INDEX x_${s} ON t (tenant_id, n) WHERE tenant_id = 298`,
    comment: (s, c) => `COMMENT ON INDEX x_${s} IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_class WHERE relname = 'x_${s}'`,
    drop: 'drop_index',
  },
  {
    kind: 'unique constraint',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} UNIQUE (tenant_id, n)`,
    comment: (s, c) => `COMMENT ON CONSTRAINT x_${s} ON t IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_unique_constraint',
  },
  {
    kind: 'check',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} CHECK (n >= 0)`,
    comment: (s, c) => `COMMENT ON CONSTRAINT x_${s} ON t IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_check',
  },
  {
    kind: 'exclusion constraint',
    create: (s) => `ALTER TABLE t ADD CONSTRAINT x_${s} EXCLUDE USING gist (during WITH &&)`,
    comment: (s, c) => `COMMENT ON CONSTRAINT x_${s} ON t IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_constraint WHERE conname = 'x_${s}'`,
    drop: 'drop_exclusion_constraint',
  },
  {
    kind: 'trigger',
    create: (s) =>
      // The function is standalone, so it lives outside the managed schema.
      `CREATE SCHEMA IF NOT EXISTS x_app;
       CREATE OR REPLACE FUNCTION x_app.noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
       CREATE TRIGGER x_${s} BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION x_app.noop()`,
    comment: (s, c) => `COMMENT ON TRIGGER x_${s} ON t IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_trigger WHERE tgname = 'x_${s}'`,
    drop: 'drop_trigger',
  },
  {
    kind: 'policy',
    create: (s) => `CREATE POLICY x_${s} ON t FOR SELECT USING (tenant_id = 298)`,
    comment: (s, c) => `COMMENT ON POLICY x_${s} ON t IS '${c}'`,
    exists: (s) => `SELECT 1 FROM pg_policy WHERE polname = 'x_${s}'`,
    drop: 'drop_policy',
  },
];

// schema-flow treated every undeclared object on a managed table as stale, so
// one routine `run --allow-destructive` dropped indexes an application had
// created per tenant — with no error, only slower queries later (issue #77).
// A comment starting `schema-flow:unmanaged` now marks an object as owned by
// someone else.
describe('unmanaged objects on a managed table (#77)', () => {
  it.each(KINDS)('keeps a marked $kind and still drops an unmarked one', async (k) => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE });
      await project.migrate();
      await sql(project, k.create('marked'));
      await sql(project, k.comment('marked', 'schema-flow:unmanaged — tenant 298 filter'));
      if (k.kind !== 'unique constraint' && k.kind !== 'exclusion constraint') {
        await sql(project, k.create('stale'));
      }

      const p = await plan(project);
      expect(p.unmanaged).toEqual([{ table: 't', name: 'x_marked' }]);
      expect(p.operations.filter((o) => o.objectName.includes('x_marked'))).toEqual([]);
      if (k.kind !== 'unique constraint' && k.kind !== 'exclusion constraint') {
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

  it('a comment that does not start with the marker leaves the object stale', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE });
      await project.migrate();
      await sql(project, `CREATE INDEX x_note ON t (n)`);
      await sql(project, `COMMENT ON INDEX x_note IS 'see schema-flow:unmanaged'`);

      const p = await plan(project);
      expect(p.unmanaged).toEqual([]);
      expect(p.operations.map((o) => o.type)).toEqual(['drop_index']);
    } finally {
      await project.cleanup();
    }
  });

  it('an object the YAML declares stays managed, whatever its comment says', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE });
      await project.migrate();
      await sql(project, `CREATE INDEX x_declared ON t (n)`);
      await sql(project, `COMMENT ON INDEX x_declared IS 'schema-flow:unmanaged'`);

      writeSchema(project.dir, {
        'tables/t.yaml': `${TABLE}indexes:\n  - { name: x_declared, columns: [tenant_id] }\n`,
      });
      const p = await plan(project);
      expect(p.unmanaged).toEqual([]);
      expect(p.operations.map((o) => o.type)).toEqual(['drop_index', 'add_index']);
    } finally {
      await project.cleanup();
    }
  });

  it('generate leaves unmanaged objects out of the YAML', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': `${TABLE}indexes:\n  - { name: t_n, columns: [n] }\n` });
      await project.migrate();
      await sql(project, `CREATE INDEX x_marked ON t (tenant_id) WHERE tenant_id = 298`);
      await sql(project, `COMMENT ON INDEX x_marked IS 'schema-flow:unmanaged'`);

      const { actual } = await buildDesiredAndActual(project.config, logger);
      const [file] = generateFromDb({
        tables: [actual.tables.get('t')!],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });
      expect(parseTable(file.content).indexes?.map((i) => i.name)).toEqual(['t_n']);
    } finally {
      await project.cleanup();
    }
  });
});
