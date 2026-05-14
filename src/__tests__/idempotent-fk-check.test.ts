import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_idem_fkchk_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
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

describe('idempotent foreign key creation', () => {
  it('wraps FK NOT VALID in a DO block with pg_constraint check', () => {
    const parentYaml = `
table: parents
columns:
  - name: id
    type: uuid
    primary_key: true
`;
    const childYaml = `
table: children
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: parent_id
    type: uuid
    references:
      table: parents
      column: id
`;
    const parent = parseTable(parentYaml);
    const child = parseTable(childYaml);
    const desired = emptyDesired();
    desired.tables.push(parent, child);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    const fkOp = plan.operations.find((op) => op.type === 'add_foreign_key_not_valid');
    expect(fkOp).toBeDefined();
    expect(fkOp!.sql).toContain('DO $$ BEGIN');
    expect(fkOp!.sql).toContain('pg_constraint');
    expect(fkOp!.sql).toContain('IF NOT EXISTS');
    expect(fkOp!.sql).toContain('NOT VALID');
    expect(fkOp!.sql).toContain('END $$');
  });

  it('FK SQL executes successfully when constraint already exists', async () => {
    const parentYaml = `
table: fk_parent
columns:
  - name: id
    type: serial
    primary_key: true
`;
    const childYaml = `
table: fk_child
columns:
  - name: id
    type: serial
    primary_key: true
  - name: parent_id
    type: integer
    references:
      table: fk_parent
      column: id
`;
    const parent = parseTable(parentYaml);
    const child = parseTable(childYaml);
    const desired = emptyDesired();
    desired.tables.push(parent, child);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    // Execute all operations (creates tables and FK)
    for (const op of plan.operations) {
      await client.query(op.sql);
    }

    // Re-run the same plan — FK already exists, should NOT throw 42710
    const plan2 = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });
    const fkOps = plan2.operations.filter(
      (op) => op.type === 'add_foreign_key_not_valid' || op.type === 'validate_constraint',
    );
    expect(fkOps.length).toBeGreaterThan(0);

    for (const op of fkOps) {
      await expect(client.query(op.sql)).resolves.not.toThrow();
    }
  });
});

describe('idempotent check constraint creation', () => {
  it('wraps CHECK in a DO block with pg_constraint check (via diffChecks)', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: amount
    type: numeric
checks:
  - name: chk_positive_amount
    expression: "amount > 0"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);

    // Table already exists but without checks — triggers diffChecks
    const actual = emptyActual();
    actual.tables.set('orders', {
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, generated: null, identity: null },
        { name: 'amount', type: 'numeric', nullable: true, default: null, generated: null, identity: null },
      ],
      indexes: [],
      checks: [],
      uniqueConstraints: [],
      triggers: [],
      policies: [],
      grants: [],
      rlsEnabled: false,
      rlsForced: false,
      comment: null,
      primaryKey: ['id'],
    });

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });

    const checkOp = plan.operations.find((op) => op.type === 'add_check');
    expect(checkOp).toBeDefined();
    expect(checkOp!.sql).toContain('DO $$ BEGIN');
    expect(checkOp!.sql).toContain('pg_constraint');
    expect(checkOp!.sql).toContain('IF NOT EXISTS');
    expect(checkOp!.sql).toContain('CHECK');
    expect(checkOp!.sql).toContain('END $$');
  });

  it('check constraint SQL executes successfully when already exists', async () => {
    // Create the table first
    await client.query(`CREATE TABLE "${TEST_SCHEMA}"."chk_orders" (id serial PRIMARY KEY, amount numeric)`);

    const yaml = `
table: chk_orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: amount
    type: numeric
checks:
  - name: chk_positive_amount
    expression: "amount > 0"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);

    // Table exists but no checks — diffChecks will emit add_check
    const actual = emptyActual();
    actual.tables.set('chk_orders', {
      columns: [
        {
          name: 'id',
          type: 'integer',
          nullable: false,
          default: "nextval('chk_orders_id_seq'::regclass)",
          generated: null,
          identity: null,
        },
        { name: 'amount', type: 'numeric', nullable: true, default: null, generated: null, identity: null },
      ],
      indexes: [],
      checks: [],
      uniqueConstraints: [],
      triggers: [],
      policies: [],
      grants: [],
      rlsEnabled: false,
      rlsForced: false,
      comment: null,
      primaryKey: ['id'],
    });

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });
    const checkOp = plan.operations.find((op) => op.type === 'add_check');
    expect(checkOp).toBeDefined();

    // Execute the check constraint (first time)
    await client.query(checkOp!.sql);

    // Execute again — should NOT throw 42710
    await expect(client.query(checkOp!.sql)).resolves.not.toThrow();
  });
});

describe('idempotent NOT NULL check constraint (NOT VALID)', () => {
  it('wraps NOT NULL check in a DO block with pg_constraint check', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);

    // Simulate existing table with nullable email, desired is NOT NULL
    const desiredNonNull = parseTable(`
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
    nullable: false
`);
    const desiredState = emptyDesired();
    desiredState.tables.push(desiredNonNull);

    const actual = emptyActual();
    actual.tables.set('users', {
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, generated: null, identity: null },
        { name: 'email', type: 'text', nullable: true, default: null, generated: null, identity: null },
      ],
      indexes: [],
      checks: [],
      uniqueConstraints: [],
      triggers: [],
      policies: [],
      grants: [],
      rlsEnabled: false,
      rlsForced: false,
      comment: null,
      primaryKey: ['id'],
    });

    const plan = buildPlan(desiredState, actual, { pgSchema: TEST_SCHEMA });
    // The 4-step pattern is now bundled into a tighten_not_null op; the
    // ADD CHECK statement inside still uses the DO-block idempotency guard.
    const tightenOp = plan.operations.find((op) => op.type === 'tighten_not_null');
    expect(tightenOp).toBeDefined();
    expect(tightenOp!.sql).toContain('DO $$ BEGIN');
    expect(tightenOp!.sql).toContain('pg_constraint');
    expect(tightenOp!.sql).toContain('NOT VALID');
    expect(tightenOp!.sql).toContain('END $$');
  });
});
