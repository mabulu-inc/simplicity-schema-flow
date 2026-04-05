import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift } from '../drift/index.js';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_chk_varchar_${Date.now()}`;

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

describe('check constraint varchar cast normalization', () => {
  it('drift reports zero when expressions differ only by redundant ::text casts', async () => {
    // Create the table directly with a varchar IN check constraint.
    // PG will serialize the constraint with ::character varying::text on each element.
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".events (
        id serial PRIMARY KEY,
        source varchar(50) NOT NULL,
        CONSTRAINT chk_source_valid CHECK (
          source::text = ANY (ARRAY['web'::character varying, 'api'::character varying, 'import'::character varying]::text[])
        )
      )
    `);

    // Introspect — PG will return ::character varying::text on each element
    const introspected = await introspectTable(client, 'events', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['events', introspected]]),
    };

    // Desired YAML uses the form WITHOUT the redundant ::text casts
    // This is what the user would write, or what scaffold would produce from
    // the first apply (before PG adds ::text).
    const desired = parseTable(`
table: events
columns:
  - name: id
    type: serial
    primary_key: true
  - name: source
    type: varchar(50)
    nullable: false
checks:
  - name: chk_source_valid
    expression: "source::text = ANY (ARRAY['web'::character varying, 'api'::character varying, 'import'::character varying]::text[])"
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const report = detectDrift(desiredState, actualState);

    const constraintDrift = report.items.filter(
      (item) => item.type === 'constraint' && item.object.includes('chk_source_valid'),
    );
    expect(constraintDrift).toHaveLength(0);
  });

  it('planner emits no ops when check expressions differ only by redundant ::text casts', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".categories (
        id serial PRIMARY KEY,
        category varchar(30) NOT NULL,
        CONSTRAINT chk_category CHECK (
          category::text = ANY (ARRAY['news'::character varying, 'blog'::character varying]::text[])
        )
      )
    `);

    const introspected = await introspectTable(client, 'categories', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['categories', introspected]]),
    };

    const desired = parseTable(`
table: categories
columns:
  - name: id
    type: serial
    primary_key: true
  - name: category
    type: varchar(30)
    nullable: false
checks:
  - name: chk_category
    expression: "category::text = ANY (ARRAY['news'::character varying, 'blog'::character varying]::text[])"
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const plan = buildPlan(desiredState, actualState, { pgSchema: TEST_SCHEMA });

    const checkOps = plan.operations.filter((op) => op.type === 'drop_check' || op.type === 'add_check');
    expect(checkOps).toHaveLength(0);
  });

  it('drift still detects genuinely different check expressions', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".events_genuine (
        id serial PRIMARY KEY,
        source varchar(50) NOT NULL,
        CONSTRAINT chk_source CHECK (
          source::text = ANY (ARRAY['web'::character varying, 'api'::character varying]::text[])
        )
      )
    `);

    const introspected = await introspectTable(client, 'events_genuine', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['events_genuine', introspected]]),
    };

    // YAML has a genuinely different expression (added 'import')
    const desired = parseTable(`
table: events_genuine
columns:
  - name: id
    type: serial
    primary_key: true
  - name: source
    type: varchar(50)
    nullable: false
checks:
  - name: chk_source
    expression: "source::text = ANY (ARRAY['web'::character varying, 'api'::character varying, 'import'::character varying]::text[])"
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const report = detectDrift(desiredState, actualState);

    const constraintDrift = report.items.filter(
      (item) => item.type === 'constraint' && item.object.includes('chk_source'),
    );
    expect(constraintDrift).toHaveLength(1);
    expect(constraintDrift[0].status).toBe('different');
  });
});
