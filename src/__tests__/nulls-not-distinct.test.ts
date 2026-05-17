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
  it('parses nulls_not_distinct: true on a constraint-backed unique index', () => {
    const table = parseTable(`
table: test_nnd
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
indexes:
  - name: uq_test_nnd_email
    columns: [email]
    unique: true
    as_constraint: true
    nulls_not_distinct: true
`);

    expect(table.indexes).toHaveLength(1);
    expect(table.indexes![0].nulls_not_distinct).toBe(true);
    expect(table.indexes![0].as_constraint).toBe(true);
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
indexes:
  - name: uq_test_nnd2_email
    columns: [email]
    unique: true
    as_constraint: true
`);

    expect(table.indexes![0].nulls_not_distinct).toBeUndefined();
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
indexes:
  - name: uq_nnd_create_email
    columns: [email]
    unique: true
    as_constraint: true
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
indexes:
  - name: uq_nnd_no_flag_email
    columns: [email]
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
indexes:
  - name: uq_nnd_existing_email
    columns: [email]
    unique: true
    as_constraint: true
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

    // Single-column unique with nulls_not_distinct can't be folded into
    // col.unique=true (that loses the flag), so it stays in indexes[].
    const idx = (table.indexes || []).find((i) => i.name === 'uq_introspect_nnd_email');
    expect(idx).toBeDefined();
    expect(idx!.as_constraint).toBe(true);
    expect(idx!.nulls_not_distinct).toBe(true);
  });

  it('folds a regular single-column unique constraint into col.unique=true', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".introspect_regular (
        id uuid PRIMARY KEY,
        email text,
        CONSTRAINT uq_introspect_regular_email UNIQUE (email)
      )
    `);

    const table = await introspectTable(client, 'introspect_regular', TEST_SCHEMA);

    // Vanilla single-column uniques (no nulls_not_distinct, no deferrable,
    // no INCLUDE, no comment) are surfaced column-level. The custom name
    // is preserved via col.unique_name.
    const emailCol = table.columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.unique).toBe(true);
    expect(emailCol!.unique_name).toBe('uq_introspect_regular_email');
    // And it shouldn't double up in indexes[]:
    expect((table.indexes || []).find((i) => i.name === 'uq_introspect_regular_email')).toBeUndefined();
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
indexes:
  - name: uq_nnd_diff_email
    columns: [email]
    unique: true
    as_constraint: true
    nulls_not_distinct: true
`);

    const existing: TableSchema = {
      table: 'nnd_diff',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      indexes: [{ columns: ['email'], name: 'uq_nnd_diff_email', unique: true, as_constraint: true }],
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
indexes:
  - name: uq_nnd_diff2_email
    columns: [email]
    unique: true
    as_constraint: true
`);

    const existing: TableSchema = {
      table: 'nnd_diff2',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      indexes: [
        { columns: ['email'], name: 'uq_nnd_diff2_email', unique: true, as_constraint: true, nulls_not_distinct: true },
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
indexes:
  - name: uq_nnd_match_email
    columns: [email]
    unique: true
    as_constraint: true
    nulls_not_distinct: true
`);

    const existing: TableSchema = {
      table: 'nnd_match',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      indexes: [
        { columns: ['email'], name: 'uq_nnd_match_email', unique: true, as_constraint: true, nulls_not_distinct: true },
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

    // Verify introspected result — multi-column constraint stays in indexes[]
    // with as_constraint:true.
    const uc = (table.indexes || []).find((i) => i.name === 'uq_e2e_nnd_tenant_code');
    expect(uc).toBeDefined();
    expect(uc!.as_constraint).toBe(true);
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
indexes:
  - name: uq_e2e_nnd_tenant_code
    columns: [tenant_id, code]
    unique: true
    as_constraint: true
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

// ─── indexes: section (parallel coverage to unique_constraints) ──
// Regression: `nulls_not_distinct: true` on an `indexes:` entry used to be
// silently dropped on the floor — the parser accepted it but the emitted
// CREATE INDEX omitted the clause, so the underlying pg_index.indnullsnotdistinct
// stayed false and NULLs were treated as distinct. Fixed by honoring the field
// in createIndexOp and round-tripping it through introspection.

describe('parser: indexes: nulls_not_distinct', () => {
  it('parses nulls_not_distinct: true on a unique index', () => {
    const table = parseTable(`
table: idx_nnd
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
  - name: b
    type: integer
indexes:
  - name: uq_idx_nnd_a_b
    columns: [a, b]
    unique: true
    nulls_not_distinct: true
`);
    expect(table.indexes).toHaveLength(1);
    expect(table.indexes![0].nulls_not_distinct).toBe(true);
    expect(table.indexes![0].unique).toBe(true);
  });

  it('rejects nulls_not_distinct: true on a non-unique index', () => {
    expect(() =>
      parseTable(`
table: idx_nnd_bad
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
indexes:
  - name: ix_idx_nnd_bad_a
    columns: [a]
    nulls_not_distinct: true
`),
    ).toThrow(/nulls_not_distinct.*unique/i);
  });
});

describe('planner: indexes: nulls_not_distinct SQL generation', () => {
  it('emits NULLS NOT DISTINCT in CREATE UNIQUE INDEX CONCURRENTLY', () => {
    const desired = parseTable(`
table: idx_nnd_emit
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
  - name: b
    type: integer
indexes:
  - name: uq_idx_nnd_emit_a_b
    columns: [a, b]
    unique: true
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
    const indexOp = plan.operations.find((op) => op.type === 'add_index' && op.objectName === 'uq_idx_nnd_emit_a_b');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(indexOp!.sql).toContain('NULLS NOT DISTINCT');
  });

  it('does not emit NULLS NOT DISTINCT when the flag is absent', () => {
    const desired = parseTable(`
table: idx_nnd_noflag
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
indexes:
  - name: uq_idx_nnd_noflag_a
    columns: [a]
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
    const plan = buildPlan(desiredState, emptyActual(), { pgSchema: TEST_SCHEMA });
    const indexOp = plan.operations.find((op) => op.type === 'add_index' && op.objectName === 'uq_idx_nnd_noflag_a');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).not.toContain('NULLS NOT DISTINCT');
  });
});

describe('diff: indexes: nulls_not_distinct changes', () => {
  it('plans drop+recreate when an existing unique index flips false → true', () => {
    const desired = parseTable(`
table: idx_nnd_diff
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
indexes:
  - name: uq_idx_nnd_diff_a
    columns: [a]
    unique: true
    nulls_not_distinct: true
`);
    const existing: TableSchema = {
      table: 'idx_nnd_diff',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'a', type: 'integer' },
      ],
      indexes: [{ name: 'uq_idx_nnd_diff_a', columns: ['a'], unique: true }],
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
      tables: new Map([['idx_nnd_diff', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA, allowDestructive: true });
    const dropIdx = plan.operations.find((op) => op.type === 'drop_index' && op.objectName === 'uq_idx_nnd_diff_a');
    const addIdx = plan.operations.find((op) => op.type === 'add_index' && op.objectName === 'uq_idx_nnd_diff_a');
    expect(dropIdx).toBeDefined();
    expect(addIdx).toBeDefined();
    expect(addIdx!.sql).toContain('NULLS NOT DISTINCT');
  });

  it('produces 0 index ops when nulls_not_distinct matches', () => {
    const desired = parseTable(`
table: idx_nnd_match
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: a
    type: integer
indexes:
  - name: uq_idx_nnd_match_a
    columns: [a]
    unique: true
    nulls_not_distinct: true
`);
    const existing: TableSchema = {
      table: 'idx_nnd_match',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'a', type: 'integer' },
      ],
      indexes: [{ name: 'uq_idx_nnd_match_a', columns: ['a'], unique: true, nulls_not_distinct: true }],
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
      tables: new Map([['idx_nnd_match', existing]]),
    };

    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const idxOps = plan.operations.filter((op) => op.type === 'add_index' || op.type === 'drop_index');
    expect(idxOps).toHaveLength(0);
  });
});

describe('introspection: indexes: nulls_not_distinct', () => {
  it('reads indnullsnotdistinct from a plain unique index (no constraint)', async () => {
    // Create a unique index directly — no CONSTRAINT wrapper, so this goes
    // through getIndexes (not getUniqueConstraints).
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".introspect_idx_nnd (
        id uuid PRIMARY KEY,
        a integer,
        b integer
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX uq_introspect_idx_nnd_a_b
        ON "${TEST_SCHEMA}".introspect_idx_nnd (a, b)
        NULLS NOT DISTINCT
    `);

    const table = await introspectTable(client, 'introspect_idx_nnd', TEST_SCHEMA);

    const idx = (table.indexes || []).find((i) => i.name === 'uq_introspect_idx_nnd_a_b');
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(true);
    expect(idx!.nulls_not_distinct).toBe(true);
  });

  it('returns nulls_not_distinct undefined for a regular unique index', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".introspect_idx_regular (
        id uuid PRIMARY KEY,
        a integer
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX uq_introspect_idx_regular_a
        ON "${TEST_SCHEMA}".introspect_idx_regular (a)
    `);

    const table = await introspectTable(client, 'introspect_idx_regular', TEST_SCHEMA);
    const idx = (table.indexes || []).find((i) => i.name === 'uq_introspect_idx_regular_a');
    expect(idx).toBeDefined();
    expect(idx!.nulls_not_distinct).toBeFalsy();
  });
});

describe('E2E: indexes: nulls_not_distinct enforcement', () => {
  it('plan + apply produces an index where NULLs collide (duplicate (NULL, NULL) rejected)', async () => {
    // Drive a real apply by executing the planner SQL ourselves — mirrors what
    // the CLI does and proves the emitted SQL actually flips
    // pg_index.indnullsnotdistinct.
    const desired = parseTable(`
table: e2e_idx_nnd
columns:
  - name: id
    type: serial
    primary_key: true
    nullable: false
  - name: a
    type: integer
    nullable: true
  - name: b
    type: integer
    nullable: true
indexes:
  - name: uq_e2e_idx_nnd_a_b
    columns: [a, b]
    unique: true
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

    // Apply phases in order. CREATE INDEX CONCURRENTLY can't run inside a
    // transaction block, so just fire each op directly on the connection.
    for (const op of [...plan.operations].sort((a, b) => a.phase - b.phase)) {
      await client.query(op.sql);
    }

    // Sanity: the index now has indnullsnotdistinct = true.
    const idxCheck = await client.query(
      `SELECT ix.indnullsnotdistinct
         FROM pg_catalog.pg_index ix
         JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
        WHERE i.relname = 'uq_e2e_idx_nnd_a_b'`,
    );
    expect(idxCheck.rows[0].indnullsnotdistinct).toBe(true);

    // First (NULL, NULL) insert is accepted.
    await client.query(`INSERT INTO "${TEST_SCHEMA}".e2e_idx_nnd (a, b) VALUES (NULL, NULL)`);
    // Second is rejected — that's the whole point of NULLS NOT DISTINCT.
    await expect(client.query(`INSERT INTO "${TEST_SCHEMA}".e2e_idx_nnd (a, b) VALUES (NULL, NULL)`)).rejects.toThrow(
      /duplicate key|unique/i,
    );

    // Re-introspect and re-plan: zero churn.
    const introspected = await introspectTable(client, 'e2e_idx_nnd', TEST_SCHEMA);
    const replan = buildPlan(
      desiredState,
      {
        ...emptyActual(),
        tables: new Map([['e2e_idx_nnd', introspected]]),
      },
      { pgSchema: TEST_SCHEMA },
    );
    const idxOps = replan.operations.filter((op) => op.type === 'add_index' || op.type === 'drop_index');
    expect(idxOps).toHaveLength(0);
  });
});
