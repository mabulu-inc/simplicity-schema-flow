import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_grant_conflate_${Date.now()}`;
const TEST_ROLE = `test_grant_conflate_role_${Date.now()}`;

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
  if (sql) await client.query(sql);
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

describe('issue #29: column-level + table-level grant conflation', () => {
  it('does not strip table-level INSERT/SELECT when YAML column list is incomplete', async () => {
    const yaml = `
table: example
columns:
  - name: id
    type: integer
    primary_key: true
  - name: a
    type: text
  - name: b
    type: text
  - name: c
    type: text
grants:
  - to: ${TEST_ROLE}
    privileges: [INSERT, SELECT, UPDATE]
    columns: [id, a, b]
  - to: ${TEST_ROLE}
    privileges: [DELETE, INSERT, SELECT, UPDATE]
`;

    const desired = parseTable(yaml);
    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };

    // First apply against an empty DB — establishes the grants.
    await applyPlan(desiredState, emptyActual());

    // After the first apply, role must hold table-level D/I/S/U on `example`.
    const tablePrivsBefore = await client.query(
      `SELECT privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = $1 AND table_name = $2 AND grantee = $3
        ORDER BY privilege_type`,
      [TEST_SCHEMA, 'example', TEST_ROLE],
    );
    expect(tablePrivsBefore.rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);

    // Re-introspect, then re-plan. With no YAML changes, the plan should be
    // empty — no GRANT, no REVOKE. The bug emits both.
    const introspected = await introspectTable(client, 'example', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['example', introspected]]),
    };
    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });
    const grantOps = plan.operations.filter(
      (op) =>
        op.type === 'grant_table' ||
        op.type === 'grant_column' ||
        op.type === 'revoke_table' ||
        op.type === 'revoke_column',
    );
    expect(grantOps).toEqual([]);

    // Belt and braces: actually apply the (should-be-empty) plan and verify
    // the table-level privileges are still present afterwards.
    await applyPlan(desiredState, actualState);
    const tablePrivsAfter = await client.query(
      `SELECT privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = $1 AND table_name = $2 AND grantee = $3
        ORDER BY privilege_type`,
      [TEST_SCHEMA, 'example', TEST_ROLE],
    );
    expect(tablePrivsAfter.rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('introspects a table-level grant as a single table-level GrantDef, not a per-column grant', async () => {
    // Set up: bare table with a table-level grant only (no column qualifiers).
    // information_schema.column_privileges still returns one row per column for
    // each column-grantable privilege — this test pins down that we must not
    // treat those rows as a column-level grant.
    await client.query(`CREATE TABLE "${TEST_SCHEMA}".plain (id integer PRIMARY KEY, a text, b text, c text)`);
    await client.query(`GRANT INSERT, SELECT, UPDATE ON TABLE "${TEST_SCHEMA}".plain TO "${TEST_ROLE}"`);

    const introspected = await introspectTable(client, 'plain', TEST_SCHEMA);
    const grants = introspected.grants ?? [];

    // Exactly one grant for the role: table-level (no `columns` field), with
    // the three privileges that were granted.
    const roleGrants = grants.filter((g) => g.to === TEST_ROLE);
    expect(roleGrants).toHaveLength(1);
    expect(roleGrants[0].columns).toBeUndefined();
    expect([...roleGrants[0].privileges].sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
