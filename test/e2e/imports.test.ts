import { describe, it, expect, afterEach } from 'vitest';
import {
  useTestProject,
  writeSchema,
  writePackage,
  configWithImports,
  queryDb,
  assertTableExists,
  assertColumnExists,
} from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { runPipeline, getPlan } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

describe('E2E: imports + extend', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('(1) loads an imported package schema merged with the local schema', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
  - name: email
    type: text
    nullable: false
`,
    });
    writeSchema(ctx.dir, {
      'tables/posts.yaml': `
table: posts
columns:
  - name: id
    type: bigint
    primary_key: true
  - name: title
    type: text
`,
    });

    await runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger);

    await assertTableExists(ctx, 'users');
    await assertTableExists(ctx, 'posts');
  });

  it('(2) a local table can FK an imported table (cross-source apply order)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
    });
    writeSchema(ctx.dir, {
      'tables/sessions.yaml': `
table: sessions
columns:
  - name: id
    type: bigint
    primary_key: true
  - name: owner
    type: bigint
    references: { table: users, column: user_id }
`,
    });

    await runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger);

    const fk = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = 'sessions' AND constraint_type = 'FOREIGN KEY'`,
      [ctx.schema],
    );
    expect(fk.rowCount).toBe(1);
  });

  it('(3) a local table resolves a mixin shipped by an import', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/std', {
      'mixins/timestamps.yaml': `
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
`,
    });
    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
mixins: [timestamps]
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    await runPipeline(configWithImports(ctx, [{ package: '@fixture/std' }]), logger);
    await assertColumnExists(ctx, 'widgets', 'created_at');
  });

  it('(4) imported functions and seeds are applied', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'functions/touch.yaml': `
name: touch_fixture
language: sql
returns: integer
body: 'SELECT 1'
`,
      'tables/roles_seed.yaml': `
table: roles_seed
columns:
  - name: name
    type: text
    primary_key: true
seeds:
  - { name: admin }
  - { name: member }
`,
    });

    await runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger);

    const fn = await queryDb(
      ctx,
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'touch_fixture'`,
      [ctx.schema],
    );
    expect(fn.rowCount).toBe(1);

    const seeds = await queryDb(ctx, `SELECT name FROM "${ctx.schema}".roles_seed ORDER BY name`);
    expect(seeds.rows.map((r: { name: string }) => r.name)).toEqual(['admin', 'member']);
  });

  it('(5) extend adds columns/indexes to an imported table', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
    });
    writeSchema(ctx.dir, {
      'tables/users.ext.yaml': `
extend: users
columns:
  - { name: display_name, type: text }
indexes:
  - { columns: [display_name] }
`,
    });

    await runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger);
    await assertColumnExists(ctx, 'users', 'user_id');
    await assertColumnExists(ctx, 'users', 'display_name');

    const idx = await queryDb(
      ctx,
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND tablename = 'users' AND indexdef ILIKE '%display_name%'`,
      [ctx.schema],
    );
    expect(idx.rowCount).toBe(1);
  });

  it('(6) extend re-declaring an existing column errors', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
  - name: email
    type: text
`,
    });
    writeSchema(ctx.dir, {
      'tables/users.ext.yaml': `
extend: users
columns:
  - { name: email, type: varchar(50) }
`,
    });

    await expect(runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger)).rejects.toThrow(
      /re-declares column "email"/,
    );
  });

  it('(7) a local table re-declaring an imported table errors, naming both sources', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
    });
    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
    });

    await expect(runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger)).rejects.toThrow(
      /declared in two sources/,
    );
  });

  it('(8) imported objects are managed desired-state — no drift after apply', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
`,
    });
    writeSchema(ctx.dir, {
      'tables/posts.yaml': `
table: posts
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    const cfg = configWithImports(ctx, [{ package: '@fixture/auth' }]);
    await runPipeline(cfg, logger);

    const plan = await getPlan(cfg, logger);
    expect(plan.operations).toHaveLength(0);
  });

  it('(9) a missing imported package errors clearly', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/posts.yaml': `
table: posts
columns:
  - name: id
    type: bigint
    primary_key: true
`,
    });

    await expect(runPipeline(configWithImports(ctx, [{ package: '@fixture/missing' }]), logger)).rejects.toThrow(
      /could not be resolved/,
    );
  });

  it('(10) extend targeting an unknown table errors', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/ghost.ext.yaml': `
extend: ghost
columns:
  - { name: x, type: text }
`,
    });

    await expect(runPipeline(ctx.config, logger)).rejects.toThrow(/targets unknown table "ghost"/);
  });

  it('(11) a malformed file in an import is reported with its package-qualified path', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writePackage(ctx.dir, '@fixture/auth', {
      'tables/broken.yaml': `
table: broken
columns:
  - name: id
    type: bigint
    bogus_field: nope
`,
    });

    await expect(runPipeline(configWithImports(ctx, [{ package: '@fixture/auth' }]), logger)).rejects.toThrow(
      /@fixture\/auth:tables\/broken\.yaml/,
    );
  });
});
