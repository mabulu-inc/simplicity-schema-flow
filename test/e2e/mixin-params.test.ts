import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, writePackage, configWithImports, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

/** Resolve the table a FK column points at. */
async function fkTarget(ctx: TestProject, table: string, column: string): Promise<string | null> {
  const result = await queryDb(
    ctx,
    `SELECT ccu.table_name AS target
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1 AND tc.table_name = $2 AND kcu.column_name = $3`,
    [ctx.schema, table, column],
  );
  return result.rowCount ? result.rows[0].target : null;
}

describe('E2E: parameterized mixins', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('(1) defaults make the common case param-free', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'mixins/audit.yaml': `
mixin: audit
params:
  user_table: { default: users }
  user_pk: { default: user_id }
columns:
  - name: created_by
    type: bigint
    references: { table: '{{user_table}}', column: '{{user_pk}}' }
`,
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
      'tables/docs.yaml': `
table: docs
mixins: [audit]
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    await runPipeline(ctx.config, logger);
    expect(await fkTarget(ctx, 'docs', 'created_by')).toBe('users');
  });

  it('(2) imports[].params override a packaged mixin default', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/std', {
      'mixins/audit.yaml': `
mixin: audit
params:
  user_table: { default: users }
  user_pk: { default: user_id }
columns:
  - name: created_by
    type: bigint
    references: { table: '{{user_table}}', column: '{{user_pk}}' }
`,
    });
    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: account_id
    type: bigint
    primary_key: true
`,
      'tables/docs.yaml': `
table: docs
mixins: [audit]
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    const cfg = configWithImports(ctx, [
      { package: '@fixture/std', params: { user_table: 'accounts', user_pk: 'account_id' } },
    ]);
    await runPipeline(cfg, logger);
    expect(await fkTarget(ctx, 'docs', 'created_by')).toBe('accounts');
  });

  it('(3) params interpolate into a shipped function body', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/std', {
      'mixins/audit.yaml': `
mixin: audit
params:
  actor_guc: { default: app.actor_id }
columns:
  - name: created_by
    type: text
`,
      'functions/audit_stamp.yaml': `
name: audit_stamp
language: plpgsql
returns: text
body: |
  BEGIN
    RETURN current_setting('{{actor_guc}}', true);
  END;
`,
    });

    const cfg = configWithImports(ctx, [{ package: '@fixture/std', params: { actor_guc: 'app.who_did_it' } }]);
    await runPipeline(cfg, logger);

    const src = await queryDb(
      ctx,
      `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = $1 AND p.proname = 'audit_stamp'`,
      [ctx.schema],
    );
    expect(src.rows[0].prosrc).toContain('app.who_did_it');
    expect(src.rows[0].prosrc).not.toContain('{{');
  });

  it('(4) an unknown import param errors clearly', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/std', {
      'mixins/audit.yaml': `
mixin: audit
params:
  user_table: { default: users }
columns:
  - name: created_by
    type: text
`,
    });
    writeSchema(ctx.dir, {
      'tables/docs.yaml': `
table: docs
mixins: [audit]
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    const cfg = configWithImports(ctx, [{ package: '@fixture/std', params: { bogus_param: 'x' } }]);
    await expect(runPipeline(cfg, logger)).rejects.toThrow(/Import param "bogus_param".*not declared/);
  });

  it('(5) a referenced-but-unset param errors clearly', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'mixins/audit.yaml': `
mixin: audit
params:
  actor_guc: {}
columns:
  - name: created_by
    type: text
    default: "current_setting('{{actor_guc}}')"
`,
      'tables/docs.yaml': `
table: docs
mixins: [audit]
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    await expect(runPipeline(ctx.config, logger)).rejects.toThrow(/unknown or unset mixin param "\{\{actor_guc\}\}"/);
  });
});
