/**
 * The plan is built once, after pre-scripts. Everything that reads live state
 * — including the seed filter, which skips seeds whose rows already match —
 * must see what pre-scripts changed, or the run applies a stale plan.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { useTestProject, writeSchema } from '../testing/index.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

describe('plan after pre-scripts', () => {
  it('re-seeds a row a pre-script deleted in the same run', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.schema;
    try {
      writeSchema(project.dir, {
        'tables/statuses.yaml': `
table: statuses
columns:
  - { name: id, type: integer, primary_key: true }
  - { name: name, type: text }
seeds:
  - { id: 1, name: active }
`,
      });
      await project.migrate();

      // The seed row is present, so a plan built before this pre-script would
      // filter the seed out as unchanged — and the deleted row would stay gone.
      writeSchema(project.dir, { 'pre/clear-statuses.sql': `DELETE FROM "${s}".statuses;` });
      const result = await project.migrate();
      expect(result.preScriptsRun).toBe(1);

      const rows = await getPool(DATABASE_URL).query(`SELECT id, name FROM "${s}".statuses`);
      expect(rows.rows).toEqual([{ id: 1, name: 'active' }]);
    } finally {
      await project.cleanup();
    }
  });
});
