import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable, parseExtensions } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { introspectTable, getPartitionMaintenance } from '../introspect/index.js';
import { generateFromDb } from '../scaffold/index.js';
import { detectDrift } from '../drift/index.js';
import type { ExtensionsSchema, PartitionsDef, TableSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_partmaint_${Date.now()}`;

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

function desired(tables: TableSchema[], extensions: ExtensionsSchema | null): DesiredState {
  return { tables, enums: [], functions: [], views: [], materializedViews: [], roles: [], extensions };
}

const TABLE_YAML = `
table: kpi_daily_facts
partition_by:
  strategy: range
  key: [as_of_date]
partitions:
  granularity: month
  window: [-24, 3]
  default: true
  retention_keep_table: true
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
primary_key: [id, as_of_date]
`;

const EXT_YAML = `
extensions:
  - name: pg_partman
    schema: partman
  - pg_cron
partition_maintenance:
  schedule: '@hourly'
`;

// ─── Parser ──────────────────────────────────────────────────────

describe('parser: partitions + partition_maintenance', () => {
  it('parses the partitions block', () => {
    const t = parseTable(TABLE_YAML);
    expect(t.partitions).toEqual({
      granularity: 'month',
      window: [-24, 3],
      default: true,
      retention_keep_table: true,
    });
  });

  it('rejects an unknown granularity', () => {
    expect(() =>
      parseTable(`
table: t
partition_by: { strategy: range, key: [d] }
partitions: { granularity: fortnight, window: [-1, 1] }
columns: [{ name: d, type: date }]
`),
    ).toThrow(/granularity.*day, week, month, year/i);
  });

  it('rejects a positive history / negative future window', () => {
    expect(() =>
      parseTable(`
table: t
partition_by: { strategy: range, key: [d] }
partitions: { granularity: month, window: [24, 3] }
columns: [{ name: d, type: date }]
`),
    ).toThrow(/history.*<= 0/i);
  });

  it('parses partition_maintenance.schedule from extensions', () => {
    const e = parseExtensions(EXT_YAML);
    expect(e.partition_maintenance).toEqual({ schedule: '@hourly' });
  });
});

// ─── Planner: validation ─────────────────────────────────────────

describe('planner: partition-maintenance validation', () => {
  it('errors when partitions: is used without pg_partman declared', () => {
    expect(() => buildPlan(desired([parseTable(TABLE_YAML)], null), emptyActual(), { pgSchema: TEST_SCHEMA })).toThrow(
      /pg_partman is not in extensions/i,
    );
  });

  it('errors when pg_partman is declared without a schema', () => {
    const ext = parseExtensions(`extensions:\n  - pg_partman\n`);
    expect(() => buildPlan(desired([parseTable(TABLE_YAML)], ext), emptyActual(), { pgSchema: TEST_SCHEMA })).toThrow(
      /must be declared with an explicit schema/i,
    );
  });

  it('errors when partition_maintenance is set but pg_cron is missing', () => {
    const ext = parseExtensions(`
extensions:
  - name: pg_partman
    schema: partman
partition_maintenance:
  schedule: '@daily'
`);
    expect(() => buildPlan(desired([parseTable(TABLE_YAML)], ext), emptyActual(), { pgSchema: TEST_SCHEMA })).toThrow(
      /pg_cron is not in extensions/i,
    );
  });

  it('errors on a multi-column partition key (pg_partman is single-control)', () => {
    const t = parseTable(`
table: t
partition_by: { strategy: range, key: [a, b] }
partitions: { granularity: month, window: [-1, 1] }
columns: [{ name: a, type: date }, { name: b, type: date }]
`);
    const ext = parseExtensions(`extensions:\n  - name: pg_partman\n    schema: partman\n`);
    expect(() => buildPlan(desired([t], ext), emptyActual(), { pgSchema: TEST_SCHEMA })).toThrow(
      /single control column/i,
    );
  });
});

// ─── Planner: SQL generation ─────────────────────────────────────

describe('planner: partition-maintenance SQL', () => {
  it('emits create_parent + part_config with the mapped interval/retention', () => {
    const plan = buildPlan(desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML)), emptyActual(), {
      pgSchema: TEST_SCHEMA,
    });
    const cfg = plan.operations.find((o) => o.type === 'configure_partitions');
    expect(cfg).toBeDefined();
    expect(cfg!.sql).toContain('"partman".create_parent');
    expect(cfg!.sql).toContain("p_interval := '1 month'");
    expect(cfg!.sql).toContain("p_type := 'range'");
    expect(cfg!.sql).toContain('p_premake := 3');
    expect(cfg!.sql).toContain("retention = '24 months'");
    expect(cfg!.sql).toContain('retention_keep_table = true');
  });

  it('emits one cron.schedule job with the configured schedule', () => {
    const plan = buildPlan(desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML)), emptyActual(), {
      pgSchema: TEST_SCHEMA,
    });
    const cron = plan.operations.filter((o) => o.type === 'schedule_partition_maintenance');
    expect(cron).toHaveLength(1);
    expect(cron[0].sql).toContain("cron.schedule('schema_flow_partman_maintenance', '@hourly'");
    expect(cron[0].sql).toContain('"partman".run_maintenance_proc()');
  });

  it('re-emits the schedule when it changes', () => {
    const plan = buildPlan(
      desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML)),
      { ...emptyActual(), partitionMaintenance: { schedule: '@daily' } },
      { pgSchema: TEST_SCHEMA },
    );
    const cron = plan.operations.filter((o) => o.type === 'schedule_partition_maintenance');
    expect(cron).toHaveLength(1);
    expect(cron[0].sql).toContain("'@hourly'");
  });

  it('omits the cron job when pg_cron is not declared', () => {
    const ext = parseExtensions(`extensions:\n  - name: pg_partman\n    schema: partman\n`);
    const plan = buildPlan(desired([parseTable(TABLE_YAML)], ext), emptyActual(), { pgSchema: TEST_SCHEMA });
    expect(plan.operations.filter((o) => o.type === 'schedule_partition_maintenance')).toHaveLength(0);
    // …but partman config is still emitted.
    expect(plan.operations.filter((o) => o.type === 'configure_partitions')).toHaveLength(1);
  });
});

// ─── E2E: live pg_partman ────────────────────────────────────────

describe('E2E: pg_partman registers the parent and rolls partitions', () => {
  it('runs create_extension → create_table → configure_partitions against real pg_partman', async () => {
    const table = parseTable(`
table: kpi_e2e
partition_by:
  strategy: range
  key: [as_of_date]
partitions:
  granularity: month
  window: [-6, 2]
  default: true
  retention_keep_table: true
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
primary_key: [id, as_of_date]
`);
    const ext = parseExtensions(`extensions:\n  - name: pg_partman\n    schema: partman\n`);

    const plan = buildPlan(desired([table], ext), emptyActual(), { pgSchema: TEST_SCHEMA });
    for (const op of [...plan.operations].sort((a, b) => a.phase - b.phase)) {
      await client.query(op.sql);
    }

    // pg_partman registered the parent with our window/retention.
    const cfg = await client.query(
      `SELECT partition_interval, premake, retention, retention_keep_table
         FROM partman.part_config WHERE parent_table = $1`,
      [`${TEST_SCHEMA}.kpi_e2e`],
    );
    expect(cfg.rows).toHaveLength(1);
    expect(cfg.rows[0].premake).toBe(2);
    expect(cfg.rows[0].retention).toBe('6 months');
    expect(cfg.rows[0].retention_keep_table).toBe(true);

    // Child partitions were premade, plus a DEFAULT.
    const children = await client.query(
      `SELECT count(*)::int AS n FROM pg_inherits
         WHERE inhparent = $1::regclass`,
      [`"${TEST_SCHEMA}".kpi_e2e`],
    );
    expect(children.rows[0].n).toBeGreaterThan(1);

    // Idempotent: applying the configure op again does not error.
    const cfgOp = plan.operations.find((o) => o.type === 'configure_partitions')!;
    await expect(client.query(cfgOp.sql)).resolves.toBeDefined();

    // Round-trip: introspection reconstructs the partitions: block from part_config.
    const introspected = await introspectTable(client, 'kpi_e2e', TEST_SCHEMA);
    expect(introspected.partitions).toEqual({
      granularity: 'month',
      window: [-6, 2],
      default: true,
      retention_keep_table: true,
    });

    // No-op convergence: re-planning against the introspected state emits no
    // configure_partitions op for this table.
    const replan = buildPlan(
      desired([table], ext),
      { ...emptyActual(), tables: new Map([['kpi_e2e', introspected]]) },
      { pgSchema: TEST_SCHEMA },
    );
    expect(
      replan.operations.filter((o) => o.type === 'configure_partitions' && o.objectName === 'kpi_e2e'),
    ).toHaveLength(0);

    // A changed window re-emits the configure op.
    const changed = parseTable(`
table: kpi_e2e
partition_by: { strategy: range, key: [as_of_date] }
partitions: { granularity: month, window: [-12, 2] }
columns:
  - { name: id, type: uuid, nullable: false }
  - { name: as_of_date, type: date, nullable: false }
primary_key: [id, as_of_date]
`);
    const changedPlan = buildPlan(
      desired([changed], ext),
      { ...emptyActual(), tables: new Map([['kpi_e2e', introspected]]) },
      { pgSchema: TEST_SCHEMA },
    );
    expect(
      changedPlan.operations.filter((o) => o.type === 'configure_partitions' && o.objectName === 'kpi_e2e'),
    ).toHaveLength(1);
  });
});

// ─── E2E: live pg_cron ───────────────────────────────────────────

describe('E2E: pg_cron accepts the generated maintenance schedule', () => {
  it('schedules run_maintenance_proc via cron.schedule', async () => {
    // pg_cron can only be installed in cron.database_name (default: postgres),
    // so run this against the admin DB rather than this file's throwaway DB.
    const adminUrl = new URL(TEST_URL);
    adminUrl.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS partman`);
      await admin.query(`CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman`);
      await admin.query(`CREATE EXTENSION IF NOT EXISTS pg_cron`);

      const ext = parseExtensions(EXT_YAML);
      const plan = buildPlan(desired([parseTable(TABLE_YAML)], ext), emptyActual(), { pgSchema: TEST_SCHEMA });
      const cronOp = plan.operations.find((o) => o.type === 'schedule_partition_maintenance')!;

      await admin.query(cronOp.sql);
      const job = await admin.query(`SELECT schedule, command FROM cron.job WHERE jobname = $1`, [
        'schema_flow_partman_maintenance',
      ]);
      expect(job.rows).toHaveLength(1);
      expect(job.rows[0].schedule).toBe('@hourly');
      expect(job.rows[0].command).toContain('run_maintenance_proc');

      // Re-running upserts (no duplicate job).
      await admin.query(cronOp.sql);
      const again = await admin.query(`SELECT count(*)::int AS n FROM cron.job WHERE jobname = $1`, [
        'schema_flow_partman_maintenance',
      ]);
      expect(again.rows[0].n).toBe(1);

      // No-op convergence: introspect the live job, re-plan → no schedule op.
      const actualMaintenance = await getPartitionMaintenance(admin);
      expect(actualMaintenance).toEqual({ schedule: '@hourly' });
      const replan = buildPlan(
        desired([parseTable(TABLE_YAML)], ext),
        { ...emptyActual(), partitionMaintenance: actualMaintenance },
        { pgSchema: TEST_SCHEMA },
      );
      expect(replan.operations.filter((o) => o.type === 'schedule_partition_maintenance')).toHaveLength(0);

      await admin.query(`SELECT cron.unschedule('schema_flow_partman_maintenance')`);
    } finally {
      await admin.end();
    }
  });
});

// ─── Scaffold round-trip ─────────────────────────────────────────

describe('scaffold: partitions: round-trip', () => {
  it('emits the partitions block from an introspected pg_partman table', async () => {
    await client.query(`
      CREATE TABLE "${TEST_SCHEMA}".scaffold_p (
        id uuid NOT NULL, as_of_date date NOT NULL, PRIMARY KEY (id, as_of_date)
      ) PARTITION BY RANGE (as_of_date)
    `);
    await client.query(
      `SELECT partman.create_parent(p_parent_table := $1, p_control := 'as_of_date', p_interval := '1 month', p_type := 'range', p_premake := 4, p_default_table := true)`,
      [`${TEST_SCHEMA}.scaffold_p`],
    );
    await client.query(
      `UPDATE partman.part_config SET retention = '12 months', retention_keep_table = false WHERE parent_table = $1`,
      [`${TEST_SCHEMA}.scaffold_p`],
    );

    const table = await introspectTable(client, 'scaffold_p', TEST_SCHEMA);
    const files = generateFromDb({
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });
    const yaml = files.find((f) => f.filename === 'tables/scaffold_p.yaml')!.content;
    expect(yaml).toContain('partitions:');
    expect(yaml).toContain('granularity: month');
    expect(yaml).toContain('retention_keep_table: false');

    // And it parses back to the introspected shape.
    expect(parseTable(yaml).partitions).toEqual({
      granularity: 'month',
      window: [-12, 4],
      retention_keep_table: false,
    });
  });
});

// ─── Drift detection ─────────────────────────────────────────────

describe('drift: partition config + maintenance schedule', () => {
  function actualPartitioned(name: string, partitions: PartitionsDef): TableSchema {
    return {
      table: name,
      columns: [
        { name: 'id', type: 'uuid' },
        { name: 'as_of_date', type: 'date' },
      ],
      partition_by: { strategy: 'range', key: ['as_of_date'] },
      partitions,
    };
  }

  function partitionItems(desiredState: DesiredState, actualState: ActualState) {
    return detectDrift(desiredState, actualState).items.filter((i) => i.type === 'partition');
  }

  it('reports drift when a partition window changes', () => {
    const d = desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML));
    const a: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'kpi_daily_facts',
          actualPartitioned('kpi_daily_facts', {
            granularity: 'month',
            window: [-12, 3],
            default: true,
            retention_keep_table: true,
          }),
        ],
      ]),
      partitionMaintenance: { schedule: '@hourly' },
    };
    const items = partitionItems(d, a);
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'partition', object: 'kpi_daily_facts', status: 'different' }),
    );
  });

  it('reports a parent not yet registered with pg_partman', () => {
    const d = desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML));
    const a: ActualState = {
      ...emptyActual(),
      tables: new Map([['kpi_daily_facts', { table: 'kpi_daily_facts', columns: [{ name: 'id', type: 'uuid' }] }]]),
      partitionMaintenance: { schedule: '@hourly' },
    };
    const items = partitionItems(d, a);
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'partition', object: 'kpi_daily_facts', status: 'missing_in_db' }),
    );
  });

  it('reports maintenance schedule drift', () => {
    const d = desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML)); // wants @hourly
    const a: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'kpi_daily_facts',
          actualPartitioned('kpi_daily_facts', {
            granularity: 'month',
            window: [-24, 3],
            default: true,
            retention_keep_table: true,
          }),
        ],
      ]),
      partitionMaintenance: { schedule: '@daily' },
    };
    const items = partitionItems(d, a);
    expect(items).toContainEqual(
      expect.objectContaining({
        type: 'partition',
        object: 'maintenance_schedule',
        status: 'different',
        expected: '@hourly',
        actual: '@daily',
      }),
    );
  });

  it('reports a missing maintenance schedule', () => {
    const d = desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML));
    const a: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'kpi_daily_facts',
          actualPartitioned('kpi_daily_facts', {
            granularity: 'month',
            window: [-24, 3],
            default: true,
            retention_keep_table: true,
          }),
        ],
      ]),
      partitionMaintenance: null,
    };
    const items = partitionItems(d, a);
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'partition', object: 'maintenance_schedule', status: 'missing_in_db' }),
    );
  });

  it('reports no partition drift when fully converged', () => {
    const d = desired([parseTable(TABLE_YAML)], parseExtensions(EXT_YAML));
    const a: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'kpi_daily_facts',
          actualPartitioned('kpi_daily_facts', {
            granularity: 'month',
            window: [-24, 3],
            default: true,
            retention_keep_table: true,
          }),
        ],
      ]),
      partitionMaintenance: { schedule: '@hourly' },
    };
    expect(partitionItems(d, a)).toHaveLength(0);
  });
});
