import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable } from '../introspect/index.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { parseTable } from '../schema/parser.js';
import { generateFromDb } from '../scaffold/index.js';
import type { TableSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_nnd_${Date.now()}`;

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

// ─── Parser ──────────────────────────────────────────────────────

describe('parser: nulls_not_distinct', () => {
  it('parses nulls_not_distinct: true on a unique constraint', () => {
    const table = parseTable(`
table: test_nnd
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_test_nnd_email
    columns: [email]
    nulls_not_distinct: true
`);

    expect(table.unique_constraints).toHaveLength(1);
    expect(table.unique_constraints![0].nulls_not_distinct).toBe(true);
  });

  it('defaults nulls_not_distinct to undefined when not specified', () => {
    const table = parseTable(`
table: test_nnd2
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_test_nnd2_email
    columns: [email]
`);

    expect(table.unique_constraints![0].nulls_not_distinct).toBeUndefined();
  });
});

// ─── Planner / SQL generation ─────────────────────────────────────

describe('planner: nulls_not_distinct SQL generation', () => {
  it('emits NULLS NOT DISTINCT in CREATE TABLE inline constraint', () => {
    const desired = parseTable(`
table: nnd_create
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_create_email
    columns: [email]
    nulls_not_distinct: true
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

    const plan = buildPlan(desiredState, emptyActual(), { pgSchema: TEST_SCHEMA });
    const createOp = plan.operations.find((op) => op.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toContain('NULLS NOT DISTINCT');
  });

  it('does not emit NULLS NOT DISTINCT when not specified', () => {
    const desired = parseTable(`
table: nnd_no_flag
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_no_flag_email
    columns: [email]
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

    const plan = buildPlan(desiredState, emptyActual(), { pgSchema: TEST_SCHEMA });
    const createOp = plan.operations.find((op) => op.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).not.toContain('NULLS NOT DISTINCT');
  });

  it('emits NULLS NOT DISTINCT in CREATE UNIQUE INDEX CONCURRENTLY for existing tables', () => {
    const desired = parseTable(`
table: nnd_existing
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_existing_email
    columns: [email]
    nulls_not_distinct: true
`);

    const existing: TableSchema = {
      table: 'nnd_existing',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
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
      tables: new Map([['nnd_existing', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const indexOp = plan.operations.find((op) => op.type === 'add_index' && op.objectName === 'uq_nnd_existing_email');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).toContain('NULLS NOT DISTINCT');
  });
});

// ─── Introspection ───────────────────────────────────────────────

describe('introspection: nulls_not_distinct', () => {
  it('reads nulls_not_distinct from a NULLS NOT DISTINCT constraint', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".introspect_nnd (
        id uuid PRIMARY KEY,
        email text,
        CONSTRAINT uq_introspect_nnd_email UNIQUE NULLS NOT DISTINCT (email)
      )
    `);

    const table = await introspectTable(client, 'introspect_nnd', TEST_SCHEMA);

    expect(table.unique_constraints).toBeDefined();
    const uc = table.unique_constraints!.find((u) => u.name === 'uq_introspect_nnd_email');
    expect(uc).toBeDefined();
    expect(uc!.nulls_not_distinct).toBe(true);
  });

  it('returns nulls_not_distinct as false for a regular unique constraint', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".introspect_regular (
        id uuid PRIMARY KEY,
        email text,
        CONSTRAINT uq_introspect_regular_email UNIQUE (email)
      )
    `);

    const table = await introspectTable(client, 'introspect_regular', TEST_SCHEMA);

    const uc = table.unique_constraints!.find((u) => u.name === 'uq_introspect_regular_email');
    expect(uc).toBeDefined();
    // Regular unique constraints should not have nulls_not_distinct set (or false)
    expect(uc!.nulls_not_distinct).toBeFalsy();
  });
});

// ─── Diff / convergence ──────────────────────────────────────────

describe('diff: nulls_not_distinct changes', () => {
  it('plans drop+recreate when nulls_not_distinct changes from false to true', () => {
    const desired = parseTable(`
table: nnd_diff
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_diff_email
    columns: [email]
    nulls_not_distinct: true
`);

    const existing: TableSchema = {
      table: 'nnd_diff',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      unique_constraints: [{ columns: ['email'], name: 'uq_nnd_diff_email' }],
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
      tables: new Map([['nnd_diff', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA, allowDestructive: true });

    // Should drop the old constraint and recreate with NULLS NOT DISTINCT
    const dropOps = plan.operations.filter(
      (op) => op.type === 'drop_unique_constraint' && op.objectName.includes('uq_nnd_diff_email'),
    );
    const addOps = plan.operations.filter((op) => op.type === 'add_index' && op.objectName === 'uq_nnd_diff_email');
    expect(dropOps.length).toBeGreaterThanOrEqual(1);
    expect(addOps.length).toBeGreaterThanOrEqual(1);
    expect(addOps[0].sql).toContain('NULLS NOT DISTINCT');
  });

  it('plans drop+recreate when nulls_not_distinct changes from true to false', () => {
    const desired = parseTable(`
table: nnd_diff2
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_diff2_email
    columns: [email]
`);

    const existing: TableSchema = {
      table: 'nnd_diff2',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      unique_constraints: [{ columns: ['email'], name: 'uq_nnd_diff2_email', nulls_not_distinct: true }],
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
      tables: new Map([['nnd_diff2', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA, allowDestructive: true });

    const dropOps = plan.operations.filter(
      (op) => op.type === 'drop_unique_constraint' && op.objectName.includes('uq_nnd_diff2_email'),
    );
    const addOps = plan.operations.filter((op) => op.type === 'add_index' && op.objectName === 'uq_nnd_diff2_email');
    expect(dropOps.length).toBeGreaterThanOrEqual(1);
    expect(addOps.length).toBeGreaterThanOrEqual(1);
    expect(addOps[0].sql).not.toContain('NULLS NOT DISTINCT');
  });

  it('produces 0 operations when nulls_not_distinct matches', () => {
    const desired = parseTable(`
table: nnd_match
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_nnd_match_email
    columns: [email]
    nulls_not_distinct: true
`);

    const existing: TableSchema = {
      table: 'nnd_match',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      unique_constraints: [{ columns: ['email'], name: 'uq_nnd_match_email', nulls_not_distinct: true }],
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
      tables: new Map([['nnd_match', existing]]),
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

// ─── Scaffold / generate round-trip ──────────────────────────────

describe('scaffold: nulls_not_distinct round-trip', () => {
  it('generates YAML with nulls_not_distinct from introspected table', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".scaffold_nnd (
        id uuid PRIMARY KEY,
        code text,
        CONSTRAINT uq_scaffold_nnd_code UNIQUE NULLS NOT DISTINCT (code)
      )
    `);

    const table = await introspectTable(client, 'scaffold_nnd', TEST_SCHEMA);

    const files = generateFromDb({
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    const tableFile = files.find((f) => f.filename === 'tables/scaffold_nnd.yaml');
    expect(tableFile).toBeDefined();
    expect(tableFile!.content).toContain('nulls_not_distinct: true');
  });

  it('does not include nulls_not_distinct when false', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".scaffold_regular (
        id uuid PRIMARY KEY,
        code text,
        CONSTRAINT uq_scaffold_regular_code UNIQUE (code)
      )
    `);

    const table = await introspectTable(client, 'scaffold_regular', TEST_SCHEMA);

    const files = generateFromDb({
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    const tableFile = files.find((f) => f.filename === 'tables/scaffold_regular.yaml');
    expect(tableFile).toBeDefined();
    expect(tableFile!.content).not.toContain('nulls_not_distinct');
  });
});

// ─── E2E: full migration with nulls_not_distinct ──────────────────

describe('E2E: nulls_not_distinct migration', () => {
  it('creates a table with NULLS NOT DISTINCT and introspects back correctly', async () => {
    // Create the table via raw SQL with NULLS NOT DISTINCT
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".e2e_nnd (
        id uuid PRIMARY KEY,
        tenant_id uuid,
        code text,
        CONSTRAINT uq_e2e_nnd_tenant_code UNIQUE NULLS NOT DISTINCT (tenant_id, code)
      )
    `);

    // Introspect
    const table = await introspectTable(client, 'e2e_nnd', TEST_SCHEMA);

    // Verify introspected result
    const uc = table.unique_constraints!.find((u) => u.name === 'uq_e2e_nnd_tenant_code');
    expect(uc).toBeDefined();
    expect(uc!.nulls_not_distinct).toBe(true);
    expect(uc!.columns).toEqual(['tenant_id', 'code']);

    // Parse matching YAML
    const desired = parseTable(`
table: e2e_nnd
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: tenant_id
    type: uuid
  - name: code
    type: text
unique_constraints:
  - name: uq_e2e_nnd_tenant_code
    columns: [tenant_id, code]
    nulls_not_distinct: true
`);

    // Verify convergence (0 ops)
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
      tables: new Map([['e2e_nnd', table]]),
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
