import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';

/** A logger that keeps warnings so a test can assert on them. */
function capturingLogger(): { logger: ReturnType<typeof createLogger>; warnings: string[] } {
  const warnings: string[] = [];
  const logger = createLogger({
    verbose: false,
    quiet: false,
    json: false,
    color: false,
    stdout: () => {},
    stderr: (msg) => warnings.push(msg),
  });
  return { logger, warnings };
}

const EVENT_TYPES = (name: string, description: string) => `
table: event_types
columns:
  - { name: event_type_id, type: serial, primary_key: true }
  - { name: code, type: text, nullable: false, unique: true }
  - { name: name, type: text, nullable: false }
  - { name: description, type: text }
  - { name: sort_order, type: integer }
seeds:
  - { code: cancelled, name: '${name}', description: '${description}' }
  - { code: delivered, name: Delivered }
`;

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

  it('(2) seeds are insert-only — re-run does not overwrite changed values', async () => {
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

    // Change the seed value and re-run. The row's key already exists, so an
    // insert-only seed leaves the existing value untouched.
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
    expect(r2.rows[0].setting_value).toBe('My Site');
  });

  it('(3) seeds never overwrite manually-changed rows', async () => {
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

    // Change the label for 'a' in the seed and re-run. The slug 'a' already
    // exists, so the insert-only seed matches on it and leaves the row alone —
    // no overwrite, no duplicate.
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
      { slug: 'a', label: 'Alpha' },
      { slug: 'b', label: 'Bravo' },
    ]);
  });

  it('(11) seeds keyed on a partial unique index do not resurrect a soft-deleted builtin', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/roles.yaml': `
table: roles
columns:
  - name: id
    type: serial
    primary_key: true
  - name: code
    type: text
    nullable: false
  - name: deleted_at
    type: timestamptz
indexes:
  - columns: [code]
    unique: true
    where: 'deleted_at IS NULL'
seeds:
  - code: 'admin'
`,
    });

    await runMigration(ctx);

    // The app soft-deletes the builtin role.
    await queryDb(ctx, `UPDATE "${ctx.schema}".roles SET deleted_at = now() WHERE code = 'admin'`);

    // Re-running the seed must not add a second, live 'admin' row.
    await runMigration(ctx);

    const r = await queryDb(ctx, `SELECT count(*)::int AS n FROM "${ctx.schema}".roles WHERE code = 'admin'`);
    expect(r.rows[0].n).toBe(1);
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

  // Issue #53: a jsonb seed supplied as a compact `!sql` expression is stored
  // by Postgres space-normalized (`["a", "b"]`), so a text comparison reported
  // a phantom seed op on every plan. The typed EXCEPT must treat them equal.
  it('(10) jsonb !sql seed does not report perpetual drift', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/system_settings.yaml': `
table: system_settings
columns:
  - name: key
    type: text
    primary_key: true
  - name: value
    type: jsonb
seeds:
  - key: default_delay_reasons
    value: !sql |-
      '["Customer not ready","Late truck arrival","Equipment failure"]'::jsonb
`,
    });

    await runMigration(ctx);

    const stored = await queryDb(
      ctx,
      `SELECT value = '["Customer not ready","Late truck arrival","Equipment failure"]'::jsonb AS eq
       FROM "${ctx.schema}".system_settings WHERE key = 'default_delay_reasons'`,
    );
    expect(stored.rows[0].eq).toBe(true);

    // Re-plan must converge to zero ops despite Postgres re-formatting the jsonb.
    const second = await runMigration(ctx);
    expect(second.executed).toBe(0);

    // The advisory drift report must also be clean.
    const report = await ctx.drift();
    expect(report.items.filter((i) => i.type === 'seed')).toHaveLength(0);
  });

  it('(12) drift is clean for natural-key seeds that omit a bigserial PK (#68)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/api_types.yaml': `
table: api_types
columns:
  - name: api_type_id
    type: bigserial
    primary_key: true
  - name: name
    type: varchar(30)
    nullable: false
    unique: true
seeds:
  - name: digital-fleet-push
  - name: eroad-events
`,
    });

    await runMigration(ctx);

    // Rows are present and correct...
    const rows = await queryDb(ctx, `SELECT name FROM "${ctx.schema}".api_types ORDER BY name`);
    expect(rows.rows).toEqual([{ name: 'digital-fleet-push' }, { name: 'eroad-events' }]);

    // ...so drift must report no seed difference. The seed omits the bigserial
    // PK and matches by the natural unique key `name`; drift must resolve the
    // same match key as apply instead of comparing N desired vs 0 actual.
    const report = await ctx.drift();
    expect(report.items.filter((i) => i.type === 'seed')).toHaveLength(0);
  });

  it('(13) an insert-only table names each seed edit it does not apply (#85)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, { 'tables/event_types.yaml': EVENT_TYPES('Load Cancelled', 'old text') });
    await runMigration(ctx);

    writeSchema(ctx.dir, { 'tables/event_types.yaml': EVENT_TYPES('Load Canceled', 'old text') });
    const { logger, warnings } = capturingLogger();
    await runPipeline(ctx.config, logger);

    const row = await queryDb(ctx, `SELECT name FROM "${ctx.schema}".event_types WHERE code = 'cancelled'`);
    expect(row.rows[0].name).toBe('Load Cancelled');
    const seedWarnings = warnings.filter((w) => w.includes('Seed not applied'));
    expect(seedWarnings).toHaveLength(1);
    expect(seedWarnings[0]).toContain('event_types[code=cancelled].name');
    expect(seedWarnings[0]).toContain('Load Cancelled');
    expect(seedWarnings[0]).toContain('Load Canceled');
    expect(seedWarnings[0]).toContain('seeds_authoritative');
  });

  it('(14) seeds_authoritative updates existing rows to the YAML and leaves other columns alone (#85)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const authoritative = (name: string, description: string) =>
      EVENT_TYPES(name, description).replace('table: event_types', 'table: event_types\nseeds_authoritative: true');
    writeSchema(ctx.dir, { 'tables/event_types.yaml': authoritative('Load Cancelled', 'old text') });
    await runMigration(ctx);
    // A column the YAML never seeds belongs to the database.
    await queryDb(ctx, `UPDATE "${ctx.schema}".event_types SET sort_order = 9 WHERE code = 'cancelled'`);

    writeSchema(ctx.dir, { 'tables/event_types.yaml': authoritative('Load Canceled', 'new text') });
    const { logger, warnings } = capturingLogger();
    const result = await runPipeline(ctx.config, logger);

    const rows = await queryDb(
      ctx,
      `SELECT code, name, description, sort_order FROM "${ctx.schema}".event_types ORDER BY code`,
    );
    expect(rows.rows).toEqual([
      { code: 'cancelled', name: 'Load Canceled', description: 'new text', sort_order: 9 },
      { code: 'delivered', name: 'Delivered', description: null, sort_order: null },
    ]);
    const seedOp = result.executedOperations.find((op) => op.type === 'seed_table');
    expect(seedOp?.seedResult).toEqual({ inserted: 0, updated: 1, unchanged: 1 });
    expect(warnings.filter((w) => w.includes('Seed not applied'))).toHaveLength(0);

    // Converged: the next apply has no seed work and drift is clean.
    const again = await runPipeline(ctx.config, capturingLogger().logger);
    expect(again.executedOperations.filter((op) => op.type === 'seed_table')).toHaveLength(0);
    const report = await ctx.drift();
    expect(report.items.filter((i) => i.type === 'seed')).toHaveLength(0);
  });

  it('(15) seeds_authoritative without a match key is rejected at plan time (#85)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    writeSchema(ctx.dir, {
      'tables/labels.yaml': `
table: labels
seeds_authoritative: true
columns:
  - { name: label_id, type: serial, primary_key: true }
  - { name: text, type: text }
seeds:
  - { text: hello }
`,
    });
    await expect(runPipeline(ctx.config, capturingLogger().logger)).rejects.toThrow(
      /labels.*seeds_authoritative.*no match key/,
    );
  });

  it('(16) an authoritative update on an audited table needs an actor for the seed transaction (#85)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    // An audit-style trigger: stamps updated_by from the actor setting on UPDATE,
    // NULL when there is none, like @smplcty/schema-std's audit_stamp in lenient mode.
    const schema = (name: string) => ({
      'functions/stamp_actor.yaml': `
name: stamp_actor
language: plpgsql
returns: trigger
body: |
  BEGIN
    NEW.updated_by := NULLIF(current_setting('app.actor_id', true), '')::integer;
    RETURN NEW;
  END;
`,
      'tables/event_types.yaml': `
table: event_types
seeds_authoritative: true
columns:
  - { name: event_type_id, type: serial, primary_key: true }
  - { name: code, type: text, nullable: false, unique: true }
  - { name: name, type: text, nullable: false }
  - { name: updated_by, type: integer, nullable: false, default: '0' }
triggers:
  - { name: event_types_stamp, timing: BEFORE, events: [UPDATE], function: stamp_actor }
seeds:
  - { code: cancelled, name: '${name}' }
`,
    });
    writeSchema(ctx.dir, schema('Load Cancelled'));
    await runMigration(ctx);

    writeSchema(ctx.dir, schema('Load Canceled'));
    await expect(runPipeline(ctx.config, capturingLogger().logger)).rejects.toThrow(
      /set "updated_by" to NULL while updating seeded rows.*perTxSqlPath/s,
    );

    const hook = path.join(ctx.dir, 'actor.sql');
    fs.writeFileSync(hook, `SELECT set_config('app.actor_id', '7', true);`);
    await runPipeline({ ...ctx.config, perTxSqlPath: hook }, capturingLogger().logger);
    const row = await queryDb(ctx, `SELECT name, updated_by FROM "${ctx.schema}".event_types`);
    expect(row.rows).toEqual([{ name: 'Load Canceled', updated_by: 7 }]);
  });
});
