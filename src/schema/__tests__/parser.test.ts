import { describe, it, expect } from 'vitest';
import {
  parseTable,
  parseEnum,
  parseFunction,
  parseView,
  parseRole,
  parseExtensions,
  parseMixin,
  parseSchemaFile,
} from '../parser.js';

// ─── Table Parsing ──────────────────────────────────────────────

describe('parseTable', () => {
  it('parses a minimal table', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
`;
    const result = parseTable(yaml);
    expect(result.table).toBe('users');
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0]).toEqual({
      name: 'id',
      type: 'uuid',
      primary_key: true,
    });
  });

  it('parses a full table with all features', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: user_id
    type: uuid
    nullable: false
    references:
      table: users
      column: id
      on_delete: CASCADE
      on_update: NO ACTION
      deferrable: true
      initially_deferred: false
  - name: total
    type: numeric
    generated: "price * quantity"
  - name: new_email
    type: text
    expand:
      from: email
      transform: "lower(email)"
primary_key: [id]
indexes:
  - columns: [user_id]
  - name: idx_orders_total
    columns: [total]
    unique: true
    method: btree
    where: "total > 0"
    include: [user_id]
    opclass: numeric_ops
  - columns: [user_id, id]
    name: uq_orders_user
    unique: true
    as_constraint: true
checks:
  - name: positive_total
    expression: "total >= 0"
    comment: "Total must be non-negative"
triggers:
  - name: set_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
    when: "OLD.* IS DISTINCT FROM NEW.*"
policies:
  - name: own_orders
    for: SELECT
    to: app_user
    using: "user_id = current_setting('app.user_id')::uuid"
    check: "user_id = current_setting('app.user_id')::uuid"
    permissive: true
grants:
  - to: app_readonly
    privileges: [SELECT]
    columns: [id, user_id]
    with_grant_option: false
prechecks:
  - name: no_orphans
    query: "SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)"
    message: "Orphaned orders exist"
seeds:
  - id: "00000000-0000-0000-0000-000000000001"
    total: 100
mixins:
  - timestamps
comment: "Order records"
`;
    const result = parseTable(yaml);
    expect(result.table).toBe('orders');
    expect(result.columns).toHaveLength(4);
    expect(result.columns[1].references).toEqual({
      table: 'users',
      column: 'id',
      on_delete: 'CASCADE',
      on_update: 'NO ACTION',
      deferrable: true,
      initially_deferred: false,
    });
    expect(result.columns[2].generated).toBe('price * quantity');
    expect(result.columns[3].expand).toEqual({ from: 'email', transform: 'lower(email)' });
    expect(result.primary_key).toEqual(['id']);
    expect(result.indexes).toHaveLength(3);
    expect(result.indexes![1]).toEqual({
      name: 'idx_orders_total',
      columns: ['total'],
      unique: true,
      method: 'btree',
      where: 'total > 0',
      include: ['user_id'],
      opclass: 'numeric_ops',
    });
    expect(result.indexes![2]).toEqual({
      name: 'uq_orders_user',
      columns: ['user_id', 'id'],
      unique: true,
      as_constraint: true,
    });
    expect(result.checks).toHaveLength(1);
    expect(result.triggers).toHaveLength(1);
    expect(result.policies).toHaveLength(1);
    expect(result.grants).toHaveLength(1);
    expect(result.prechecks).toHaveLength(1);
    expect(result.seeds).toHaveLength(1);
    expect(result.mixins).toEqual(['timestamps']);
    expect(result.comment).toBe('Order records');
  });

  it('parses cross-schema FK reference', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
  - name: user_id
    type: uuid
    references:
      table: users
      column: id
      schema: auth
      on_delete: CASCADE
`;
    const result = parseTable(yaml);
    expect(result.columns[1].references).toEqual({
      table: 'users',
      column: 'id',
      schema: 'auth',
      on_delete: 'CASCADE',
    });
  });

  it('omits schema from FK when not specified', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
  - name: user_id
    type: uuid
    references:
      table: users
      column: id
`;
    const result = parseTable(yaml);
    expect(result.columns[1].references!.schema).toBeUndefined();
  });

  it('parses expand with reverse and batch_size', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
      reverse: "email"
      batch_size: 5000
`;
    const result = parseTable(yaml);
    expect(result.columns[1].expand).toEqual({
      from: 'email',
      transform: 'lower(email)',
      reverse: 'email',
      batch_size: 5000,
    });
  });

  it('omits reverse and batch_size from expand when not specified', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
`;
    const result = parseTable(yaml);
    expect(result.columns[1].expand).toEqual({
      from: 'email',
      transform: 'lower(email)',
    });
    expect(result.columns[1].expand!.reverse).toBeUndefined();
    expect(result.columns[1].expand!.batch_size).toBeUndefined();
  });

  it('parses rls and force_rls booleans', () => {
    const yaml = `
table: secure
columns:
  - name: id
    type: uuid
rls: true
force_rls: true
`;
    const result = parseTable(yaml);
    expect(result.rls).toBe(true);
    expect(result.force_rls).toBe(true);
  });

  it('omits rls and force_rls when not specified', () => {
    const yaml = `
table: basic
columns:
  - name: id
    type: uuid
`;
    const result = parseTable(yaml);
    expect(result.rls).toBeUndefined();
    expect(result.force_rls).toBeUndefined();
  });

  it('throws if table name is missing', () => {
    const yaml = `
columns:
  - name: id
    type: uuid
`;
    expect(() => parseTable(yaml)).toThrow(/table/i);
  });

  it('throws if columns is missing', () => {
    const yaml = `
table: users
`;
    expect(() => parseTable(yaml)).toThrow(/columns/i);
  });

  it('throws if columns is empty', () => {
    const yaml = `
table: users
columns: []
`;
    expect(() => parseTable(yaml)).toThrow(/columns/i);
  });

  it('throws if a column is missing name', () => {
    const yaml = `
table: users
columns:
  - type: uuid
`;
    expect(() => parseTable(yaml)).toThrow(/name/i);
  });

  it('throws if a column is missing type', () => {
    const yaml = `
table: users
columns:
  - name: id
`;
    expect(() => parseTable(yaml)).toThrow(/type/i);
  });

  it('applies defaults to optional column fields', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
`;
    const result = parseTable(yaml);
    const col = result.columns[0];
    // Optional fields should be undefined when not specified
    expect(col.nullable).toBeUndefined();
    expect(col.primary_key).toBeUndefined();
    expect(col.unique).toBeUndefined();
    expect(col.default).toBeUndefined();
  });

  it('throws on invalid trigger timing', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
triggers:
  - name: bad_trigger
    timing: WRONG
    events: [INSERT]
    function: fn
`;
    expect(() => parseTable(yaml)).toThrow(/timing/i);
  });

  it('throws on invalid policy command', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
policies:
  - name: bad_policy
    for: WRONG
    to: role
    using: "true"
`;
    expect(() => parseTable(yaml)).toThrow(/for/i);
  });

  it('generates check constraint from column-level check sugar', () => {
    const yaml = `
table: users
columns:
  - name: email
    type: text
    check: "length(email) > 0"
`;
    const result = parseTable(yaml);
    expect(result.columns[0].check).toBe('length(email) > 0');
    expect(result.checks).toHaveLength(1);
    expect(result.checks![0]).toEqual({
      name: 'chk_users_email',
      expression: 'length(email) > 0',
    });
  });

  it('merges column-level check sugar with explicit checks', () => {
    const yaml = `
table: orders
columns:
  - name: total
    type: numeric
    check: "total >= 0"
checks:
  - name: valid_status
    expression: "status IN ('active', 'inactive')"
`;
    const result = parseTable(yaml);
    expect(result.checks).toHaveLength(2);
    expect(result.checks![0]).toEqual({
      name: 'valid_status',
      expression: "status IN ('active', 'inactive')",
    });
    expect(result.checks![1]).toEqual({
      name: 'chk_orders_total',
      expression: 'total >= 0',
    });
  });

  it('generates multiple column-level checks from multiple columns', () => {
    const yaml = `
table: products
columns:
  - name: price
    type: numeric
    check: "price > 0"
  - name: quantity
    type: integer
    check: "quantity >= 0"
`;
    const result = parseTable(yaml);
    expect(result.checks).toHaveLength(2);
    expect(result.checks![0]).toEqual({
      name: 'chk_products_price',
      expression: 'price > 0',
    });
    expect(result.checks![1]).toEqual({
      name: 'chk_products_quantity',
      expression: 'quantity >= 0',
    });
  });

  it('throws on invalid index method', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
indexes:
  - columns: [id]
    method: invalid
`;
    expect(() => parseTable(yaml)).toThrow(/method/i);
  });

  it('parses expression index keys', () => {
    const yaml = `
table: users
columns:
  - name: email
    type: text
indexes:
  - name: idx_users_lower_email
    unique: true
    columns:
      - expression: "lower(email)"
`;
    const result = parseTable(yaml);
    expect(result.indexes).toBeDefined();
    expect(result.indexes![0].columns).toEqual([{ expression: 'lower(email)' }]);
  });

  it('parses mixed column + expression index keys', () => {
    const yaml = `
table: daily_snapshots
columns:
  - name: tenant_id
    type: uuid
  - name: grain_id
    type: uuid
indexes:
  - name: idx_daily_snapshots_upsert
    unique: true
    columns:
      - tenant_id
      - expression: "COALESCE(grain_id, '0')"
`;
    const result = parseTable(yaml);
    expect(result.indexes![0].columns).toEqual(['tenant_id', { expression: "COALESCE(grain_id, '0')" }]);
  });

  it('throws on an expression column entry missing the expression field', () => {
    const yaml = `
table: users
columns:
  - name: email
    type: text
indexes:
  - columns:
      - { foo: bar }
`;
    expect(() => parseTable(yaml)).toThrow(/expression/i);
  });

  it('throws on an empty-string expression', () => {
    const yaml = `
table: users
columns:
  - name: email
    type: text
indexes:
  - columns:
      - expression: ""
`;
    expect(() => parseTable(yaml)).toThrow(/expression/i);
  });

  it('parses seeds_on_conflict field', () => {
    const yaml = `
table: statuses
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
seeds:
  - id: 1
    name: active
seeds_on_conflict: 'DO NOTHING'
`;
    const result = parseTable(yaml);
    expect(result.seeds_on_conflict).toBe('DO NOTHING');
    expect(result.seeds).toHaveLength(1);
  });

  it('parses !sql YAML tag in seed values', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: created_at
    type: timestamptz
seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    created_at: !sql now()
`;
    const result = parseTable(yaml);
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds![0].created_at).toEqual({ __sql: 'now()' });
  });
});

// ─── Enum Parsing ───────────────────────────────────────────────

describe('parseEnum', () => {
  it('parses a valid enum', () => {
    const yaml = `
name: order_status
values:
  - pending
  - processing
  - shipped
comment: "Order lifecycle states"
`;
    const result = parseEnum(yaml);
    expect(result.name).toBe('order_status');
    expect(result.values).toEqual(['pending', 'processing', 'shipped']);
    expect(result.comment).toBe('Order lifecycle states');
  });

  it('throws if name is missing', () => {
    expect(() => parseEnum('values: [a, b]')).toThrow(/name/i);
  });

  it('throws if values is missing or empty', () => {
    expect(() => parseEnum('name: foo')).toThrow(/values/i);
    expect(() => parseEnum('name: foo\nvalues: []')).toThrow(/values/i);
  });
});

// ─── Function Parsing ───────────────────────────────────────────

describe('parseFunction', () => {
  it('parses a full function', () => {
    const yaml = `
name: update_timestamp
language: plpgsql
returns: trigger
args:
  - name: target_column
    type: text
    mode: IN
    default: "'updated_at'"
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
security: definer
volatility: stable
parallel: safe
strict: true
leakproof: true
cost: 200
rows: 10
set:
  search_path: public
grants:
  - to: app_user
    privileges: [EXECUTE]
comment: "Auto-update timestamp"
`;
    const result = parseFunction(yaml);
    expect(result.name).toBe('update_timestamp');
    expect(result.language).toBe('plpgsql');
    expect(result.returns).toBe('trigger');
    expect(result.args).toHaveLength(1);
    expect(result.args![0]).toEqual({
      name: 'target_column',
      type: 'text',
      mode: 'IN',
      default: "'updated_at'",
    });
    expect(result.body).toContain('NEW.updated_at = now()');
    expect(result.security).toBe('definer');
    expect(result.volatility).toBe('stable');
    expect(result.parallel).toBe('safe');
    expect(result.strict).toBe(true);
    expect(result.leakproof).toBe(true);
    expect(result.cost).toBe(200);
    expect(result.rows).toBe(10);
    expect(result.set).toEqual({ search_path: 'public' });
    expect(result.grants).toHaveLength(1);
    expect(result.comment).toBe('Auto-update timestamp');
  });

  it('parses a minimal function', () => {
    const yaml = `
name: my_func
language: sql
returns: void
body: "SELECT 1;"
`;
    const result = parseFunction(yaml);
    expect(result.name).toBe('my_func');
    expect(result.language).toBe('sql');
    expect(result.returns).toBe('void');
    expect(result.body).toBe('SELECT 1;');
  });

  it('throws if required fields missing', () => {
    expect(() => parseFunction('language: sql\nreturns: void\nbody: "x"')).toThrow(/name/i);
    expect(() => parseFunction('name: f\nreturns: void\nbody: "x"')).toThrow(/language/i);
    expect(() => parseFunction('name: f\nlanguage: sql\nbody: "x"')).toThrow(/returns/i);
    expect(() => parseFunction('name: f\nlanguage: sql\nreturns: void')).toThrow(/body/i);
  });

  it('throws on invalid security value', () => {
    const yaml = `
name: f
language: sql
returns: void
body: "x"
security: wrong
`;
    expect(() => parseFunction(yaml)).toThrow(/security/i);
  });

  it('throws on invalid volatility value', () => {
    const yaml = `
name: f
language: sql
returns: void
body: "x"
volatility: wrong
`;
    expect(() => parseFunction(yaml)).toThrow(/volatility/i);
  });
});

// ─── View Parsing ───────────────────────────────────────────────

describe('parseView', () => {
  it('parses a regular view', () => {
    const yaml = `
name: active_users
query: |
  SELECT id, email FROM users WHERE deleted_at IS NULL
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: "Active users"
`;
    const result = parseView(yaml);
    expect(result.name).toBe('active_users');
    expect(result.materialized).toBeUndefined();
    expect(result.query).toContain('SELECT id, email');
    expect(result.grants).toHaveLength(1);
    expect(result.comment).toBe('Active users');
  });

  it('parses a materialized view', () => {
    const yaml = `
name: user_stats
materialized: true
query: |
  SELECT user_id, count(*) FROM orders GROUP BY user_id
indexes:
  - columns: [user_id]
    unique: true
`;
    const result = parseView(yaml);
    expect(result.materialized).toBe(true);
    expect(result.name).toBe('user_stats');
    // Materialized views have indexes
    if (result.materialized === true) {
      expect(result.indexes).toHaveLength(1);
    }
  });

  it('parses a materialized view with grants and comment', () => {
    const yaml = `
name: user_stats
materialized: true
query: |
  SELECT user_id, count(*) FROM orders GROUP BY user_id
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: "Aggregated user order statistics"
`;
    const result = parseView(yaml);
    expect(result.materialized).toBe(true);
    expect(result.name).toBe('user_stats');
    if (result.materialized === true) {
      expect(result.grants).toHaveLength(1);
      expect(result.grants![0].to).toBe('app_readonly');
      expect(result.grants![0].privileges).toEqual(['SELECT']);
      expect(result.comment).toBe('Aggregated user order statistics');
    }
  });

  it('throws if name or query is missing', () => {
    expect(() => parseView('query: "SELECT 1"')).toThrow(/name/i);
    expect(() => parseView('name: v')).toThrow(/query/i);
  });

  it('parses view with options (WITH clause)', () => {
    const yaml = `
name: secure_view
query: |
  SELECT id, email FROM users
options:
  security_barrier: true
  check_option: cascaded
`;
    const result = parseView(yaml);
    expect(result.materialized).toBeUndefined();
    expect(result.name).toBe('secure_view');
    expect((result as { options?: Record<string, string | boolean> }).options).toEqual({
      security_barrier: true,
      check_option: 'cascaded',
    });
  });

  it('omits options when not specified', () => {
    const yaml = `
name: simple_view
query: "SELECT 1"
`;
    const result = parseView(yaml);
    expect((result as { options?: Record<string, string | boolean> }).options).toBeUndefined();
  });

  it('parses view with security_invoker option', () => {
    const yaml = `
name: invoker_view
query: "SELECT 1"
options:
  security_invoker: true
`;
    const result = parseView(yaml);
    expect((result as { options?: Record<string, string | boolean> }).options).toEqual({
      security_invoker: true,
    });
  });
});

// ─── Role Parsing ───────────────────────────────────────────────

describe('parseRole', () => {
  it('parses a full role', () => {
    const yaml = `
role: app_readonly
login: false
superuser: false
createdb: false
createrole: false
inherit: true
bypassrls: false
replication: false
connection_limit: 10
in: [app_group]
comment: "Read-only role"
`;
    const result = parseRole(yaml);
    expect(result.role).toBe('app_readonly');
    expect(result.login).toBe(false);
    expect(result.inherit).toBe(true);
    expect(result.connection_limit).toBe(10);
    expect(result.in).toEqual(['app_group']);
    expect(result.comment).toBe('Read-only role');
  });

  it('parses a minimal role', () => {
    const result = parseRole('role: viewer');
    expect(result.role).toBe('viewer');
  });

  it('throws if role is missing', () => {
    expect(() => parseRole('login: true')).toThrow(/role/i);
  });
});

// ─── Extensions Parsing ────────────────────────────────────────

describe('parseExtensions', () => {
  it('parses extensions with grants', () => {
    const yaml = `
extensions:
  - pgcrypto
  - pg_trgm
schema_grants:
  - to: app_user
    schemas: [public]
`;
    const result = parseExtensions(yaml);
    expect(result.extensions).toEqual(['pgcrypto', 'pg_trgm']);
    expect(result.schema_grants).toHaveLength(1);
    expect(result.schema_grants![0]).toEqual({ to: 'app_user', schemas: ['public'] });
  });

  it('throws if extensions is missing or empty', () => {
    expect(() => parseExtensions('{}')).toThrow(/extensions/i);
    expect(() => parseExtensions('extensions: []')).toThrow(/extensions/i);
  });
});

// ─── Mixin Parsing ─────────────────────────────────────────────

describe('parseMixin', () => {
  it('parses a mixin with columns and triggers', () => {
    const yaml = `
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
triggers:
  - name: "set_{table}_updated_at"
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
rls: true
`;
    const result = parseMixin(yaml);
    expect(result.mixin).toBe('timestamps');
    expect(result.columns).toHaveLength(2);
    expect(result.triggers).toHaveLength(1);
    expect(result.rls).toBe(true);
  });

  it('parses force_rls on mixin', () => {
    const yaml = `
mixin: secure_mixin
rls: true
force_rls: true
`;
    const result = parseMixin(yaml);
    expect(result.rls).toBe(true);
    expect(result.force_rls).toBe(true);
  });

  it('throws if mixin name is missing', () => {
    expect(() => parseMixin('columns: []')).toThrow(/mixin/i);
  });
});

// ─── parseSchemaFile (auto-detect kind) ─────────────────────────

describe('parseSchemaFile', () => {
  it('detects a table file', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('table');
    expect(result.schema).toHaveProperty('table', 'users');
  });

  it('detects an enum file', () => {
    const yaml = `
name: status
values: [a, b]
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('enum');
  });

  it('detects a function file', () => {
    const yaml = `
name: my_func
language: sql
returns: void
body: "SELECT 1"
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('function');
  });

  it('detects a regular view file', () => {
    const yaml = `
name: my_view
query: "SELECT 1"
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('view');
  });

  it('detects a materialized view file', () => {
    const yaml = `
name: my_mat_view
materialized: true
query: "SELECT 1"
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('materialized_view');
  });

  it('detects a role file', () => {
    const yaml = 'role: admin';
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('role');
  });

  it('detects an extensions file', () => {
    const yaml = 'extensions: [pgcrypto]';
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('extensions');
  });

  it('detects a mixin file', () => {
    const yaml = `
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
`;
    const result = parseSchemaFile(yaml);
    expect(result.kind).toBe('mixin');
  });

  it('throws on unrecognized schema', () => {
    expect(() => parseSchemaFile('foo: bar')).toThrow(/unrecognized/i);
  });
});

// ─── description alias for comment ─────────────────────────────

describe('description alias for comment', () => {
  it('table: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
description: "Table desc"
`;
    const result = parseTable(yaml);
    expect(result.comment).toBe('Table desc');
  });

  it('table: comment wins over description', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
comment: "From comment"
description: "From description"
`;
    const result = parseTable(yaml);
    expect(result.comment).toBe('From comment');
  });

  it('column: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
    description: "Column desc"
`;
    const result = parseTable(yaml);
    expect(result.columns[0].comment).toBe('Column desc');
  });

  it('column: comment wins over description', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
    comment: "From comment"
    description: "From description"
`;
    const result = parseTable(yaml);
    expect(result.columns[0].comment).toBe('From comment');
  });

  it('index: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
indexes:
  - columns: [id]
    description: "Index desc"
`;
    const result = parseTable(yaml);
    expect(result.indexes![0].comment).toBe('Index desc');
  });

  it('check: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
checks:
  - name: chk
    expression: "id IS NOT NULL"
    description: "Check desc"
`;
    const result = parseTable(yaml);
    expect(result.checks![0].comment).toBe('Check desc');
  });

  it('check: comment wins over description', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
checks:
  - name: chk
    expression: "id IS NOT NULL"
    comment: "From comment"
    description: "From description"
`;
    const result = parseTable(yaml);
    expect(result.checks![0].comment).toBe('From comment');
  });

  it('constraint-backed index: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
indexes:
  - columns: [id]
    unique: true
    as_constraint: true
    description: "UC desc"
`;
    const result = parseTable(yaml);
    expect(result.indexes![0].comment).toBe('UC desc');
  });

  it('trigger: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
triggers:
  - name: trg
    timing: BEFORE
    events: [INSERT]
    function: fn
    description: "Trigger desc"
`;
    const result = parseTable(yaml);
    expect(result.triggers![0].comment).toBe('Trigger desc');
  });

  it('policy: description maps to comment', () => {
    const yaml = `
table: t
columns:
  - name: id
    type: uuid
policies:
  - name: pol
    to: role
    description: "Policy desc"
`;
    const result = parseTable(yaml);
    expect(result.policies![0].comment).toBe('Policy desc');
  });

  it('enum: description maps to comment', () => {
    const yaml = `
name: status
values: [a, b]
description: "Enum desc"
`;
    const result = parseEnum(yaml);
    expect(result.comment).toBe('Enum desc');
  });

  it('enum: comment wins over description', () => {
    const yaml = `
name: status
values: [a, b]
comment: "From comment"
description: "From description"
`;
    const result = parseEnum(yaml);
    expect(result.comment).toBe('From comment');
  });

  it('function: description maps to comment', () => {
    const yaml = `
name: fn
language: sql
returns: void
body: "SELECT 1"
description: "Function desc"
`;
    const result = parseFunction(yaml);
    expect(result.comment).toBe('Function desc');
  });

  it('view: description maps to comment', () => {
    const yaml = `
name: v
query: "SELECT 1"
description: "View desc"
`;
    const result = parseView(yaml);
    expect(result.comment).toBe('View desc');
  });

  it('materialized view: description maps to comment', () => {
    const yaml = `
name: mv
materialized: true
query: "SELECT 1"
description: "MV desc"
`;
    const result = parseView(yaml);
    expect(result.comment).toBe('MV desc');
  });

  it('role: description maps to comment', () => {
    const yaml = `
role: r
description: "Role desc"
`;
    const result = parseRole(yaml);
    expect(result.comment).toBe('Role desc');
  });

  it('role: comment wins over description', () => {
    const yaml = `
role: r
comment: "From comment"
description: "From description"
`;
    const result = parseRole(yaml);
    expect(result.comment).toBe('From comment');
  });
});
