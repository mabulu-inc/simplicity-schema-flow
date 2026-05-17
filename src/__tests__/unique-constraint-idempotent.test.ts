import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable } from '../introspect/index.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { parseTable } from '../schema/parser.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_uq_idempotent_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA "${TEST_SCHEMA}" CASCADE`);
  client.release();
  await pool.end();
});

function emptyActual(): ActualState {
  return {
    tables: new Map(),
    enums: new Map(),
    functions: new Map(),
    views: new Map(),
    materializedViews: new Map(),
    roles: new Map(),
    extensions: [],
  };
}

// ─── Bug 1: Introspection must recognize unique constraints ─────
//
// Post-unification (0.8.0): constraint-backed unique indexes are surfaced
// in the same `indexes:` array as plain indexes, marked with
// `as_constraint: true`. Vanilla single-column uniques are folded into
// `col.unique = true` since that's how users typically declare them.

describe('introspection: unique constraints', () => {
  it('returns multi-column unique constraints in indexes[] with as_constraint:true', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".uc_multi (
        id uuid PRIMARY KEY,
        first_name text NOT NULL,
        last_name text NOT NULL,
        CONSTRAINT uq_uc_multi_name UNIQUE (first_name, last_name)
      )
    `);

    const table = await introspectTable(client, 'uc_multi', TEST_SCHEMA);

    const idx = (table.indexes || []).find((i) => i.name === 'uq_uc_multi_name');
    expect(idx).toBeDefined();
    expect(idx!.as_constraint).toBe(true);
    expect(idx!.unique).toBe(true);
    expect(idx!.columns).toEqual(['first_name', 'last_name']);
  });

  it('folds vanilla single-column unique constraints into col.unique=true', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".uc_single (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        CONSTRAINT uq_uc_single_email UNIQUE (email)
      )
    `);

    const table = await introspectTable(client, 'uc_single', TEST_SCHEMA);

    const emailCol = table.columns.find((c) => c.name === 'email');
    expect(emailCol!.unique).toBe(true);
    expect(emailCol!.unique_name).toBe('uq_uc_single_email');
    // Not double-counted in indexes[]:
    expect((table.indexes || []).find((i) => i.name === 'uq_uc_single_email')).toBeUndefined();
  });

  it('still includes regular non-constraint indexes alongside constraint-backed ones', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".uc_mixed (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        status text NOT NULL,
        CONSTRAINT uq_uc_mixed_email UNIQUE (email)
      )
    `);
    await client.query(`
      CREATE INDEX idx_uc_mixed_status ON "${TEST_SCHEMA}".uc_mixed (status)
    `);

    const table = await introspectTable(client, 'uc_mixed', TEST_SCHEMA);

    const indexNames = (table.indexes || []).map((i) => i.name);
    // The plain index is present:
    expect(indexNames).toContain('idx_uc_mixed_status');
    // The single-column unique was folded to col.unique, not in indexes[]:
    expect(indexNames).not.toContain('uq_uc_mixed_email');
    const emailCol = table.columns.find((c) => c.name === 'email');
    expect(emailCol!.unique).toBe(true);
  });
});

// ─── Bug 2: Planner must produce 0 ops for unchanged unique constraints ─────

describe('planner: idempotent unique constraints', () => {
  it('produces 0 operations when multi-column unique constraint already exists', async () => {
    // Table with multi-column unique constraint already created in DB
    const table = await introspectTable(client, 'uc_multi', TEST_SCHEMA);

    const desired = parseTable(`
table: uc_multi
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: first_name
    type: text
    nullable: false
  - name: last_name
    type: text
    nullable: false
indexes:
  - name: uq_uc_multi_name
    columns: [first_name, last_name]
    unique: true
    as_constraint: true
`);

    const desiredState: DesiredState = {
      tables: [desired],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['uc_multi', table]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    // Should be 0 operations — constraint already exists and matches
    const relevantOps = plan.operations.filter(
      (op) =>
        op.type === 'add_unique_constraint' ||
        op.type === 'drop_unique_constraint' ||
        op.type === 'add_index' ||
        op.type === 'drop_index',
    );
    expect(relevantOps).toHaveLength(0);
  });

  it('produces 0 operations when single-column unique constraint already exists', async () => {
    const table = await introspectTable(client, 'uc_single', TEST_SCHEMA);

    const desired = parseTable(`
table: uc_single
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
    nullable: false
    unique: true
    unique_name: uq_uc_single_email
`);

    const desiredState: DesiredState = {
      tables: [desired],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['uc_single', table]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const relevantOps = plan.operations.filter(
      (op) =>
        op.type === 'add_unique_constraint' ||
        op.type === 'drop_unique_constraint' ||
        op.type === 'add_index' ||
        op.type === 'drop_index',
    );
    expect(relevantOps).toHaveLength(0);
  });
});

// ─── Bug 3: Single-column unique constraint round-trip (GH #7) ─────
//
// Pre-0.8.0 these constraints surfaced in a separate `unique_constraints:`
// array. After unification a vanilla single-column unique constraint surfaces
// as `col.unique = true` (with `col.unique_name` if non-default). Users can
// still declare it either way in YAML — both produce idempotent plans.

describe('planner: single-column unique constraint round-trip (GH #7)', () => {
  it('introspection surfaces vanilla single-column unique as col.unique=true (with custom name)', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".tenant_auth_config (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        CONSTRAINT tenant_auth_config_tenant_id_key UNIQUE (tenant_id)
      )
    `);

    const table = await introspectTable(client, 'tenant_auth_config', TEST_SCHEMA);

    const tenantCol = table.columns.find((c) => c.name === 'tenant_id');
    expect(tenantCol).toBeDefined();
    expect(tenantCol!.unique).toBe(true);
    // Name matches the PG-default `${table}_${col}_key`, so unique_name not set:
    expect(tenantCol!.unique_name).toBeUndefined();
  });

  it('produces 0 operations when single-column unique is declared via indexes[as_constraint:true]', async () => {
    // Table tenant_auth_config created above with single-column unique constraint
    const table = await introspectTable(client, 'tenant_auth_config', TEST_SCHEMA);

    const desired = parseTable(`
table: tenant_auth_config
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: tenant_id
    type: uuid
    nullable: false
indexes:
  - name: tenant_auth_config_tenant_id_key
    columns: [tenant_id]
    unique: true
    as_constraint: true
`);

    const desiredState: DesiredState = {
      tables: [desired],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['tenant_auth_config', table]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const relevantOps = plan.operations.filter(
      (op) =>
        op.type === 'add_unique_constraint' ||
        op.type === 'drop_unique_constraint' ||
        op.type === 'add_index' ||
        op.type === 'drop_index',
    );
    expect(relevantOps).toHaveLength(0);
  });

  it('does not spuriously drop constraints when column-level unique: true is used', async () => {
    // This tests that changing introspection doesn't break the column-level unique path
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".col_unique_test (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        CONSTRAINT col_unique_test_email_key UNIQUE (email)
      )
    `);

    const table = await introspectTable(client, 'col_unique_test', TEST_SCHEMA);

    // User defines unique at the column level (not via `indexes:`)
    const desired = parseTable(`
table: col_unique_test
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
    nullable: false
    unique: true
`);

    const desiredState: DesiredState = {
      tables: [desired],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['col_unique_test', table]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const relevantOps = plan.operations.filter(
      (op) =>
        op.type === 'add_unique_constraint' ||
        op.type === 'drop_unique_constraint' ||
        op.type === 'add_index' ||
        op.type === 'drop_index',
    );
    // Should NOT drop the constraint just because it's not in desired.indexes
    expect(relevantOps).toHaveLength(0);
  });
});

// ─── Bug 4: Drop unique constraint emits ALTER TABLE DROP CONSTRAINT ─────

describe('planner: dropping unique constraints emits correct DDL', () => {
  it('emits ALTER TABLE DROP CONSTRAINT for removed unique constraints', () => {
    const desired = parseTable(`
table: test_drop
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
`);

    const existing: TableSchema = {
      table: 'test_drop',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      indexes: [{ columns: ['email'], name: 'uq_test_drop_email', unique: true, as_constraint: true }],
    };

    const desiredState: DesiredState = {
      tables: [desired],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['test_drop', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: 'public', allowDestructive: true });

    // Should emit DROP CONSTRAINT, not DROP INDEX
    const dropOps = plan.operations.filter((op) => op.type === 'drop_unique_constraint' || op.type === 'drop_index');
    expect(dropOps).toHaveLength(1);
    expect(dropOps[0].type).toBe('drop_unique_constraint');
    expect(dropOps[0].sql).toContain('ALTER TABLE');
    expect(dropOps[0].sql).toContain('DROP CONSTRAINT');
    expect(dropOps[0].sql).not.toContain('DROP INDEX');
  });
});

// Need to import TableSchema for the test
import type { TableSchema } from '../schema/types.js';
