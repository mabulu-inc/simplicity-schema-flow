import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift } from '../drift/index.js';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_chk_diff_${Date.now()}`;

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

describe('check constraint expression diff', () => {
  it('planner emits drop+add when check expression changes', async () => {
    // Step 1: Create table with initial check constraint
    const initial = parseTable(`
table: chk_diff_orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: amount
    type: integer
    nullable: false
checks:
  - name: chk_amount_positive
    expression: "amount > 0"
`);

    const desiredState1: DesiredState = { ...emptyDesired(), tables: [initial] };
    await applyPlan(desiredState1, emptyActual());

    // Step 2: Introspect the table to get actual state
    const introspected = await introspectTable(client, 'chk_diff_orders', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['chk_diff_orders', introspected]]),
    };

    // Step 3: Change the check expression
    const modified = parseTable(`
table: chk_diff_orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: amount
    type: integer
    nullable: false
checks:
  - name: chk_amount_positive
    expression: "amount >= 10"
`);

    const desiredState2: DesiredState = { ...emptyDesired(), tables: [modified] };
    const plan = buildPlan(desiredState2, actualState, { pgSchema: TEST_SCHEMA });

    // Should have a drop_check and add_check operation
    const checkOps = plan.operations.filter((op) => op.type === 'drop_check' || op.type === 'add_check');
    expect(checkOps).toHaveLength(2);
    expect(checkOps.find((op) => op.type === 'drop_check')).toBeDefined();
    expect(checkOps.find((op) => op.type === 'add_check')).toBeDefined();
  });

  it('planner emits no ops when check expression is unchanged', async () => {
    // Re-create with original expression
    await client.query(`DROP TABLE IF EXISTS "${TEST_SCHEMA}".chk_diff_stable CASCADE`);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".chk_diff_stable (
        id serial PRIMARY KEY,
        amount integer NOT NULL,
        CONSTRAINT chk_stable_positive CHECK (amount > 0)
      )
    `);

    const introspected = await introspectTable(client, 'chk_diff_stable', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['chk_diff_stable', introspected]]),
    };

    const stableDesired = parseTable(`
table: chk_diff_stable
columns:
  - name: id
    type: serial
    primary_key: true
  - name: amount
    type: integer
    nullable: false
checks:
  - name: chk_stable_positive
    expression: "amount > 0"
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [stableDesired] };
    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });

    const checkOps = plan.operations.filter((op) => op.type === 'drop_check' || op.type === 'add_check');
    expect(checkOps).toHaveLength(0);
  });

  it('drift reports "different" when check expression differs', async () => {
    // Create table with one expression in DB
    await client.query(`DROP TABLE IF EXISTS "${TEST_SCHEMA}".chk_drift_test CASCADE`);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".chk_drift_test (
        id serial PRIMARY KEY,
        quantity integer NOT NULL,
        CONSTRAINT chk_qty CHECK (quantity > 0)
      )
    `);

    const introspected = await introspectTable(client, 'chk_drift_test', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['chk_drift_test', introspected]]),
    };

    // YAML says different expression
    const desired = parseTable(`
table: chk_drift_test
columns:
  - name: id
    type: serial
    primary_key: true
  - name: quantity
    type: integer
    nullable: false
checks:
  - name: chk_qty
    expression: "quantity >= 5"
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const report = detectDrift(desiredState, actualState);

    const constraintDrift = report.items.filter(
      (item) => item.type === 'constraint' && item.object.includes('chk_qty'),
    );
    expect(constraintDrift).toHaveLength(1);
    expect(constraintDrift[0].status).toBe('different');
  });

  it('drift reports zero after applying modified check expression', async () => {
    // Create table with initial check
    await client.query(`DROP TABLE IF EXISTS "${TEST_SCHEMA}".chk_roundtrip CASCADE`);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".chk_roundtrip (
        id serial PRIMARY KEY,
        score integer NOT NULL,
        CONSTRAINT chk_score CHECK (score > 0)
      )
    `);

    // Desired state has modified expression
    const desired = parseTable(`
table: chk_roundtrip
columns:
  - name: id
    type: serial
    primary_key: true
  - name: score
    type: integer
    nullable: false
checks:
  - name: chk_score
    expression: "score >= 10"
`);

    // Introspect, plan, and apply
    const introspected = await introspectTable(client, 'chk_roundtrip', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['chk_roundtrip', introspected]]),
    };

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    await applyPlan(desiredState, actualState);

    // Re-introspect and check drift
    const afterIntrospect = await introspectTable(client, 'chk_roundtrip', TEST_SCHEMA);
    const afterActual: ActualState = {
      ...emptyActual(),
      tables: new Map([['chk_roundtrip', afterIntrospect]]),
    };
    const report = detectDrift(desiredState, afterActual);

    const constraintDrift = report.items.filter(
      (item) => item.type === 'constraint' && item.object.includes('chk_score'),
    );
    expect(constraintDrift).toHaveLength(0);
  });
});
