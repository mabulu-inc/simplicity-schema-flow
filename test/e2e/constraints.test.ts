import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Check and Unique Constraints', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a named table-level check constraint', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/chk_named.yaml': `
table: chk_named
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: age
    type: integer
checks:
  - name: chk_age_positive
    expression: "age > 0"
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'chk_named');

    const result = await queryDb(
      ctx,
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'chk_named'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].conname).toBe('chk_age_positive');
    expect(result.rows[0].def).toContain('age > 0');
  });

  it('creates a check constraint with a comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/chk_comment.yaml': `
table: chk_comment
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: quantity
    type: integer
checks:
  - name: chk_qty_positive
    expression: "quantity > 0"
    comment: "Quantity must be positive"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(con.oid, 'pg_constraint') AS comment
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'chk_comment'
         AND con.conname = 'chk_qty_positive'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Quantity must be positive');
  });

  it('creates a column-level check constraint via check sugar', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/chk_sugar.yaml': `
table: chk_sugar
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    check: "length(email) > 0"
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'chk_sugar');

    const result = await queryDb(
      ctx,
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'chk_sugar'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].def).toContain('length(email) > 0');
  });

  it('creates a multi-column unique constraint', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/uq_multi.yaml': `
table: uq_multi
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
  - name: tenant_id
    type: uuid
indexes:
  - columns: [email, tenant_id]
    unique: true
    as_constraint: true
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'uq_multi');

    const result = await queryDb(
      ctx,
      `SELECT con.conname, array_agg(a.attname ORDER BY k.n) AS columns
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'u' AND ns.nspname = $1 AND cls.relname = 'uq_multi'
       GROUP BY con.conname`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].columns).toEqual('{email,tenant_id}');
  });

  it('creates a unique constraint with a custom name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/uq_named.yaml': `
table: uq_named
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: code
    type: text
indexes:
  - columns: [code]
    name: uq_custom_code
    unique: true
    as_constraint: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'u' AND n.nspname = $1 AND cls.relname = 'uq_named'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].conname).toBe('uq_custom_code');
  });

  it('creates a unique constraint with a comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/uq_comment.yaml': `
table: uq_comment
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
  - name: tenant_id
    type: uuid
indexes:
  - columns: [email, tenant_id]
    name: uq_email_tenant
    unique: true
    as_constraint: true
    comment: "One email per tenant"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(con.oid, 'pg_constraint') AS comment
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'u' AND n.nspname = $1 AND cls.relname = 'uq_comment'
         AND con.conname = 'uq_email_tenant'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('One email per tenant');
  });

  it('blocks check constraint drop without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with a check constraint
    writeSchema(ctx.dir, {
      'tables/chk_drop.yaml': `
table: chk_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: age
    type: integer
    nullable: false
checks:
  - name: chk_drop_age_positive
    expression: "age > 0"
`,
    });

    await runMigration(ctx);

    // Verify check constraint exists
    const before = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'chk_drop'`,
      [ctx.schema],
    );

    expect(before.rowCount).toBe(1);
    expect(before.rows[0].conname).toBe('chk_drop_age_positive');

    // Step 2: Remove the check constraint from schema and run without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/chk_drop.yaml': `
table: chk_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: age
    type: integer
    nullable: false
`,
    });

    await runMigration(ctx);

    // Check constraint should still exist because the drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'chk_drop'`,
      [ctx.schema],
    );

    expect(after.rowCount).toBe(1);
    expect(after.rows[0].conname).toBe('chk_drop_age_positive');
  });

  it('blocks unique constraint drop without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with a unique constraint
    writeSchema(ctx.dir, {
      'tables/uq_drop.yaml': `
table: uq_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: code
    type: text
    nullable: false
indexes:
  - columns: [code]
    name: uq_drop_code
    unique: true
    as_constraint: true
`,
    });

    await runMigration(ctx);

    // Verify unique constraint exists
    const before = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'u' AND n.nspname = $1 AND cls.relname = 'uq_drop'`,
      [ctx.schema],
    );

    expect(before.rowCount).toBe(1);
    expect(before.rows[0].conname).toBe('uq_drop_code');

    // Step 2: Remove the unique constraint from schema and run without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/uq_drop.yaml': `
table: uq_drop
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: code
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Unique constraint should still exist because the drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'u' AND n.nspname = $1 AND cls.relname = 'uq_drop'`,
      [ctx.schema],
    );

    expect(after.rowCount).toBe(1);
    expect(after.rows[0].conname).toBe('uq_drop_code');
  });
});
