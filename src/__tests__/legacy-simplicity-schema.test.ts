import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema } from '../testing/index.js';
import { closePool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

// Before this fix every run renamed any schema named `_simplicity` to
// `_smplcty_schema_flow`, carrying an application's own tables with it
// (simplicity-admin keeps its system tables there). Each test file gets its
// own database, so creating `_simplicity` here cannot disturb other files.
describe('legacy _simplicity schema upgrade during a real run (#78)', () => {
  it('moves only legacy bookkeeping and leaves application tables in _simplicity', async () => {
    const project = await useTestProject(DATABASE_URL);
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      await pool.query('CREATE SCHEMA _simplicity');
      await pool.query('CREATE TABLE _simplicity.users (id int)');
      await pool.query('INSERT INTO _simplicity.users VALUES (1)');
      await pool.query(`
        CREATE TABLE _simplicity.history (
          file_path  text PRIMARY KEY,
          file_hash  text NOT NULL,
          phase      text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      writeSchema(project.dir, {
        'tables/widgets.yaml': `
table: widgets
columns:
  - { name: id, type: serial, primary_key: true }
`,
      });

      for (let run = 0; run < 2; run++) {
        await project.migrate();

        const users = await pool.query('SELECT id FROM _simplicity.users');
        expect(users.rows).toEqual([{ id: 1 }]);
        const legacy = await pool.query(`SELECT to_regclass('_simplicity.history') AS t`);
        expect(legacy.rows[0].t).toBeNull();
        const widgets = await pool.query(`SELECT to_regclass($1) AS t`, [`"${project.schema}".widgets`]);
        expect(widgets.rows[0].t).not.toBeNull();
      }
    } finally {
      await pool.query('DROP SCHEMA IF EXISTS _simplicity CASCADE');
      await pool.end();
      await project.cleanup();
    }
  });
});
