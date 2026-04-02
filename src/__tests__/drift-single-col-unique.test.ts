import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift } from '../drift/index.js';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_drift_sc_uq_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

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

function emptyDesired(): DesiredState {
  return {
    tables: [],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions: null,
  };
}

async function applyPlan(desiredState: DesiredState, actualState: ActualState): Promise<void> {
  const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
  const sql = generateSql(plan, { pgSchema: TEST_SCHEMA });
  if (sql) {
    await client.query(sql);
  }
}

/** Filter drift items to only constraint and index types (unique-related). */
function uniqueRelatedDrift(items: { type: string; object: string }[]) {
  return items.filter((item) => item.type === 'constraint' || item.type === 'index');
}

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

describe('drift: single-column unique: true produces zero drift', () => {
  it('reports no constraint/index drift for column-level unique: true after fresh creation', async () => {
    const desired = parseTable(`
table: drift_uq_users
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
    unique: true
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_uq_users', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_uq_users', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const related = uniqueRelatedDrift(report.items);
    expect(related).toHaveLength(0);
  });

  it('reports no constraint/index drift for column-level unique: true with custom unique_name', async () => {
    const desired = parseTable(`
table: drift_uq_named
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: slug
    type: text
    nullable: false
    unique: true
    unique_name: uq_drift_named_slug
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_uq_named', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_uq_named', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const related = uniqueRelatedDrift(report.items);
    expect(related).toHaveLength(0);
  });

  it('reports no constraint/index drift for multi-column unique_constraints (no regression)', async () => {
    const desired = parseTable(`
table: drift_uq_multi
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: first_name
    type: text
    nullable: false
  - name: last_name
    type: text
    nullable: false
unique_constraints:
  - name: uq_drift_multi_name
    columns: [first_name, last_name]
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_uq_multi', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_uq_multi', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const related = uniqueRelatedDrift(report.items);
    expect(related).toHaveLength(0);
  });

  it('detects genuine drift when unique constraint is missing from DB', async () => {
    // Table in DB has no unique constraint on email
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".drift_uq_genuine (
        id uuid PRIMARY KEY,
        email text NOT NULL
      )
    `);

    const desired = parseTable(`
table: drift_uq_genuine
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
    unique: true
`);

    const introspected = await introspectTable(client, 'drift_uq_genuine', TEST_SCHEMA);
    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_uq_genuine', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    // Should report the missing unique constraint
    const related = uniqueRelatedDrift(report.items);
    expect(related.length).toBeGreaterThan(0);
  });
});
