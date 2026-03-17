import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_idem_trig_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  // Create a trigger function used by the tests
  await client.query(`
    CREATE FUNCTION ${TEST_SCHEMA}.audit_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
  `);
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

describe('idempotent trigger creation', () => {
  it('generates DROP TRIGGER IF EXISTS before CREATE TRIGGER in the SQL', () => {
    const yaml = `
table: events
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: payload
    type: jsonb
triggers:
  - name: trg_audit
    timing: AFTER
    events: [INSERT]
    function: audit_fn
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    // Find the trigger operation
    const triggerOp = plan.operations.find((op) => op.type === 'create_trigger');
    expect(triggerOp).toBeDefined();
    expect(triggerOp!.sql).toContain('DROP TRIGGER IF EXISTS');
    expect(triggerOp!.sql).toContain('CREATE TRIGGER');
  });

  it('trigger SQL executes successfully when trigger already exists', async () => {
    const yaml = `
table: test_trig_table
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
triggers:
  - name: trg_test
    timing: BEFORE
    events: [INSERT, UPDATE]
    function: audit_fn
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    // Execute all operations to create the table and trigger
    for (const op of plan.operations) {
      await client.query(op.sql);
    }

    // Now build a new plan (same desired state, still empty actual) and re-execute.
    // This simulates re-running when the trigger already exists.
    const plan2 = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });
    const triggerOp = plan2.operations.find((op) => op.type === 'create_trigger');
    expect(triggerOp).toBeDefined();

    // This should NOT throw 42710 (duplicate_object)
    await expect(client.query(triggerOp!.sql)).resolves.not.toThrow();
  });

  it('trigger with WHEN clause also gets idempotency guard', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: status
    type: text
triggers:
  - name: trg_status_change
    timing: AFTER
    events: [UPDATE]
    function: audit_fn
    when: "OLD.status IS DISTINCT FROM NEW.status"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    const triggerOp = plan.operations.find((op) => op.type === 'create_trigger');
    expect(triggerOp).toBeDefined();
    expect(triggerOp!.sql).toContain('DROP TRIGGER IF EXISTS');
    expect(triggerOp!.sql).toContain('CREATE TRIGGER');
    expect(triggerOp!.sql).toContain('WHEN');
  });
});
