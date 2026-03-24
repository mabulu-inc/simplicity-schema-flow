import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_numeric_precision_${Date.now()}`;

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

describe('numeric precision introspection', () => {
  it('introspects numeric(p,s) columns with full precision and scale', async () => {
    await client.query(`
      CREATE TABLE ${TEST_SCHEMA}.prices (
        id serial PRIMARY KEY,
        amount numeric(15,2) NOT NULL,
        rate numeric(10,4) NOT NULL,
        plain_numeric numeric
      )
    `);

    const table = await introspectTable(client, 'prices', TEST_SCHEMA);
    const amountCol = table.columns.find((c) => c.name === 'amount');
    const rateCol = table.columns.find((c) => c.name === 'rate');
    const plainCol = table.columns.find((c) => c.name === 'plain_numeric');

    expect(amountCol).toBeDefined();
    expect(amountCol!.type).toBe('numeric(15,2)');

    expect(rateCol).toBeDefined();
    expect(rateCol!.type).toBe('numeric(10,4)');

    // Plain numeric without precision should remain as 'numeric'
    expect(plainCol).toBeDefined();
    expect(plainCol!.type).toBe('numeric');
  });

  it('produces zero operations when numeric(p,s) columns match YAML', async () => {
    await client.query(`
      CREATE TABLE ${TEST_SCHEMA}.invoices (
        id serial PRIMARY KEY,
        total numeric(12,2) NOT NULL
      )
    `);

    const yaml = `
table: invoices
columns:
  - name: id
    type: serial
    primary_key: true
  - name: total
    type: numeric(12,2)
    nullable: false
`;
    const desiredTable = parseTable(yaml);
    const actualTable = await introspectTable(client, 'invoices', TEST_SCHEMA);

    const desired: DesiredState = { ...emptyDesired(), tables: [desiredTable] };
    const actual: ActualState = {
      ...emptyActual(),
      tables: new Map([['invoices', actualTable]]),
    };

    const plan = buildPlan(desired, actual);
    // No phantom ALTER COLUMN TYPE operations
    const alterTypeOps = plan.operations.filter((o) => o.type === 'alter_column' && o.sql.includes('TYPE'));
    expect(alterTypeOps).toHaveLength(0);
  });

  it('introspects varchar(N) and char(N) columns correctly', async () => {
    await client.query(`
      CREATE TABLE ${TEST_SCHEMA}.strings (
        id serial PRIMARY KEY,
        code varchar(10) NOT NULL,
        fixed char(5),
        unlimited varchar
      )
    `);

    const table = await introspectTable(client, 'strings', TEST_SCHEMA);
    const codeCol = table.columns.find((c) => c.name === 'code');
    const fixedCol = table.columns.find((c) => c.name === 'fixed');
    const unlimitedCol = table.columns.find((c) => c.name === 'unlimited');

    expect(codeCol!.type).toBe('varchar(10)');
    expect(fixedCol!.type).toBe('char(5)');
    expect(unlimitedCol!.type).toBe('varchar');
  });
});
