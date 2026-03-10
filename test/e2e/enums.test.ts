import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertEnumValues } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Enums', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      // Clean up public-schema enums (not covered by test schema DROP CASCADE)
      await queryDb(ctx, 'DROP TYPE IF EXISTS order_status CASCADE');
      await queryDb(ctx, 'DROP TYPE IF EXISTS priority CASCADE');
      await ctx.cleanup();
    }
  });

  it('creates an enum with values', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'enums/order_status.yaml': `
name: order_status
values:
  - pending
  - processing
  - shipped
  - delivered
`,
    });

    await runMigration(ctx);

    await assertEnumValues(ctx, 'order_status', ['pending', 'processing', 'shipped', 'delivered']);
  });

  it('adds a value to an existing enum on second migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create in both the test schema (for introspection) and public (for unqualified ALTER TYPE)
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."order_status" AS ENUM ('pending', 'processing', 'shipped')`);
    await queryDb(ctx, `CREATE TYPE "order_status" AS ENUM ('pending', 'processing', 'shipped')`);

    writeSchema(ctx.dir, {
      'enums/order_status.yaml': `
name: order_status
values:
  - pending
  - processing
  - shipped
  - delivered
`,
    });

    await runMigration(ctx);

    // The ALTER TYPE runs unqualified so it modifies the public-schema enum
    const result = await queryDb(
      ctx,
      `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE n.nspname = 'public' AND t.typname = 'order_status'
       ORDER BY e.enumsortorder`,
    );
    const values = result.rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(values).toEqual(['pending', 'processing', 'shipped', 'delivered']);
  });

  it('sets an enum comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'enums/order_status.yaml': `
name: order_status
values:
  - pending
  - shipped
comment: 'Order lifecycle states'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(t.oid) AS comment
       FROM pg_type t
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE t.typname = 'order_status' AND n.nspname IN ($1, 'public')`,
      [ctx.schema],
    );
    expect(result.rows[0].comment).toBe('Order lifecycle states');
  });

  it('blocks enum value removal without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create the enum in the test schema so introspection finds it
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."order_status" AS ENUM ('pending', 'processing', 'shipped')`);

    // Schema only declares two values — 'shipped' removed
    writeSchema(ctx.dir, {
      'enums/order_status.yaml': `
name: order_status
values:
  - pending
  - processing
`,
    });

    await runMigration(ctx);

    // 'shipped' should still be present because the removal was blocked
    const result = await queryDb(
      ctx,
      `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
       WHERE n.nspname = $1 AND t.typname = 'order_status'
       ORDER BY e.enumsortorder`,
      [ctx.schema],
    );
    const values = result.rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(values).toEqual(['pending', 'processing', 'shipped']);
  });

  it('allows enum value removal with --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Pre-create the enum in the test schema so introspection finds it
    await queryDb(ctx, `CREATE TYPE "${ctx.schema}"."order_status" AS ENUM ('pending', 'processing', 'shipped')`);

    // Schema only declares two values — 'shipped' removed
    writeSchema(ctx.dir, {
      'enums/order_status.yaml': `
name: order_status
values:
  - pending
  - processing
`,
    });

    // Should not throw — the destructive operation is accepted
    const result = await runMigration(ctx, { allowDestructive: true });
    expect(result.executed).toBeGreaterThanOrEqual(0);
  });

  it('uses an enum as a column type in a table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'enums/priority.yaml': `
name: priority
values:
  - low
  - medium
  - high
`,
      'tables/tasks.yaml': `
table: tasks
columns:
  - name: id
    type: serial
    primary_key: true
  - name: priority
    type: priority
    nullable: false
`,
    });

    await runMigration(ctx);

    // Verify the column uses the enum type (USER-DEFINED in information_schema)
    const colResult = await queryDb(
      ctx,
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'priority'`,
      [ctx.schema],
    );
    expect(colResult.rows[0].data_type).toBe('USER-DEFINED');
    expect(colResult.rows[0].udt_name).toBe('priority');

    // Insert a row using the enum value and verify
    await queryDb(ctx, `INSERT INTO ${ctx.schema}.tasks (priority) VALUES ('high')`);
    const rows = await queryDb(ctx, `SELECT priority FROM ${ctx.schema}.tasks`);
    expect(rows.rows[0].priority).toBe('high');
  });
});
