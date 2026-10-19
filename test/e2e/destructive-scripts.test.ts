/**
 * A pre/post script under `<phase>/destructive/` is declared destructive by
 * where it lives. Without --allow-destructive it is held back and stays
 * pending; with the flag it runs, ordered by full relative path (#82).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, writePackage, configWithImports, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { runPipeline, getStatus } from '../../src/cli/pipeline.js';
import { reportMigrationResult } from '../../src/cli/report.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

const TABLE = `
table: t
columns:
  - { name: id, type: integer, primary_key: true }
  - { name: n, type: integer }
`;

describe('E2E: destructive pre/post scripts (#82)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function rows(): Promise<number[]> {
    const res = await queryDb(ctx, `SELECT id FROM "${ctx.schema}".t ORDER BY id`);
    return res.rows.map((r) => r.id);
  }

  it('holds back a destructive script without the flag, keeps it pending, and runs it with the flag', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/t.yaml': TABLE,
      'post/a_fill.sql': 'INSERT INTO t (id) VALUES (1), (2);',
      'post/destructive/b_prune.sql': 'DELETE FROM t WHERE id = 1;',
    });

    const first = await ctx.migrate();
    expect(first.executedPostScripts).toEqual(['post/a_fill.sql']);
    expect(first.blockedScripts).toEqual(['post/destructive/b_prune.sql']);
    expect(await rows()).toEqual([1, 2]);

    // Not recorded: every later run without the flag holds it back again.
    const second = await ctx.migrate();
    expect(second.executedPostScripts).toEqual([]);
    expect(second.blockedScripts).toEqual(['post/destructive/b_prune.sql']);

    const status = await getStatus(ctx.config, logger);
    expect(status.pending).toEqual([{ filePath: 'post/destructive/b_prune.sql', phase: 'post', change: 'new' }]);

    const plan = await runPipeline({ ...ctx.config, dryRun: true }, logger);
    expect(plan.blockedScripts).toEqual(['post/destructive/b_prune.sql']);
    const lines: string[] = [];
    reportMigrationResult({
      result: plan,
      operations: plan.executedOperations,
      mode: 'default',
      write: (l) => lines.push(l),
      dryRun: true,
    });
    expect(lines).toContain('  Destructive scripts held back: 1 (use --allow-destructive to run)');

    const withFlag = await ctx.migrate({ allowDestructive: true });
    expect(withFlag.executedPostScripts).toEqual(['post/destructive/b_prune.sql']);
    expect(withFlag.blockedScripts).toEqual([]);
    expect(await rows()).toEqual([2]);

    // Applied once, it is just an applied script.
    const after = await ctx.migrate();
    expect(after.blockedScripts).toEqual([]);
    expect(after.skippedPostScripts).toBe(2);
  });

  it('orders destructive scripts by full relative path within their phase', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/t.yaml': TABLE,
      'post/20261001_seed.sql': 'INSERT INTO t (id, n) VALUES (1, 0);',
      'post/destructive/20261002_reset.sql': 'UPDATE t SET n = 100;',
      'post/20261003_bump.sql': 'UPDATE t SET n = n + 1;',
    });

    const result = await ctx.migrate({ allowDestructive: true });
    expect(result.executedPostScripts).toEqual([
      'post/20261001_seed.sql',
      'post/20261003_bump.sql',
      'post/destructive/20261002_reset.sql',
    ]);
    const res = await queryDb(ctx, `SELECT n FROM "${ctx.schema}".t`);
    expect(res.rows[0].n).toBe(100);
  });

  it('treats moving an applied script into destructive/ as a new script', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/t.yaml': TABLE,
      'pre/x.sql': 'SELECT 1;',
    });
    await ctx.migrate();

    writeSchema(ctx.dir, { 'pre/destructive/x.sql': 'SELECT 1;' });
    const result = await ctx.migrate();
    expect(result.blockedScripts).toEqual(['pre/destructive/x.sql']);
  });

  it('lists blocked operations in the plan and run results, next to blocked scripts', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/t.yaml': `${TABLE}  - { name: legacy, type: text }\n`,
    });
    await ctx.migrate();

    writeSchema(ctx.dir, { 'tables/t.yaml': TABLE });
    const plan = await runPipeline({ ...ctx.config, dryRun: true }, logger);
    expect(plan.blockedOperations.map((op) => `${op.type} ${op.objectName}`)).toEqual(['drop_column t.legacy']);

    const run = await ctx.migrate();
    expect(run.blockedOperations.map((op) => op.type)).toEqual(['drop_column']);

    const allowed = await ctx.migrate({ allowDestructive: true });
    expect(allowed.blockedOperations).toEqual([]);
  });

  it("holds back an imported package's destructive scripts the same way", async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/cleanup', {
      'post/destructive/prune.sql': 'SELECT 1;',
    });
    writeSchema(ctx.dir, { 'tables/t.yaml': TABLE });
    const config = configWithImports(ctx, [{ package: '@fixture/cleanup' }]);

    const held = await runPipeline(config, logger);
    expect(held.blockedScripts).toEqual(['@fixture/cleanup:post/destructive/prune.sql']);

    const ran = await runPipeline({ ...config, allowDestructive: true }, logger);
    expect(ran.executedPostScripts).toEqual(['@fixture/cleanup:post/destructive/prune.sql']);
  });
});
