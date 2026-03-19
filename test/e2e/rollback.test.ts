import { describe, it, expect, afterEach } from 'vitest';
import {
  useTestProject,
  writeSchema,
  runMigration,
  queryDb,
  assertTableExists,
  assertColumnExists,
} from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { runDown } from '../../src/rollback/index.js';

let roleCounter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${roleCounter++}`;
}

async function snapshotCount(ctx: TestProject): Promise<number> {
  const res = await queryDb(ctx, 'SELECT count(*)::int AS cnt FROM _smplcty_schema_flow.snapshots');
  return res.rows[0].cnt;
}

describe('E2E: Rollback', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // (1) Migration auto-captures snapshot
  it('migration auto-captures snapshot', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/snap_test.yaml': `
table: snap_test
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'snap_test');

    const count = await snapshotCount(ctx);
    expect(count).toBe(1);
  });

  // (2) runDown reverses table creation (table gone after down)
  it('runDown reverses table creation', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rb_table.yaml': `
table: rb_table
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'rb_table');

    const result = await runDown(ctx.config.connectionString);
    expect(result.executed).toBeGreaterThan(0);

    // Table should be gone
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rb_table'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);
  });

  // (3) runDown reverses column addition (column gone after down)
  it('runDown reverses column addition', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First migration: create table
    writeSchema(ctx.dir, {
      'tables/rb_col.yaml': `
table: rb_col
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'rb_col');

    // Second migration: add a column
    writeSchema(ctx.dir, {
      'tables/rb_col.yaml': `
table: rb_col
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: extra
    type: text
`,
    });

    await runMigration(ctx);
    await assertColumnExists(ctx, 'rb_col', 'extra');

    // runDown should reverse only the latest snapshot (add_column)
    const result = await runDown(ctx.config.connectionString);
    expect(result.executed).toBeGreaterThan(0);

    // Column should be gone
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'rb_col' AND column_name = 'extra'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);

    // Table should still exist
    await assertTableExists(ctx, 'rb_col');
  });

  // (4) runDown reverses index addition
  it('runDown reverses index addition', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rb_idx.yaml': `
table: rb_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
`,
    });

    await runMigration(ctx);

    // Second migration: add an index
    writeSchema(ctx.dir, {
      'tables/rb_idx.yaml': `
table: rb_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
indexes:
  - name: idx_rb_email
    columns: [email]
`,
    });

    await runMigration(ctx);

    // Verify index exists
    const idxBefore = await queryDb(
      ctx,
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_rb_email'`,
      [ctx.schema],
    );
    expect(idxBefore.rowCount).toBe(1);

    await runDown(ctx.config.connectionString);

    // Index should be gone
    const idxAfter = await queryDb(
      ctx,
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_rb_email'`,
      [ctx.schema],
    );
    expect(idxAfter.rowCount).toBe(0);
  });

  // (5) runDown reverses trigger creation
  it('runDown reverses trigger creation', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/rb_trg_fn.yaml': `
name: rb_trg_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/rb_trg.yaml': `
table: rb_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
`,
    });

    await runMigration(ctx);

    // Second migration: add a trigger
    writeSchema(ctx.dir, {
      'functions/rb_trg_fn.yaml': `
name: rb_trg_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/rb_trg.yaml': `
table: rb_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
triggers:
  - name: rb_trigger
    timing: BEFORE
    events: [INSERT]
    function: rb_trg_fn
    for_each: ROW
`,
    });

    await runMigration(ctx);

    // Verify trigger exists
    const trgBefore = await queryDb(
      ctx,
      `SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rb_trg' AND t.tgname = 'rb_trigger'`,
      [ctx.schema],
    );
    expect(trgBefore.rowCount).toBe(1);

    await runDown(ctx.config.connectionString);

    // Trigger should be gone
    const trgAfter = await queryDb(
      ctx,
      `SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rb_trg' AND t.tgname = 'rb_trigger'`,
      [ctx.schema],
    );
    expect(trgAfter.rowCount).toBe(0);
  });

  // (6) runDown reverses RLS enable
  it('runDown reverses RLS enable', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rb_rls.yaml': `
table: rb_rls
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Second migration: enable RLS
    writeSchema(ctx.dir, {
      'tables/rb_rls.yaml': `
table: rb_rls
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
rls: true
`,
    });

    await runMigration(ctx);

    // Verify RLS is on
    const rlsBefore = await queryDb(
      ctx,
      `SELECT relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rb_rls'`,
      [ctx.schema],
    );
    expect(rlsBefore.rows[0].relrowsecurity).toBe(true);

    await runDown(ctx.config.connectionString);

    // RLS should be disabled
    const rlsAfter = await queryDb(
      ctx,
      `SELECT relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rb_rls'`,
      [ctx.schema],
    );
    expect(rlsAfter.rows[0].relrowsecurity).toBe(false);
  });

  // (7) runDown reverses grant
  it('runDown reverses grant', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('rb_grant');
    ctx.registerRole(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/rb_grant.yaml': `
table: rb_grant
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
grants:
  - to: ${roleName}
    privileges: [SELECT]
`,
    });

    await runMigration(ctx);

    // Verify grant
    const grantBefore = await queryDb(
      ctx,
      `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".rb_grant', 'SELECT') AS has_priv`,
    );
    expect(grantBefore.rows[0].has_priv).toBe(true);

    await runDown(ctx.config.connectionString);

    // Grant should be revoked (table might be dropped entirely)
    const tableCheck = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rb_grant'`,
      [ctx.schema],
    );

    if (tableCheck.rowCount! > 0) {
      const grantAfter = await queryDb(
        ctx,
        `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".rb_grant', 'SELECT') AS has_priv`,
      );
      expect(grantAfter.rows[0].has_priv).toBe(false);
    }
  });

  // (8) Irreversible operations skipped gracefully (alter_column, add_enum_value)
  it('irreversible operations skipped gracefully', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rb_irreversible.yaml': `
table: rb_irreversible
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Second migration: alter column nullable (generates alter_column which is irreversible)
    writeSchema(ctx.dir, {
      'tables/rb_irreversible.yaml': `
table: rb_irreversible
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
    nullable: true
`,
    });

    await runMigration(ctx, { allowDestructive: true });

    const result = await runDown(ctx.config.connectionString);

    // Should have skipped the alter_column (irreversible)
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped.some((s) => s.includes('irreversible'))).toBe(true);
  });

  // (9) Snapshot deleted after successful down
  it('snapshot deleted after successful down', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rb_snap_del.yaml': `
table: rb_snap_del
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Snapshot should exist
    expect(await snapshotCount(ctx)).toBe(1);

    await runDown(ctx.config.connectionString);

    // Snapshot should be gone
    expect(await snapshotCount(ctx)).toBe(0);
  });

  // (10) Multiple migrations -> down only reverses the latest
  it('multiple migrations: down only reverses the latest', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First migration: create table A
    writeSchema(ctx.dir, {
      'tables/rb_multi_a.yaml': `
table: rb_multi_a
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'rb_multi_a');

    // Second migration: create table B
    writeSchema(ctx.dir, {
      'tables/rb_multi_a.yaml': `
table: rb_multi_a
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/rb_multi_b.yaml': `
table: rb_multi_b
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: info
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'rb_multi_b');

    // Down should only reverse the latest migration (table B creation)
    await runDown(ctx.config.connectionString);

    // Table A should still exist
    await assertTableExists(ctx, 'rb_multi_a');

    // Table B should be gone
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'rb_multi_b'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);
  });
});
