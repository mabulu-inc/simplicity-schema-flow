/**
 * `--stage` splits a run around the deploy: `before-deploy` applies only what
 * the old code can live with, `after-deploy` is the full pass (#83).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { reportMigrationResult } from '../../src/cli/report.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

const BEFORE = `
table: t
columns:
  - { name: id, type: integer, primary_key: true }
  - { name: legacy, type: text }
`;

const AFTER = `
table: t
columns:
  - { name: id, type: integer, primary_key: true }
  - { name: fresh, type: text }
`;

describe('E2E: deploy stages (#83)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function columns(): Promise<string[]> {
    const res = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 't' ORDER BY column_name`,
      [ctx.schema],
    );
    return res.rows.map((r) => r.column_name);
  }

  it('applies additive work before deploy and destructive work after', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, { 'tables/t.yaml': BEFORE });
    await ctx.migrate();

    writeSchema(ctx.dir, {
      'tables/t.yaml': AFTER,
      'post/a_fill.sql': 'INSERT INTO t (id) VALUES (1);',
      'post/destructive/b_prune.sql': 'DELETE FROM t;',
    });

    // --allow-destructive does not get past the before-deploy stage.
    const before = await runPipeline({ ...ctx.config, stage: 'before-deploy', allowDestructive: true }, logger);
    expect(await columns()).toEqual(['fresh', 'id', 'legacy']);
    expect(before.executedPostScripts).toEqual(['post/a_fill.sql']);
    expect(before.blockedScripts).toEqual(['post/destructive/b_prune.sql']);
    expect(before.blockedOperations.map((op) => `${op.type} ${op.objectName}`)).toEqual(['drop_column t.legacy']);
    expect(before.stage).toBe('before-deploy');

    const lines: string[] = [];
    reportMigrationResult({
      result: before,
      operations: before.executedOperations,
      mode: 'default',
      write: (l) => lines.push(l),
    });
    expect(lines).toContain('  Destructive scripts held back: 1 (waits for --stage after-deploy)');

    const after = await runPipeline({ ...ctx.config, stage: 'after-deploy' }, logger);
    expect(await columns()).toEqual(['fresh', 'id']);
    expect(after.executedPostScripts).toEqual(['post/destructive/b_prune.sql']);
    expect(after.blockedScripts).toEqual([]);
    expect(after.blockedOperations).toEqual([]);
    expect(after.stage).toBe('after-deploy');
  });

  it('catches up additive work when the before-deploy run was skipped', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, { 'tables/t.yaml': BEFORE });
    await ctx.migrate();

    writeSchema(ctx.dir, { 'tables/t.yaml': AFTER });
    await runPipeline({ ...ctx.config, stage: 'after-deploy' }, logger);
    expect(await columns()).toEqual(['fresh', 'id']);
  });

  it('leaves a run without a stage as it was', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, { 'tables/t.yaml': BEFORE });
    await ctx.migrate();

    writeSchema(ctx.dir, { 'tables/t.yaml': AFTER });
    const run = await ctx.migrate();
    expect(run.stage).toBeUndefined();
    expect(run.blockedOperations.map((op) => op.type)).toEqual(['drop_column']);
  });
});
