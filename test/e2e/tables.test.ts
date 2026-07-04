import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists, getColumnInfo } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Tables', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a table with all common column types', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/all_types.yaml': `
table: all_types
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: text_col
    type: text
  - name: varchar_col
    type: varchar(255)
  - name: int_col
    type: integer
  - name: bigint_col
    type: bigint
  - name: numeric_col
    type: numeric
  - name: bool_col
    type: boolean
  - name: ts_col
    type: timestamptz
  - name: jsonb_col
    type: jsonb
  - name: bytea_col
    type: bytea
  - name: text_arr_col
    type: text[]
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'all_types');

    const types: Record<string, string> = {
      id: 'uuid',
      text_col: 'text',
      varchar_col: 'character varying',
      int_col: 'integer',
      bigint_col: 'bigint',
      numeric_col: 'numeric',
      bool_col: 'boolean',
      ts_col: 'timestamp with time zone',
      jsonb_col: 'jsonb',
      bytea_col: 'bytea',
      text_arr_col: 'ARRAY',
    };

    for (const [col, expectedType] of Object.entries(types)) {
      const info = await getColumnInfo(ctx, 'all_types', col);
      expect(info.type, `column ${col}`).toBe(expectedType);
    }
  });

  it('changes a column type with a non-auto-castable cast (text → jsonb), preserving data', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First run: create the column as text and seed a row.
    writeSchema(ctx.dir, {
      'tables/casts.yaml': `
table: casts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: format
    type: text
    nullable: true
`,
    });
    await runMigration(ctx);
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".casts (format) VALUES ('{"a":1}')`);

    // Second run: retype the column to jsonb. Postgres cannot assignment-cast
    // text → jsonb, so this only works if the planner emits a USING clause.
    writeSchema(ctx.dir, {
      'tables/casts.yaml': `
table: casts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: format
    type: jsonb
    nullable: true
`,
    });
    await runMigration(ctx);

    const info = await getColumnInfo(ctx, 'casts', 'format');
    expect(info.type).toBe('jsonb');

    // Existing data survived the cast.
    const rows = await queryDb(ctx, `SELECT format FROM "${ctx.schema}".casts`);
    expect(rows.rows[0].format).toEqual({ a: 1 });
  });

  it('applies a custom using: expression on a type change (empty string → NULL jsonb)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/custom_cast.yaml': `
table: custom_cast
columns:
  - name: id
    type: serial
    primary_key: true
  - name: format
    type: text
    nullable: true
`,
    });
    await runMigration(ctx);
    // An empty string is not valid JSON — the default "format"::jsonb cast would
    // fail on this row, so the custom using: expression is required.
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".custom_cast (format) VALUES (''), ('{"b":2}')`);

    writeSchema(ctx.dir, {
      'tables/custom_cast.yaml': `
table: custom_cast
columns:
  - name: id
    type: serial
    primary_key: true
  - name: format
    type: jsonb
    nullable: true
    using: "NULLIF(format, '')::jsonb"
`,
    });
    await runMigration(ctx);

    const info = await getColumnInfo(ctx, 'custom_cast', 'format');
    expect(info.type).toBe('jsonb');

    const rows = await queryDb(ctx, `SELECT format FROM "${ctx.schema}".custom_cast ORDER BY id`);
    expect(rows.rows[0].format).toBeNull();
    expect(rows.rows[1].format).toEqual({ b: 2 });
  });

  it('sets column defaults (literal and expression)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/defaults_test.yaml': `
table: defaults_test
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: created_at
    type: timestamptz
    default: now()
  - name: status
    type: text
    default: "'active'"
  - name: count
    type: integer
    default: "0"
`,
    });

    await runMigration(ctx);

    const idInfo = await getColumnInfo(ctx, 'defaults_test', 'id');
    expect(idInfo.default).toContain('gen_random_uuid');

    const createdInfo = await getColumnInfo(ctx, 'defaults_test', 'created_at');
    expect(createdInfo.default).toContain('now');

    const statusInfo = await getColumnInfo(ctx, 'defaults_test', 'status');
    expect(statusInfo.default).toContain('active');

    const countInfo = await getColumnInfo(ctx, 'defaults_test', 'count');
    expect(countInfo.default).toContain('0');
  });

  it('handles nullable vs non-nullable columns', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/nullable_test.yaml': `
table: nullable_test
columns:
  - name: id
    type: serial
    primary_key: true
  - name: required_col
    type: text
    nullable: false
  - name: optional_col
    type: text
    nullable: true
`,
    });

    await runMigration(ctx);

    const required = await getColumnInfo(ctx, 'nullable_test', 'required_col');
    expect(required.nullable).toBe(false);

    const optional = await getColumnInfo(ctx, 'nullable_test', 'optional_col');
    expect(optional.nullable).toBe(true);
  });

  it('creates a single-column primary key', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/single_pk.yaml': `
table: single_pk
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

    const result = await queryDb(
      ctx,
      `SELECT a.attname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'p' AND n.nspname = $1 AND c.conrelid = ($1 || '.single_pk')::regclass
       ORDER BY a.attnum`,
      [ctx.schema],
    );
    expect(result.rows.map((r: { attname: string }) => r.attname)).toEqual(['id']);
  });

  it('creates a composite primary key', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/composite_pk.yaml': `
table: composite_pk
columns:
  - name: tenant_id
    type: uuid
  - name: user_id
    type: uuid
  - name: name
    type: text
primary_key: [tenant_id, user_id]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT a.attname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'p' AND n.nspname = $1 AND c.conrelid = ($1 || '.composite_pk')::regclass
       ORDER BY array_position(c.conkey, a.attnum)`,
      [ctx.schema],
    );
    expect(result.rows.map((r: { attname: string }) => r.attname)).toEqual(['tenant_id', 'user_id']);
  });

  it('creates a custom primary key name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/custom_pk.yaml': `
table: custom_pk
columns:
  - name: id
    type: uuid
    default: gen_random_uuid()
primary_key: [id]
primary_key_name: pk_custom_id
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'p' AND n.nspname = $1 AND c.conrelid = ($1 || '.custom_pk')::regclass`,
      [ctx.schema],
    );
    expect(result.rows[0].conname).toBe('pk_custom_id');
  });

  it('creates a column-level unique constraint', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/unique_col.yaml': `
table: unique_col
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    unique: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'u' AND n.nspname = $1 AND c.conrelid = ($1 || '.unique_col')::regclass`,
      [ctx.schema],
    );
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('creates a unique constraint with custom name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/unique_named.yaml': `
table: unique_named
columns:
  - name: id
    type: serial
    primary_key: true
  - name: code
    type: text
    unique: true
    unique_name: uq_unique_named_code
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'u' AND n.nspname = $1 AND c.conrelid = ($1 || '.unique_named')::regclass`,
      [ctx.schema],
    );
    expect(result.rows[0].conname).toBe('uq_unique_named_code');
  });

  it('sets column comments', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/col_comments.yaml': `
table: col_comments
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    comment: "User's primary email address"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT col_description(($1 || '.col_comments')::regclass, a.attnum) AS comment
       FROM pg_attribute a
       WHERE a.attrelid = ($1 || '.col_comments')::regclass AND a.attname = 'email'`,
      [ctx.schema],
    );
    expect(result.rows[0].comment).toBe("User's primary email address");
  });

  it('sets a table comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/table_comment.yaml': `
table: table_comment
columns:
  - name: id
    type: serial
    primary_key: true
comment: 'Core accounts table'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT obj_description(($1 || '.table_comment')::regclass) AS comment`, [
      ctx.schema,
    ]);
    expect(result.rows[0].comment).toBe('Core accounts table');
  });

  it('creates a generated column', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/generated_col.yaml': `
table: generated_col
columns:
  - name: id
    type: serial
    primary_key: true
  - name: price
    type: numeric
    default: "0"
  - name: quantity
    type: integer
    default: "1"
  - name: total
    type: numeric
    generated: "price * quantity"
`,
    });

    await runMigration(ctx);

    const info = await getColumnInfo(ctx, 'generated_col', 'total');
    expect(info.generated).toContain('price');
    expect(info.generated).toContain('quantity');

    // Insert a row and verify the generated value
    await queryDb(ctx, `INSERT INTO ${ctx.schema}.generated_col (price, quantity) VALUES (10, 5)`);
    const rows = await queryDb(ctx, `SELECT total FROM ${ctx.schema}.generated_col`);
    expect(Number(rows.rows[0].total)).toBe(50);
  });

  it('supports description as alias for comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/desc_alias.yaml': `
table: desc_alias
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    description: 'The display name'
description: 'Table using description alias'
`,
    });

    await runMigration(ctx);

    // Check table comment
    const tableResult = await queryDb(ctx, `SELECT obj_description(($1 || '.desc_alias')::regclass) AS comment`, [
      ctx.schema,
    ]);
    expect(tableResult.rows[0].comment).toBe('Table using description alias');

    // Check column comment
    const colResult = await queryDb(
      ctx,
      `SELECT col_description(($1 || '.desc_alias')::regclass, a.attnum) AS comment
       FROM pg_attribute a
       WHERE a.attrelid = ($1 || '.desc_alias')::regclass AND a.attname = 'name'`,
      [ctx.schema],
    );
    expect(colResult.rows[0].comment).toBe('The display name');
  });
});
