import { describe, it, expect, afterEach } from 'vitest';
import {
  useTestProject,
  writeSchema,
  runMigration,
  queryDb,
  assertTableExists,
  assertColumnExists,
  assertEnumValues,
  getColumnInfo,
} from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E smoke tests', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a simple table and verifies it exists', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
`,
    });

    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    await assertTableExists(ctx, 'users');
    await assertColumnExists(ctx, 'users', 'id');
    await assertColumnExists(ctx, 'users', 'email');
  });

  it('verifies column info returns correct metadata', async () => {
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
  - name: price
    type: numeric
    nullable: true
    default: "0"
`,
    });

    await runMigration(ctx);

    const nameInfo = await getColumnInfo(ctx, 'products', 'name');
    expect(nameInfo.type).toBe('text');
    expect(nameInfo.nullable).toBe(false);

    const priceInfo = await getColumnInfo(ctx, 'products', 'price');
    expect(priceInfo.nullable).toBe(true);
  });

  it('verifies enum values', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'enums/status.yaml': `
name: status
values:
  - active
  - inactive
  - archived
`,
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: status
    type: status
    nullable: false
`,
    });

    await runMigration(ctx);

    await assertEnumValues(ctx, 'status', ['active', 'inactive', 'archived']);

    // Clean up public-schema enum (not covered by test schema DROP CASCADE)
    await queryDb(ctx, 'DROP TYPE IF EXISTS status CASCADE');
  });

  it('queryDb executes arbitrary SQL', async () => {
    ctx = await useTestProject(DATABASE_URL);

    const result = await queryDb(ctx, 'SELECT 1 + 1 AS sum');
    expect(result.rows[0].sum).toBe(2);
  });

  it('assertTableExists throws for non-existent table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    await expect(assertTableExists(ctx, 'nonexistent')).rejects.toThrow('Expected table "nonexistent" to exist');
  });

  it('assertColumnExists throws for non-existent column', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/things.yaml': `
table: things
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await runMigration(ctx);

    await expect(assertColumnExists(ctx, 'things', 'missing')).rejects.toThrow(
      'Expected column "missing" on table "things"',
    );
  });

  it('getColumnInfo throws for non-existent column', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await runMigration(ctx);

    await expect(getColumnInfo(ctx, 'widgets', 'missing')).rejects.toThrow(
      'Column "missing" not found on table "widgets"',
    );
  });
});
