import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Seeds', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) initial seed insert with literal values', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
  - name: name
    type: text
seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    email: 'admin@example.com'
    name: 'Admin'
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'users');

    const result = await queryDb(
      ctx,
      `SELECT id, email, name FROM "${ctx.schema}".users WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].email).toBe('admin@example.com');
    expect(result.rows[0].name).toBe('Admin');
  });

  it('(2) seed upsert — re-run changes values', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/settings.yaml': `
table: settings
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: setting_value
    type: text
seeds:
  - id: '00000000-0000-0000-0000-000000000010'
    setting_value: 'My Site'
`,
    });

    await runMigration(ctx);

    const r1 = await queryDb(
      ctx,
      `SELECT setting_value FROM "${ctx.schema}".settings WHERE id = '00000000-0000-0000-0000-000000000010'`,
    );
    expect(r1.rows[0].setting_value).toBe('My Site');

    // Update the seed value and re-run
    writeSchema(ctx.dir, {
      'tables/settings.yaml': `
table: settings
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: setting_value
    type: text
seeds:
  - id: '00000000-0000-0000-0000-000000000010'
    setting_value: 'Updated Site'
`,
    });

    await runMigration(ctx);

    const r2 = await queryDb(
      ctx,
      `SELECT setting_value FROM "${ctx.schema}".settings WHERE id = '00000000-0000-0000-0000-000000000010'`,
    );
    expect(r2.rows[0].setting_value).toBe('Updated Site');
  });

  it('(3) seeds_on_conflict DO NOTHING — skips existing rows', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/config.yaml': `
table: config
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: config_value
    type: text
seeds:
  - id: '00000000-0000-0000-0000-000000000020'
    config_value: 'production'
seeds_on_conflict: 'DO NOTHING'
`,
    });

    await runMigration(ctx);

    const r1 = await queryDb(
      ctx,
      `SELECT config_value FROM "${ctx.schema}".config WHERE id = '00000000-0000-0000-0000-000000000020'`,
    );
    expect(r1.rows[0].config_value).toBe('production');

    // Manually change the value in the database
    await queryDb(
      ctx,
      `UPDATE "${ctx.schema}".config SET config_value = 'manual_override' WHERE id = '00000000-0000-0000-0000-000000000020'`,
    );

    // Re-run migration — seed should NOT overwrite the manually changed value
    await runMigration(ctx);

    const r2 = await queryDb(
      ctx,
      `SELECT config_value FROM "${ctx.schema}".config WHERE id = '00000000-0000-0000-0000-000000000020'`,
    );
    expect(r2.rows[0].config_value).toBe('manual_override');
  });

  it('(4) seed with UUID primary key', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: label
    type: text
seeds:
  - id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    label: 'Item One'
  - id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'
    label: 'Item Two'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT id::text, label FROM "${ctx.schema}".items ORDER BY label`);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0].label).toBe('Item One');
    expect(result.rows[0].id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(result.rows[1].label).toBe('Item Two');
    expect(result.rows[1].id).toBe('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');
  });

  it('(5) seed with null and boolean values', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/flags.yaml': `
table: flags
columns:
  - name: id
    type: integer
    primary_key: true
  - name: active
    type: boolean
    nullable: false
  - name: description
    type: text
seeds:
  - id: 1
    active: true
    description: null
  - id: 2
    active: false
    description: 'A test flag'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT id, active, description FROM "${ctx.schema}".flags ORDER BY id`);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0].active).toBe(true);
    expect(result.rows[0].description).toBeNull();
    expect(result.rows[1].active).toBe(false);
    expect(result.rows[1].description).toBe('A test flag');
  });

  it('(6) seed with !sql expression', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/events.yaml': `
table: events
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
  - name: created_at
    type: timestamptz
seeds:
  - id: 1
    name: 'startup'
    created_at: !sql now()
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT id, name, created_at FROM "${ctx.schema}".events WHERE id = 1`);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].name).toBe('startup');
    // created_at should be set to a timestamp (not null)
    expect(result.rows[0].created_at).toBeTruthy();
    expect(result.rows[0].created_at instanceof Date).toBe(true);
  });

  it('(8) seeds match by a non-PK unique column when the PK is absent', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/tags.yaml': `
table: tags
columns:
  - name: id
    type: serial
    primary_key: true
  - name: slug
    type: text
    nullable: false
    unique: true
  - name: label
    type: text
    nullable: false
seeds:
  - slug: 'a'
    label: 'Alpha'
  - slug: 'b'
    label: 'Bravo'
`,
    });

    await runMigration(ctx);

    const r1 = await queryDb(ctx, `SELECT slug, label FROM "${ctx.schema}".tags ORDER BY slug`);
    expect(r1.rows).toEqual([
      { slug: 'a', label: 'Alpha' },
      { slug: 'b', label: 'Bravo' },
    ]);

    // Update label for 'a' through the seed — should be applied via slug match,
    // not duplicated.
    writeSchema(ctx.dir, {
      'tables/tags.yaml': `
table: tags
columns:
  - name: id
    type: serial
    primary_key: true
  - name: slug
    type: text
    nullable: false
    unique: true
  - name: label
    type: text
    nullable: false
seeds:
  - slug: 'a'
    label: 'Alpha Prime'
  - slug: 'b'
    label: 'Bravo'
`,
    });

    await runMigration(ctx);

    const r2 = await queryDb(ctx, `SELECT slug, label FROM "${ctx.schema}".tags ORDER BY slug`);
    expect(r2.rows).toEqual([
      { slug: 'a', label: 'Alpha Prime' },
      { slug: 'b', label: 'Bravo' },
    ]);
  });

  it('(9) seeds with no PK/unique match insert once and are idempotent on re-apply', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/log_entries.yaml': `
table: log_entries
columns:
  - name: id
    type: serial
    primary_key: true
  - name: message
    type: text
    nullable: false
  - name: level
    type: text
    nullable: false
    default: "'info'"
seeds:
  - message: 'startup'
  - message: 'ready'
`,
    });

    await runMigration(ctx);

    const r1 = await queryDb(ctx, `SELECT message, level FROM "${ctx.schema}".log_entries ORDER BY id`);
    expect(r1.rows).toEqual([
      { message: 'startup', level: 'info' },
      { message: 'ready', level: 'info' },
    ]);

    // Re-applying the same YAML must NOT insert duplicates.
    await runMigration(ctx);

    const r2 = await queryDb(ctx, `SELECT message FROM "${ctx.schema}".log_entries ORDER BY id`);
    expect(r2.rows.length).toBe(2);
  });

  it('(7) multiple seed rows', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/categories.yaml': `
table: categories
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
    nullable: false
  - name: sort_order
    type: integer
seeds:
  - id: 1
    name: 'Electronics'
    sort_order: 10
  - id: 2
    name: 'Books'
    sort_order: 20
  - id: 3
    name: 'Clothing'
    sort_order: 30
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT id, name, sort_order FROM "${ctx.schema}".categories ORDER BY id`);
    expect(result.rowCount).toBe(3);
    expect(result.rows[0].name).toBe('Electronics');
    expect(result.rows[0].sort_order).toBe(10);
    expect(result.rows[1].name).toBe('Books');
    expect(result.rows[1].sort_order).toBe(20);
    expect(result.rows[2].name).toBe('Clothing');
    expect(result.rows[2].sort_order).toBe(30);
  });
});
