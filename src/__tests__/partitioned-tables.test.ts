import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable, getExistingTables } from '../introspect/index.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { parseTable } from '../schema/parser.js';
import { generateFromDb } from '../scaffold/index.js';
import type { TableSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_partition_${Date.now()}`;

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

function desiredFrom(tables: TableSchema[]): DesiredState {
  return {
    tables,
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions: null,
  };
}

const PARTITIONED_YAML = `
table: kpi_daily_facts
partition_by:
  strategy: range
  key: [as_of_date]
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
  - name: value
    type: numeric
primary_key: [id, as_of_date]
`;

// ─── Parser ──────────────────────────────────────────────────────

describe('parser: partition_by', () => {
  it('parses strategy and key', () => {
    const table = parseTable(PARTITIONED_YAML);
    expect(table.partition_by).toEqual({ strategy: 'range', key: ['as_of_date'] });
  });

  it('lower-cases the strategy', () => {
    const table = parseTable(`
table: t
partition_by:
  strategy: RANGE
  key: [d]
columns:
  - name: d
    type: date
    nullable: false
`);
    expect(table.partition_by!.strategy).toBe('range');
  });

  it('rejects an unknown strategy', () => {
    expect(() =>
      parseTable(`
table: t
partition_by:
  strategy: sideways
  key: [d]
columns:
  - name: d
    type: date
`),
    ).toThrow(/strategy.*range, list, hash/i);
  });

  it('rejects a partition key column not declared in columns', () => {
    expect(() =>
      parseTable(`
table: t
partition_by:
  strategy: range
  key: [missing_col]
columns:
  - name: d
    type: date
`),
    ).toThrow(/missing_col.*not declared/i);
  });

  it('rejects unknown fields under partition_by', () => {
    expect(() =>
      parseTable(`
table: t
partition_by:
  strategy: range
  key: [d]
  premake: 3
columns:
  - name: d
    type: date
`),
    ).toThrow(/unknown field/i);
  });

  it('leaves partition_by undefined for ordinary tables', () => {
    const table = parseTable(`
table: plain
columns:
  - name: id
    type: uuid
    primary_key: true
`);
    expect(table.partition_by).toBeUndefined();
  });
});

// ─── Planner: behavioral apply ───────────────────────────────────

// A partitioned parent that ALSO declares a foreign key and a secondary
// index — the intersection #64 never exercised. Postgres forbids the two
// DDL forms schema-flow emits by default on a partitioned parent
// (`relkind='p'`): `ADD CONSTRAINT … FOREIGN KEY … NOT VALID` and
// `CREATE INDEX CONCURRENTLY`. The planner must emit the validated FK and a
// plain `CREATE INDEX` instead — both propagate to every partition.
const PARTITIONED_WITH_REFS_YAML = `
table: kpi_daily_facts
partition_by:
  strategy: range
  key: [as_of_date]
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
  - name: tenant_id
    type: uuid
    references:
      table: kpi_tenants
      column: id
  - name: value
    type: numeric
primary_key: [id, as_of_date]
indexes:
  - columns: [value]
`;

describe('planner: partitioned parent applies against Postgres', () => {
  it('creates a partitioned parent that also declares a FK and an index', async () => {
    // Referenced parent for the FK.
    await client.query(`CREATE TABLE "${TEST_SCHEMA}".kpi_tenants (id uuid PRIMARY KEY)`);

    const plan = buildPlan(desiredFrom([parseTable(PARTITIONED_WITH_REFS_YAML)]), emptyActual(), {
      pgSchema: TEST_SCHEMA,
    });
    for (const op of [...plan.operations].sort((a, b) => a.phase - b.phase)) {
      await client.query(op.sql);
    }

    // The parent is actually partitioned (relkind 'p').
    const { rows: rel } = await client.query(
      `SELECT c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'kpi_daily_facts'`,
      [TEST_SCHEMA],
    );
    expect(rel[0].relkind).toBe('p');

    // The FK landed and is validated — no NOT VALID constraint left behind.
    const { rows: fk } = await client.query(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = '"${TEST_SCHEMA}".kpi_daily_facts'::regclass AND contype = 'f'`,
    );
    expect(fk).toHaveLength(1);
    expect(fk[0].convalidated).toBe(true);

    // The index landed on the parent.
    const { rows: idx } = await client.query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'kpi_daily_facts' AND indexdef ILIKE '%(value)%'`,
      [TEST_SCHEMA],
    );
    expect(idx).toHaveLength(1);
  });

  it('refuses to convert an ordinary table into a partitioned one in place', () => {
    const existing: TableSchema = {
      table: 'kpi_daily_facts',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'as_of_date', type: 'date', nullable: false },
        { name: 'value', type: 'numeric' },
      ],
      primary_key: ['id', 'as_of_date'],
    };
    expect(() =>
      buildPlan(
        desiredFrom([parseTable(PARTITIONED_YAML)]),
        { ...emptyActual(), tables: new Map([['kpi_daily_facts', existing]]) },
        { pgSchema: TEST_SCHEMA },
      ),
    ).toThrow(/partitioning cannot be changed in place/i);
  });
});

// ─── Introspection ───────────────────────────────────────────────

describe('introspection: partitioned parents', () => {
  it('reads partition_by from a partitioned parent', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".facts (
        id uuid NOT NULL,
        as_of_date date NOT NULL,
        value numeric,
        PRIMARY KEY (id, as_of_date)
      ) PARTITION BY RANGE (as_of_date)
    `);

    const table = await introspectTable(client, 'facts', TEST_SCHEMA);
    expect(table.partition_by).toEqual({ strategy: 'range', key: ['as_of_date'] });
  });

  it('reads a multi-column / LIST partition key', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".events (
        id uuid NOT NULL,
        region text NOT NULL,
        PRIMARY KEY (id, region)
      ) PARTITION BY LIST (region)
    `);
    const table = await introspectTable(client, 'events', TEST_SCHEMA);
    expect(table.partition_by).toEqual({ strategy: 'list', key: ['region'] });
  });

  it('includes the partitioned parent but EXCLUDES child partitions from the table list', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".rollups (
        id uuid NOT NULL,
        as_of_date date NOT NULL,
        PRIMARY KEY (id, as_of_date)
      ) PARTITION BY RANGE (as_of_date)
    `);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".rollups_2026_06
        PARTITION OF "${TEST_SCHEMA}".rollups
        FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')
    `);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".rollups_default
        PARTITION OF "${TEST_SCHEMA}".rollups DEFAULT
    `);

    const tables = await getExistingTables(client, TEST_SCHEMA);
    expect(tables).toContain('rollups');
    expect(tables).not.toContain('rollups_2026_06');
    expect(tables).not.toContain('rollups_default');
  });
});

// ─── Scaffold round-trip ─────────────────────────────────────────

describe('scaffold: partition_by round-trip', () => {
  it('emits partition_by in generated YAML', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".scaffold_part (
        id uuid NOT NULL,
        as_of_date date NOT NULL,
        PRIMARY KEY (id, as_of_date)
      ) PARTITION BY RANGE (as_of_date)
    `);
    const table = await introspectTable(client, 'scaffold_part', TEST_SCHEMA);
    const files = generateFromDb({
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });
    const tableFile = files.find((f) => f.filename === 'tables/scaffold_part.yaml');
    expect(tableFile).toBeDefined();
    expect(tableFile!.content).toContain('partition_by:');
    expect(tableFile!.content).toMatch(/strategy: range/);

    // And the emitted YAML parses back to the same partition_by.
    expect(parseTable(tableFile!.content).partition_by).toEqual({ strategy: 'range', key: ['as_of_date'] });
  });
});

// ─── E2E: full no-op convergence ─────────────────────────────────

describe('E2E: partitioned table convergence', () => {
  it('a parent with rolling children re-plans to zero churn (no create, no drop)', async () => {
    // Apply the parent from YAML the way the CLI would.
    const desired = parseTable(`
table: kpi_e2e
partition_by:
  strategy: range
  key: [as_of_date]
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
  - name: value
    type: numeric
primary_key: [id, as_of_date]
`);
    const plan = buildPlan(desiredFrom([desired]), emptyActual(), { pgSchema: TEST_SCHEMA });
    for (const op of [...plan.operations].sort((a, b) => a.phase - b.phase)) {
      await client.query(op.sql);
    }

    // Simulate an out-of-band partition manager (pg_partman-style): children
    // and a DEFAULT created outside schema-flow's model.
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".kpi_e2e_2026_06
        PARTITION OF "${TEST_SCHEMA}".kpi_e2e
        FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')
    `);
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".kpi_e2e_default
        PARTITION OF "${TEST_SCHEMA}".kpi_e2e DEFAULT
    `);

    // Rebuild actual state the way the pipeline does: list tables, introspect each.
    const tableNames = await getExistingTables(client, TEST_SCHEMA);
    const tablesMap = new Map<string, TableSchema>();
    for (const name of tableNames) {
      tablesMap.set(name, await introspectTable(client, name, TEST_SCHEMA));
    }

    // The parent round-trips its partition_by.
    expect(tablesMap.get('kpi_e2e')?.partition_by).toEqual({ strategy: 'range', key: ['as_of_date'] });

    // Re-plan against only the declared parent — children must NOT be dropped,
    // and the parent must not be recreated or altered. (Other tables left in the
    // shared test schema by earlier cases are legitimately dropped; we only
    // assert on kpi_e2e and its children here.)
    const replan = buildPlan(
      desiredFrom([desired]),
      { ...emptyActual(), tables: tablesMap },
      { pgSchema: TEST_SCHEMA, allowDestructive: true },
    );

    // No child partition is ever dropped as an "undeclared table".
    const childDrops = replan.operations.filter(
      (op) => op.type === 'drop_table' && (op.objectName === 'kpi_e2e_2026_06' || op.objectName === 'kpi_e2e_default'),
    );
    expect(childDrops).toHaveLength(0);

    // The declared parent is not recreated or altered.
    const parentChurn = replan.operations.filter(
      (op) =>
        op.objectName === 'kpi_e2e' &&
        ['create_table', 'drop_table', 'add_column', 'drop_column', 'alter_column'].includes(op.type),
    );
    expect(parentChurn).toHaveLength(0);
  });
});
