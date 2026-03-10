import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

let counter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${counter++}`;
}

async function dropRoleIfExists(ctx: TestProject, roleName: string): Promise<void> {
  await queryDb(ctx, `DROP OWNED BY "${roleName}"`).catch(() => {});
  await queryDb(ctx, `DROP ROLE IF EXISTS "${roleName}"`);
}

describe('E2E: Drift detection', () => {
  let ctx: TestProject;
  const rolesToCleanup: string[] = [];

  afterEach(async () => {
    if (ctx) {
      for (const role of rolesToCleanup) {
        await dropRoleIfExists(ctx, role).catch(() => {});
      }
      rolesToCleanup.length = 0;
      await ctx.cleanup();
    }
  });

  // ─── (1) No drift on fresh migration ─────────────────────────

  it('(1) no drift on fresh migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    nullable: false
  - name: email
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);
    const report = await ctx.drift();

    // Filter to only items related to our declared objects (exclude system roles/extensions)
    const relevant = report.items.filter((i) => i.type !== 'role' && i.type !== 'extension');
    expect(relevant).toHaveLength(0);
  });

  // ─── (2) Missing column in DB detected ────────────────────────

  it('(2) missing column in DB detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Manually drop a column from the DB
    await queryDb(ctx, `ALTER TABLE "${ctx.schema}".products DROP COLUMN name`);

    const report = await ctx.drift();
    const missing = report.items.find(
      (i) => i.type === 'column' && i.object === 'products.name' && i.status === 'missing_in_db',
    );
    expect(missing).toBeDefined();
  });

  // ─── (3) Extra column in DB detected ──────────────────────────

  it('(3) extra column in DB detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await runMigration(ctx);

    // Manually add a column to the DB
    await queryDb(ctx, `ALTER TABLE "${ctx.schema}".items ADD COLUMN surprise text`);

    const report = await ctx.drift();
    const extra = report.items.find(
      (i) => i.type === 'column' && i.object === 'items.surprise' && i.status === 'missing_in_yaml',
    );
    expect(extra).toBeDefined();
  });

  // ─── (4) Column type mismatch detected ────────────────────────

  it('(4) column type mismatch detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: amount
    type: integer
`,
    });

    await runMigration(ctx);

    // Change column type in DB
    await queryDb(ctx, `ALTER TABLE "${ctx.schema}".orders ALTER COLUMN amount TYPE bigint USING amount::bigint`);

    const report = await ctx.drift();
    const diff = report.items.find(
      (i) => i.type === 'column' && i.object === 'orders.amount' && i.status === 'different',
    );
    expect(diff).toBeDefined();
    expect(diff!.detail).toContain('Type');
  });

  // ─── (5) Missing index detected ───────────────────────────────

  it('(5) missing index detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/docs.yaml': `
table: docs
columns:
  - name: id
    type: serial
    primary_key: true
  - name: title
    type: text
indexes:
  - name: idx_docs_title
    columns: [title]
`,
    });

    await runMigration(ctx);

    // Drop the index manually
    await queryDb(ctx, `DROP INDEX IF EXISTS "${ctx.schema}".idx_docs_title`);

    const report = await ctx.drift();
    const missing = report.items.find(
      (i) => i.type === 'index' && i.object === 'idx_docs_title' && i.status === 'missing_in_db',
    );
    expect(missing).toBeDefined();
  });

  // ─── (6) Enum value difference detected ───────────────────────

  it('(6) enum value difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create enum in the test schema with extra value
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."priority" AS ENUM ('low', 'medium', 'high', 'critical')`);

    writeSchema(ctx.dir, {
      'enums/priority.yaml': `
name: priority
values:
  - low
  - medium
  - high
`,
    });

    const report = await ctx.drift();
    const diff = report.items.find((i) => i.type === 'enum' && i.object === 'priority' && i.status === 'different');
    expect(diff).toBeDefined();
    expect(diff!.detail).toContain('Values differ');
  });

  // ─── (7) Function body difference detected ────────────────────

  it('(7) function body difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/add_nums.yaml': `
name: add_nums
args:
  - name: a
    type: integer
  - name: b
    type: integer
returns: integer
language: sql
body: "SELECT a + b"
`,
    });

    await runMigration(ctx);

    // Alter the function body in DB
    await queryDb(
      ctx,
      `CREATE OR REPLACE FUNCTION "${ctx.schema}".add_nums(a integer, b integer) RETURNS integer LANGUAGE sql AS $$ SELECT a * b $$`,
    );

    const report = await ctx.drift();
    const diff = report.items.find((i) => i.type === 'function' && i.object === 'add_nums' && i.status === 'different');
    expect(diff).toBeDefined();
    expect(diff!.detail).toContain('body');
  });

  // ─── (8) Role attribute difference detected ───────────────────

  it('(8) role attribute difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('drift_role');
    rolesToCleanup.push(roleName);

    writeSchema(ctx.dir, {
      [`roles/${roleName}.yaml`]: `
role: ${roleName}
login: true
createdb: false
`,
    });

    await runMigration(ctx);

    // Change role attribute in DB
    await queryDb(ctx, `ALTER ROLE "${roleName}" CREATEDB`);

    const report = await ctx.drift();
    const diff = report.items.find((i) => i.type === 'role' && i.object === roleName && i.status === 'different');
    expect(diff).toBeDefined();
    expect(diff!.detail).toContain('createdb');
  });

  // ─── (9) Grant difference detected ────────────────────────────

  it('(9) grant difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('drift_grantee');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN CREATE ROLE "${roleName}" NOLOGIN; END IF; END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/grantable.yaml': `
table: grantable
columns:
  - name: id
    type: serial
    primary_key: true
grants:
  - to: ${roleName}
    privileges: [SELECT, INSERT]
`,
    });

    await runMigration(ctx);

    // Revoke one privilege
    await queryDb(ctx, `REVOKE INSERT ON "${ctx.schema}".grantable FROM "${roleName}"`);

    const report = await ctx.drift();
    const grantDrift = report.items.find((i) => i.type === 'grant' && i.object.includes(roleName));
    expect(grantDrift).toBeDefined();
  });

  // ─── (10) Trigger difference detected ─────────────────────────

  it('(10) trigger difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create a trigger function first
    writeSchema(ctx.dir, {
      'functions/noop_trigger.yaml': `
name: noop_trigger
returns: trigger
language: plpgsql
body: "BEGIN RETURN NEW; END;"
`,
      'tables/triggered.yaml': `
table: triggered
columns:
  - name: id
    type: serial
    primary_key: true
  - name: updated_at
    type: timestamptz
triggers:
  - name: trg_noop
    timing: BEFORE
    events: [UPDATE]
    function: noop_trigger
`,
    });

    await runMigration(ctx);

    // Drop the trigger manually
    await queryDb(ctx, `DROP TRIGGER IF EXISTS trg_noop ON "${ctx.schema}".triggered`);

    const report = await ctx.drift();
    const missing = report.items.find(
      (i) => i.type === 'trigger' && i.object === 'triggered.trg_noop' && i.status === 'missing_in_db',
    );
    expect(missing).toBeDefined();
  });

  // ─── (11) Policy difference detected ──────────────────────────

  it('(11) policy difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/secured.yaml': `
table: secured
columns:
  - name: id
    type: serial
    primary_key: true
  - name: owner_id
    type: integer
rls: true
policies:
  - name: owner_only
    for: SELECT
    to: public
    using: "(owner_id = current_setting('app.user_id')::integer)"
`,
    });

    await runMigration(ctx);

    // Drop the policy manually
    await queryDb(ctx, `DROP POLICY IF EXISTS owner_only ON "${ctx.schema}".secured`);

    const report = await ctx.drift();
    const missing = report.items.find(
      (i) => i.type === 'policy' && i.object === 'secured.owner_only' && i.status === 'missing_in_db',
    );
    expect(missing).toBeDefined();
  });

  // ─── (12) Comment difference detected ─────────────────────────

  it('(12) comment difference detected', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/annotated.yaml': `
table: annotated
comment: "This is the annotated table"
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await runMigration(ctx);

    // Change the comment in DB
    await queryDb(ctx, `COMMENT ON TABLE "${ctx.schema}".annotated IS 'Changed comment'`);

    const report = await ctx.drift();
    const diff = report.items.find((i) => i.type === 'comment' && i.object === 'annotated' && i.status === 'different');
    expect(diff).toBeDefined();
  });

  // ─── (13) drift --apply fixes missing column ──────────────────

  it('(13) drift apply fixes missing column', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fixable.yaml': `
table: fixable
columns:
  - name: id
    type: integer
    nullable: false
  - name: name
    type: text
  - name: age
    type: integer
`,
    });

    await runMigration(ctx);

    // Drop a non-PK column
    await queryDb(ctx, `ALTER TABLE "${ctx.schema}".fixable DROP COLUMN age`);

    // Verify drift exists
    const reportBefore = await ctx.drift();
    const missingCol = reportBefore.items.find(
      (i) => i.type === 'column' && i.object === 'fixable.age' && i.status === 'missing_in_db',
    );
    expect(missingCol).toBeDefined();

    // Run migration again to fix (equivalent to drift --apply)
    await runMigration(ctx);

    // Verify drift is resolved
    const reportAfter = await ctx.drift();
    const columnDrift = reportAfter.items.filter((i) => i.type === 'column' && i.object === 'fixable.age');
    expect(columnDrift).toHaveLength(0);
  });

  // ─── (14) drift --apply blocks destructive without --allow-destructive ──

  it('(14) drift apply blocks destructive fix without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/shrinkable.yaml': `
table: shrinkable
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: keep
    type: text
`,
    });

    await runMigration(ctx);

    // Add an extra column (DB has more than YAML)
    await queryDb(ctx, `ALTER TABLE "${ctx.schema}".shrinkable ADD COLUMN extra text`);

    // Re-run migration without allowDestructive — extra column should remain
    await runMigration(ctx);

    const reportBlocked = await ctx.drift();
    const extraStillThere = reportBlocked.items.find(
      (i) => i.type === 'column' && i.object === 'shrinkable.extra' && i.status === 'missing_in_yaml',
    );
    expect(extraStillThere).toBeDefined();

    // Re-run migration WITH allowDestructive — extra column should be dropped
    await runMigration(ctx, { allowDestructive: true });

    const reportFixed = await ctx.drift();
    const extraGone = reportFixed.items.find((i) => i.type === 'column' && i.object === 'shrinkable.extra');
    expect(extraGone).toBeUndefined();
  });
});
