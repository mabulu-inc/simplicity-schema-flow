import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift, hydrateActualSeeds } from '../drift/index.js';
import { introspectTable } from '../introspect/index.js';
import { parseTable } from '../schema/parser.js';
import type { DesiredState, ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_drift_uq_idx_${Date.now()}`;

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

describe('drift: unique: true column with explicit index overlap', () => {
  it('reports zero drift when column unique: true has matching explicit index entry', async () => {
    // Simulate what PG looks like after schema-flow apply:
    // unique: true on a column creates a UNIQUE CONSTRAINT (with backing index)
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".roles (
        id uuid PRIMARY KEY NOT NULL,
        name text NOT NULL,
        CONSTRAINT roles_name_key UNIQUE (name)
      )
    `);

    const desired = parseTable(`
table: roles
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
    unique: true
indexes:
  - name: roles_name_key
    columns: [name]
    unique: true
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const introspected = await introspectTable(client, 'roles', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['roles', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    expect(report.items).toHaveLength(0);
  });

  it('reports zero drift with seeds when column unique: true has matching explicit index', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".roles_seeded (
        id uuid PRIMARY KEY NOT NULL,
        name text NOT NULL,
        CONSTRAINT roles_seeded_name_key UNIQUE (name)
      )
    `);
    await client.query(`
      INSERT INTO "${TEST_SCHEMA}".roles_seeded (id, name) VALUES
        ('550e8400-e29b-41d4-a716-446655440000', 'admin'),
        ('550e8400-e29b-41d4-a716-446655440001', 'viewer')
    `);

    const desired = parseTable(`
table: roles_seeded
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
    unique: true
indexes:
  - name: roles_seeded_name_key
    columns: [name]
    unique: true
seeds:
  - id: "550e8400-e29b-41d4-a716-446655440000"
    name: admin
  - id: "550e8400-e29b-41d4-a716-446655440001"
    name: viewer
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const introspected = await introspectTable(client, 'roles_seeded', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['roles_seeded', introspected]]),
    };

    await hydrateActualSeeds(client, desiredState.tables, actualState.tables, TEST_SCHEMA);

    const report = detectDrift(desiredState, actualState);

    expect(report.items).toHaveLength(0);
  });

  it('still detects genuinely missing non-overlapping indexes', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".roles_partial (
        id uuid PRIMARY KEY NOT NULL,
        name text NOT NULL,
        CONSTRAINT roles_partial_name_key UNIQUE (name)
      )
    `);

    const desired = parseTable(`
table: roles_partial
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
    unique: true
indexes:
  - name: roles_partial_name_key
    columns: [name]
    unique: true
  - name: idx_roles_partial_name_lower
    columns: [name]
`);

    const desiredState: DesiredState = { ...emptyDesired(), tables: [desired] };
    const introspected = await introspectTable(client, 'roles_partial', TEST_SCHEMA);
    const actualState: ActualState = {
      ...emptyActual(),
      tables: new Map([['roles_partial', introspected]]),
    };
    const report = detectDrift(desiredState, actualState);

    // The overlapping index (roles_partial_name_key) should NOT cause drift
    const overlappingDrift = report.items.filter(
      (i) => i.object === 'roles_partial_name_key' || i.object.includes('roles_partial_name_key'),
    );
    expect(overlappingDrift).toHaveLength(0);

    // The genuinely missing index SHOULD cause drift
    const missingIdx = report.items.filter((i) => i.object === 'idx_roles_partial_name_lower');
    expect(missingIdx).toHaveLength(1);
    expect(missingIdx[0].status).toBe('missing_in_db');
  });
});
