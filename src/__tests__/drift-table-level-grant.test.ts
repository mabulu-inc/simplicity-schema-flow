import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift } from '../drift/index.js';
import { introspectTable } from '../introspect/index.js';
import { parseTable, parseRole } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_drift_grant_${Date.now()}`;
const TEST_ROLE = `test_grant_role_${Date.now()}`;

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
  await client.query(`CREATE ROLE "${TEST_ROLE}" NOLOGIN`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA "${TEST_SCHEMA}" CASCADE`);
  await client.query(`DROP ROLE "${TEST_ROLE}"`);
  client.release();
  await pool.end();
});

describe('drift: table-level grant without columns field', () => {
  it('reports zero drift after applying a table-level grant (no columns)', async () => {
    const desired = parseTable(`
table: drift_grant_tbl
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
grants:
  - to: ${TEST_ROLE}
    privileges: [SELECT]
`);

    const role = parseRole(`
role: ${TEST_ROLE}
login: false
`);

    const desiredState: DesiredState = {
      ...emptyDesired(),
      tables: [desired],
      roles: [role],
    };

    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_grant_tbl', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_grant_tbl', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const grantDrift = report.items.filter((item) => item.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });

  it('reports zero drift for multi-privilege table-level grant (no columns)', async () => {
    const desired = parseTable(`
table: drift_grant_multi
columns:
  - name: id
    type: integer
    primary_key: true
  - name: value
    type: text
grants:
  - to: ${TEST_ROLE}
    privileges: [SELECT, INSERT, UPDATE]
`);

    const desiredState: DesiredState = {
      ...emptyDesired(),
      tables: [desired],
    };

    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_grant_multi', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_grant_multi', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const grantDrift = report.items.filter((item) => item.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });

  it('still detects genuine drift when column-level grant differs', async () => {
    const desired = parseTable(`
table: drift_grant_col
columns:
  - name: id
    type: integer
    primary_key: true
  - name: secret
    type: text
grants:
  - to: ${TEST_ROLE}
    privileges: [SELECT]
    columns: [id]
`);

    const desiredState: DesiredState = {
      ...emptyDesired(),
      tables: [desired],
    };

    await applyPlan(desiredState, emptyActual());

    const introspected = await introspectTable(client, 'drift_grant_col', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['drift_grant_col', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    const grantDrift = report.items.filter((item) => item.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });
});
