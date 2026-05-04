import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertColumnExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: pre-script renames are reflected in apply-phase plan (#28)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('column rename via pre-script does not collide with stale add_column op', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First migration: establish a table with the *old* column name.
    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: widget_id
    type: serial
    primary_key: true
  - name: tenant_id
    type: integer
    nullable: false
`,
    });
    await runMigration(ctx);
    await assertColumnExists(ctx, 'widgets', 'tenant_id');

    // Second migration: rename the column in YAML and add a pre-script that
    // performs the same rename in SQL. Without the fix, the planner sees the
    // pre-pre-script state (column is still `tenant_id`), emits an
    // `add_column org_id` op, and the apply phase fails with
    // `column "org_id" of relation "widgets" already exists` after the
    // pre-script has already renamed the column.
    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: widget_id
    type: serial
    primary_key: true
  - name: org_id
    type: integer
    nullable: false
`,
      'pre/202604281000-rename-tenant-to-org.sql': `
        ALTER TABLE IF EXISTS "${ctx.schema}"."widgets" RENAME COLUMN "tenant_id" TO "org_id";
      `,
    });

    // Should succeed end-to-end. Allow destructive since dropping the old
    // column is part of what an unfixed planner would emit; with the fix the
    // re-plan sees the rename has already happened and emits no column ops.
    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.preScriptsRun).toBe(1);

    // Final state: column was renamed in place, not dropped+re-added (which
    // would lose the NOT NULL data on a populated table).
    await assertColumnExists(ctx, 'widgets', 'org_id');
    const tenantStillThere = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'widgets' AND column_name = 'tenant_id'`,
      [ctx.schema],
    );
    expect(tenantStillThere.rowCount).toBe(0);
  });
});
