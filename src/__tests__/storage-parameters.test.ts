import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { parseTable } from '../schema/parser.js';
import { generateFromDb } from '../scaffold/index.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

async function sql(project: TestProject, text: string): Promise<pg.QueryResult> {
  const pool = new pg.Pool({ connectionString: project.config.connectionString });
  try {
    return await pool.query(text);
  } finally {
    await pool.end();
  }
}

/** Live storage parameters, with toast ones prefixed `toast.`, sorted. */
async function reloptions(project: TestProject, table = 't'): Promise<string[]> {
  const r = await sql(
    project,
    `SELECT coalesce(c.reloptions, '{}') AS main, coalesce(tc.reloptions, '{}') AS toast
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class tc ON tc.oid = c.reltoastrelid
      WHERE n.nspname = '${project.schema}' AND c.relname = '${table}'`,
  );
  const { main, toast } = r.rows[0] as { main: string[]; toast: string[] };
  return [...main, ...toast.map((o) => `toast.${o}`)].sort();
}

async function plan(project: TestProject) {
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive: false, pgSchema: project.schema });
}

async function expectConverged(project: TestProject) {
  const again = await plan(project);
  expect(again.operations).toEqual([]);
  expect(again.blocked).toEqual([]);
  const drift = await project.drift();
  expect(drift.items.filter((i) => i.object.startsWith('t.storage'))).toEqual([]);
}

function table(storage?: string): string {
  return `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: body, type: text }
${storage ?? ''}`;
}

// A table's storage parameters (`WITH (...)`) could only be set by a post/
// script or by hand, so plan never showed them, drift never saw them, and
// nothing converged them (issue #79). A `storage:` key opts the table in:
// schema-flow then owns all of its parameters.
describe('table storage parameters (#79)', () => {
  it('creates a table with its declared parameters', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': table(`
storage:
  fillfactor: 80
  autovacuum_vacuum_scale_factor: 0
  autovacuum_vacuum_threshold: 5000
  toast.autovacuum_enabled: false
`),
      });
      await project.migrate();
      expect(await reloptions(project)).toEqual([
        'autovacuum_vacuum_scale_factor=0',
        'autovacuum_vacuum_threshold=5000',
        'fillfactor=80',
        'toast.autovacuum_enabled=false',
      ]);
      await expectConverged(project);
    } finally {
      await project.cleanup();
    }
  });

  it('sets, changes and resets parameters on an existing table', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table() });
      await project.migrate();

      writeSchema(project.dir, {
        'tables/t.yaml': table(`
storage:
  autovacuum_vacuum_scale_factor: 0.05
  autovacuum_vacuum_threshold: 5000
`),
      });
      const p = await plan(project);
      expect(p.operations.map((o) => o.sql)).toEqual([
        expect.stringMatching(
          /ALTER TABLE .* SET \(autovacuum_vacuum_scale_factor = 0\.05, autovacuum_vacuum_threshold = 5000\)$/,
        ),
      ]);
      await project.migrate();
      expect(await reloptions(project)).toEqual([
        'autovacuum_vacuum_scale_factor=0.05',
        'autovacuum_vacuum_threshold=5000',
      ]);
      await expectConverged(project);

      // Change one value, remove the other: SET the change, RESET the removal.
      writeSchema(project.dir, {
        'tables/t.yaml': table(`
storage:
  autovacuum_vacuum_scale_factor: 0
`),
      });
      await project.migrate();
      expect(await reloptions(project)).toEqual(['autovacuum_vacuum_scale_factor=0']);
      await expectConverged(project);

      // An empty map keeps the table opted in, with nothing declared.
      writeSchema(project.dir, { 'tables/t.yaml': table('storage: {}') });
      await project.migrate();
      expect(await reloptions(project)).toEqual([]);
      await expectConverged(project);
    } finally {
      await project.cleanup();
    }
  });

  it('reports drift for a declared value changed by hand, and puts it back', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table('storage:\n  fillfactor: 80') });
      await project.migrate();
      await sql(project, `ALTER TABLE "${project.schema}".t SET (fillfactor = 50)`);

      const drift = await project.drift();
      expect(drift.items.filter((i) => i.object.startsWith('t.storage'))).toEqual([
        expect.objectContaining({ object: 't.storage.fillfactor', status: 'different', expected: '80', actual: '50' }),
      ]);

      await project.migrate();
      expect(await reloptions(project)).toEqual(['fillfactor=80']);
      await expectConverged(project);
    } finally {
      await project.cleanup();
    }
  });

  it('on an opted-in table, resets a parameter set by hand that the YAML does not declare', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table('storage:\n  fillfactor: 80') });
      await project.migrate();
      await sql(project, `ALTER TABLE "${project.schema}".t SET (autovacuum_enabled = false)`);

      const drift = await project.drift();
      expect(drift.items.filter((i) => i.object.startsWith('t.storage'))).toEqual([
        expect.objectContaining({ object: 't.storage.autovacuum_enabled', status: 'missing_in_yaml' }),
      ]);
      const p = await plan(project);
      expect(p.operations.map((o) => o.sql)).toEqual([expect.stringMatching(/RESET \(autovacuum_enabled\)$/)]);

      await project.migrate();
      expect(await reloptions(project)).toEqual(['fillfactor=80']);
    } finally {
      await project.cleanup();
    }
  });

  it('leaves a table without a storage key alone', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table() });
      await project.migrate();
      await sql(project, `ALTER TABLE "${project.schema}".t SET (fillfactor = 70)`);

      await expectConverged(project);
      await project.migrate();
      expect(await reloptions(project)).toEqual(['fillfactor=70']);
    } finally {
      await project.cleanup();
    }
  });

  it("generate writes a table's live parameters back out as storage:", async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': table('storage:\n  autovacuum_vacuum_scale_factor: 0.05\n  autovacuum_enabled: false'),
      });
      await project.migrate();

      const { actual } = await buildDesiredAndActual(project.config, logger);
      const [file] = generateFromDb({
        tables: [actual.tables.get('t')!],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });
      expect(parseTable(file.content).storage).toEqual({
        autovacuum_vacuum_scale_factor: 0.05,
        autovacuum_enabled: false,
      });
    } finally {
      await project.cleanup();
    }
  });

  it('rejects a parameter name that is not a plain identifier', () => {
    expect(() => parseTable(table('storage:\n  "fillfactor = 1); DROP TABLE t; --": 1'))).toThrow(/storage/);
    expect(() => parseTable(table('storage:\n  fillfactor: [1]'))).toThrow(/storage/);
  });
});
