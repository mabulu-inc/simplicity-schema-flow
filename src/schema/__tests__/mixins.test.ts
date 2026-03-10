import { describe, it, expect } from 'vitest';
import { applyMixins, loadMixins, type MixinRegistry } from '../mixins.js';
import { parseMixin, parseTable } from '../parser.js';

// ─── Helper: build a registry from mixin YAML strings ─────────

function registryFrom(...yamls: string[]): MixinRegistry {
  const mixins = yamls.map((y) => parseMixin(y));
  return loadMixins(mixins);
}

// ─── loadMixins ────────────────────────────────────────────────

describe('loadMixins', () => {
  it('creates a registry keyed by mixin name', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
`);
    expect(reg.has('timestamps')).toBe(true);
    expect(reg.get('timestamps')!.mixin).toBe('timestamps');
  });

  it('throws on duplicate mixin names', () => {
    const m1 = parseMixin('mixin: timestamps\ncolumns:\n  - name: a\n    type: text');
    const m2 = parseMixin('mixin: timestamps\ncolumns:\n  - name: b\n    type: text');
    expect(() => loadMixins([m1, m2])).toThrow(/duplicate mixin.*timestamps/i);
  });
});

// ─── applyMixins — column merging ──────────────────────────────

describe('applyMixins — columns', () => {
  it('merges mixin columns into table', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
    primary_key: true
`);
    const result = applyMixins(table, reg);
    expect(result.columns).toHaveLength(3);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at']);
  });

  it('does not duplicate columns already defined on the table', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    default: now()
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
  - name: created_at
    type: timestamptz
    default: "clock_timestamp()"
`);
    const result = applyMixins(table, reg);
    // Table's own column wins — not overwritten
    expect(result.columns).toHaveLength(2);
    expect(result.columns.find((c) => c.name === 'created_at')!.default).toBe('clock_timestamp()');
  });
});

// ─── applyMixins — {table} placeholder substitution ────────────

describe('applyMixins — {table} placeholder', () => {
  it('replaces {table} in trigger names', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: updated_at
    type: timestamptz
triggers:
  - name: set_{table}_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.triggers![0].name).toBe('set_orders_updated_at');
  });

  it('replaces {table} in trigger when clause', () => {
    const reg = registryFrom(`
mixin: audit
triggers:
  - name: audit_{table}
    timing: AFTER
    events: [INSERT, UPDATE, DELETE]
    function: audit_trigger
    for_each: ROW
    when: "current_setting('app.{table}_audit') = 'on'"
`);
    const table = parseTable(`
table: users
mixins:
  - audit
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.triggers![0].when).toBe("current_setting('app.users_audit') = 'on'");
  });

  it('replaces {table} in index names', () => {
    const reg = registryFrom(`
mixin: soft_delete
columns:
  - name: deleted_at
    type: timestamptz
indexes:
  - name: idx_{table}_not_deleted
    columns: [deleted_at]
    where: "deleted_at IS NULL"
`);
    const table = parseTable(`
table: products
mixins:
  - soft_delete
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.indexes![0].name).toBe('idx_products_not_deleted');
  });

  it('replaces {table} in check constraint names and expressions', () => {
    const reg = registryFrom(`
mixin: with_check
checks:
  - name: chk_{table}_positive
    expression: "{table}_count > 0"
`);
    const table = parseTable(`
table: items
mixins:
  - with_check
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.checks![0].name).toBe('chk_items_positive');
    expect(result.checks![0].expression).toBe('items_count > 0');
  });

  it('replaces {table} in policy names and expressions', () => {
    const reg = registryFrom(`
mixin: rls_base
policies:
  - name: "{table}_owner_access"
    for: ALL
    to: app_user
    using: "owner_id = current_setting('app.user_id')::uuid"
`);
    const table = parseTable(`
table: documents
mixins:
  - rls_base
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.policies![0].name).toBe('documents_owner_access');
  });
});

// ─── applyMixins — merging indexes, checks, triggers, policies, grants ──

describe('applyMixins — array merging', () => {
  it('merges indexes from mixin', () => {
    const reg = registryFrom(`
mixin: indexed
indexes:
  - columns: [created_at]
  - columns: [updated_at]
`);
    const table = parseTable(`
table: orders
mixins:
  - indexed
columns:
  - name: id
    type: uuid
indexes:
  - columns: [email]
    unique: true
`);
    const result = applyMixins(table, reg);
    expect(result.indexes).toHaveLength(3);
    expect(result.indexes![0].columns).toEqual(['email']);
  });

  it('merges triggers from mixin', () => {
    const reg = registryFrom(`
mixin: timestamps
triggers:
  - name: set_updated
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers![0].name).toBe('set_updated');
  });

  it('merges policies from mixin', () => {
    const reg = registryFrom(`
mixin: rls
policies:
  - name: owner_policy
    for: SELECT
    to: app_user
    using: "owner_id = current_user_id()"
`);
    const table = parseTable(`
table: orders
mixins:
  - rls
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.policies).toHaveLength(1);
  });

  it('merges grants from mixin', () => {
    const reg = registryFrom(`
mixin: readable
grants:
  - to: app_readonly
    privileges: [SELECT]
`);
    const table = parseTable(`
table: orders
mixins:
  - readable
columns:
  - name: id
    type: uuid
grants:
  - to: app_admin
    privileges: [ALL]
`);
    const result = applyMixins(table, reg);
    expect(result.grants).toHaveLength(2);
  });

  it('merges checks from mixin', () => {
    const reg = registryFrom(`
mixin: validated
checks:
  - name: chk_positive
    expression: "amount > 0"
`);
    const table = parseTable(`
table: orders
mixins:
  - validated
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.checks).toHaveLength(1);
    expect(result.checks![0].name).toBe('chk_positive');
  });
});

// ─── applyMixins — rls/force_rls from mixin ─────────────────────

describe('applyMixins — rls/force_rls', () => {
  it('sets rls and force_rls from mixin', () => {
    const reg = registryFrom(`
mixin: secure
rls: true
force_rls: true
`);
    const table = parseTable(`
table: orders
mixins:
  - secure
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.rls).toBe(true);
    expect(result.force_rls).toBe(true);
  });

  it('does not override table-level rls when mixin omits it', () => {
    const reg = registryFrom(`
mixin: basic
columns:
  - name: created_at
    type: timestamptz
`);
    const table = parseTable(`
table: orders
mixins:
  - basic
columns:
  - name: id
    type: uuid
rls: true
force_rls: true
`);
    const result = applyMixins(table, reg);
    expect(result.rls).toBe(true);
    expect(result.force_rls).toBe(true);
  });
});

// ─── applyMixins — multiple mixins ─────────────────────────────

describe('applyMixins — multiple mixins', () => {
  it('applies mixins in order', () => {
    const reg = registryFrom(
      `
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
  - name: updated_at
    type: timestamptz
`,
      `
mixin: soft_delete
columns:
  - name: deleted_at
    type: timestamptz
`,
    );
    const table = parseTable(`
table: orders
mixins:
  - timestamps
  - soft_delete
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at', 'deleted_at']);
  });
});

// ─── applyMixins — error handling ──────────────────────────────

describe('applyMixins — errors', () => {
  it('throws if referenced mixin not found', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
`);
    const table = parseTable(`
table: orders
mixins:
  - nonexistent
columns:
  - name: id
    type: uuid
`);
    expect(() => applyMixins(table, reg)).toThrow(/mixin.*nonexistent.*not found/i);
  });

  it('returns table unchanged if no mixins referenced', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
`);
    const table = parseTable(`
table: orders
columns:
  - name: id
    type: uuid
`);
    const result = applyMixins(table, reg);
    expect(result.columns).toHaveLength(1);
    expect(result).toEqual(table);
  });
});

// ─── applyMixins — immutability ────────────────────────────────

describe('applyMixins — immutability', () => {
  it('does not mutate the original table', () => {
    const reg = registryFrom(`
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
`);
    const originalColumns = [...table.columns];
    applyMixins(table, reg);
    expect(table.columns).toEqual(originalColumns);
  });

  it('does not mutate the mixin schema', () => {
    const reg = registryFrom(`
mixin: timestamps
triggers:
  - name: set_{table}_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
`);
    const table = parseTable(`
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
`);
    applyMixins(table, reg);
    // Original mixin trigger should still have {table}
    expect(reg.get('timestamps')!.triggers![0].name).toBe('set_{table}_updated_at');
  });
});
