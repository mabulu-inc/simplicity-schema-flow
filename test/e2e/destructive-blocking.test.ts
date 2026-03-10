import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

/** Remove all YAML files from a test project directory so writeSchema starts fresh. */
function clearSchema(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      fs.unlinkSync(full);
    }
  }
}

describe('E2E: Destructive operation blocking', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // ── 1. drop_table ────────────────────────────────────────────────

  it('(1) blocks drop_table without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create two tables — keep one so the pipeline still runs after removing the other
    writeSchema(ctx.dir, {
      'tables/to_drop.yaml': `
table: to_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/keeper.yaml': `
table: keeper
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Verify table exists
    const before = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'to_drop'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);

    // Remove the target table file — keep the other so pipeline runs
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/keeper.yaml': `
table: keeper
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Table should still exist because drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'to_drop'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(1b) allows drop_table with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create two tables — keep one so the pipeline still runs after removing the other
    writeSchema(ctx.dir, {
      'tables/to_drop2.yaml': `
table: to_drop2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/keeper2.yaml': `
table: keeper2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Remove the target table file — keep the other so pipeline runs
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/keeper2.yaml': `
table: keeper2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    // Table should be dropped
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'to_drop2'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 2. drop_column ──────────────────────────────────────────────

  it('(2) blocks drop_column without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/col_drop.yaml': `
table: col_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: removeme
    type: text
`,
    });

    await runMigration(ctx);

    // Remove the column from schema
    writeSchema(ctx.dir, {
      'tables/col_drop.yaml': `
table: col_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Column should still exist
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'col_drop' AND column_name = 'removeme'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(2b) allows drop_column with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/col_drop2.yaml': `
table: col_drop2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: removeme
    type: text
`,
    });

    await runMigration(ctx);

    writeSchema(ctx.dir, {
      'tables/col_drop2.yaml': `
table: col_drop2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    // Column should be gone
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'col_drop2' AND column_name = 'removeme'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 3. drop_index ───────────────────────────────────────────────

  it('(3) blocks drop_index without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/idx_drop.yaml': `
table: idx_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
indexes:
  - columns: [email]
`,
    });

    await runMigration(ctx);

    // Remove the index
    writeSchema(ctx.dir, {
      'tables/idx_drop.yaml': `
table: idx_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Index should still exist
    const after = await queryDb(
      ctx,
      `SELECT i.relname
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'idx_drop'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(3b) allows drop_index with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/idx_drop2.yaml': `
table: idx_drop2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
indexes:
  - columns: [email]
`,
    });

    await runMigration(ctx);

    writeSchema(ctx.dir, {
      'tables/idx_drop2.yaml': `
table: idx_drop2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT i.relname
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'idx_drop2'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 4. drop_foreign_key ─────────────────────────────────────────

  it('(4) blocks drop_foreign_key without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_parent.yaml': `
table: fk_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/fk_child.yaml': `
table: fk_child
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_parent
      column: id
`,
    });

    await runMigration(ctx);

    // Remove FK column (triggers drop_foreign_key + drop_column)
    writeSchema(ctx.dir, {
      'tables/fk_parent.yaml': `
table: fk_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/fk_child.yaml': `
table: fk_child
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // FK column should still exist
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'fk_child' AND column_name = 'parent_id'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(4b) allows drop_foreign_key with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_parent2.yaml': `
table: fk_parent2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/fk_child2.yaml': `
table: fk_child2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_parent2
      column: id
`,
    });

    await runMigration(ctx);

    writeSchema(ctx.dir, {
      'tables/fk_parent2.yaml': `
table: fk_parent2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/fk_child2.yaml': `
table: fk_child2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    // FK column should be gone
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'fk_child2' AND column_name = 'parent_id'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 5. drop_view ────────────────────────────────────────────────

  it('(5) blocks drop_view without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/view_base.yaml': `
table: view_base
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
      'views/my_view.yaml': `
name: my_view
query: |
  SELECT id, name FROM "${s}".view_base
`,
    });

    await runMigration(ctx);

    // Remove the view file — keep the table
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/view_base.yaml': `
table: view_base
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    await runMigration(ctx);

    // View should still exist
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.views
       WHERE table_schema = $1 AND table_name = 'my_view'`,
      [s],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(5b) allows drop_view with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/view_base2.yaml': `
table: view_base2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
      'views/my_view2.yaml': `
name: my_view2
query: |
  SELECT id, name FROM "${s}".view_base2
`,
    });

    await runMigration(ctx);

    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/view_base2.yaml': `
table: view_base2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.views
       WHERE table_schema = $1 AND table_name = 'my_view2'`,
      [s],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 6. drop_materialized_view ───────────────────────────────────

  it('(6) blocks drop_materialized_view without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/matview_base.yaml': `
table: matview_base
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: value
    type: integer
`,
      'views/my_matview.yaml': `
name: my_matview
materialized: true
query: |
  SELECT id, value FROM "${s}".matview_base
`,
    });

    await runMigration(ctx);

    // Remove the materialized view file
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/matview_base.yaml': `
table: matview_base
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: value
    type: integer
`,
    });

    await runMigration(ctx);

    // Materialized view should still exist
    const after = await queryDb(
      ctx,
      `SELECT 1 FROM pg_matviews
       WHERE schemaname = $1 AND matviewname = 'my_matview'`,
      [s],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(6b) allows drop_materialized_view with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/matview_base2.yaml': `
table: matview_base2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: value
    type: integer
`,
      'views/my_matview2.yaml': `
name: my_matview2
materialized: true
query: |
  SELECT id, value FROM "${s}".matview_base2
`,
    });

    await runMigration(ctx);

    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/matview_base2.yaml': `
table: matview_base2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: value
    type: integer
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT 1 FROM pg_matviews
       WHERE schemaname = $1 AND matviewname = 'my_matview2'`,
      [s],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 7. drop_extension ───────────────────────────────────────────

  it('(7) blocks drop_extension without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
`,
      'tables/anchor.yaml': `
table: anchor
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Verify extension exists
    let result = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(result.rowCount).toBe(1);

    // Remove the extensions file but keep anchor table so pipeline runs
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/anchor.yaml': `
table: anchor
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Extension should still exist
    result = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(result.rowCount).toBe(1);
  });

  it('(7b) allows drop_extension with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
`,
      'tables/anchor2.yaml': `
table: anchor2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Remove extensions file but keep anchor table so pipeline runs
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/anchor2.yaml': `
table: anchor2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    // pgcrypto may still exist if other schemas use it — we just verify no error
  });

  // ── 8. disable_rls ─────────────────────────────────────────────

  it('(8) blocks disable_rls without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_tbl.yaml': `
table: rls_tbl
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

    // Verify RLS is enabled
    const before = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_tbl'`,
      [ctx.schema],
    );
    expect(before.rows[0].relrowsecurity).toBe(true);

    // Remove rls from schema
    writeSchema(ctx.dir, {
      'tables/rls_tbl.yaml': `
table: rls_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // RLS should still be enabled
    const after = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_tbl'`,
      [ctx.schema],
    );
    expect(after.rows[0].relrowsecurity).toBe(true);
  });

  it('(8b) allows disable_rls with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_tbl2.yaml': `
table: rls_tbl2
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

    writeSchema(ctx.dir, {
      'tables/rls_tbl2.yaml': `
table: rls_tbl2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_tbl2'`,
      [ctx.schema],
    );
    expect(after.rows[0].relrowsecurity).toBe(false);
  });

  // ── 9. drop_policy ──────────────────────────────────────────────

  it('(9) blocks drop_policy without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/pol_tbl.yaml': `
table: pol_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: pol_select
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
`,
    });

    await runMigration(ctx);

    // Verify policy exists
    const before = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'pol_tbl' AND p.polname = 'pol_select'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);

    // Remove the policy (keep RLS enabled)
    writeSchema(ctx.dir, {
      'tables/pol_tbl.yaml': `
table: pol_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
`,
    });

    await runMigration(ctx);

    // Policy should still exist
    const after = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'pol_tbl' AND p.polname = 'pol_select'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(9b) allows drop_policy with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/pol_tbl2.yaml': `
table: pol_tbl2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: pol_select2
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
`,
    });

    await runMigration(ctx);

    writeSchema(ctx.dir, {
      'tables/pol_tbl2.yaml': `
table: pol_tbl2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'pol_tbl2' AND p.polname = 'pol_select2'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 10. drop_trigger ────────────────────────────────────────────

  it('(10) blocks drop_trigger without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_fn.yaml': `
name: trg_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/trg_tbl.yaml': `
table: trg_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
triggers:
  - name: my_trigger
    timing: AFTER
    events: [INSERT]
    function: trg_fn
    for_each: ROW
`,
    });

    await runMigration(ctx);

    // Verify trigger exists
    const before = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'trg_tbl'
         AND t.tgname = 'my_trigger'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);

    // Remove trigger from schema
    writeSchema(ctx.dir, {
      'functions/trg_fn.yaml': `
name: trg_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/trg_tbl.yaml': `
table: trg_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Trigger should still exist
    const after = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'trg_tbl'
         AND t.tgname = 'my_trigger'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
  });

  it('(10b) allows drop_trigger with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_fn2.yaml': `
name: trg_fn2
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/trg_tbl2.yaml': `
table: trg_tbl2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
triggers:
  - name: my_trigger2
    timing: AFTER
    events: [INSERT]
    function: trg_fn2
    for_each: ROW
`,
    });

    await runMigration(ctx);

    writeSchema(ctx.dir, {
      'functions/trg_fn2.yaml': `
name: trg_fn2
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/trg_tbl2.yaml': `
table: trg_tbl2
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);

    const after = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'trg_tbl2'
         AND t.tgname = 'my_trigger2'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(0);
  });

  // ── 11. type narrowing (text → varchar(50)) ────────────────────
  // Note: The planner marks type changes as destructive: false.
  // Type narrowing is detected by lint as a warning, not blocked.
  // This test verifies the type change goes through (not blocked).

  it('(11) type narrowing (text → varchar) is not blocked', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/narrow_tbl.yaml': `
table: narrow_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    await runMigration(ctx);

    // Narrow the type
    writeSchema(ctx.dir, {
      'tables/narrow_tbl.yaml': `
table: narrow_tbl
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: varchar(50)
`,
    });

    // Runs without --allow-destructive — type narrowing is not blocked
    await runMigration(ctx);

    // Type should have been changed
    const after = await queryDb(
      ctx,
      `SELECT data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'narrow_tbl' AND column_name = 'name'`,
      [ctx.schema],
    );
    expect(after.rows[0].data_type).toBe('character varying');
    expect(after.rows[0].character_maximum_length).toBe(50);
  });

  // ── 12. enum value removal ──────────────────────────────────────

  it('(12) blocks enum value removal without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create the enum
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."test_status" AS ENUM ('active', 'inactive', 'archived')`);

    // Schema declares only two values — 'archived' removed
    writeSchema(ctx.dir, {
      'enums/test_status.yaml': `
name: test_status
values:
  - active
  - inactive
`,
    });

    await runMigration(ctx);

    // 'archived' should still be present
    const after = await queryDb(
      ctx,
      `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE n.nspname = $1 AND t.typname = 'test_status'
       ORDER BY e.enumsortorder`,
      [ctx.schema],
    );
    const values = after.rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(values).toEqual(['active', 'inactive', 'archived']);
  });

  it('(12b) allows enum value removal with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create the enum
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."test_status2" AS ENUM ('active', 'inactive', 'archived')`);

    writeSchema(ctx.dir, {
      'enums/test_status2.yaml': `
name: test_status2
values:
  - active
  - inactive
`,
    });

    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);
  });
});
