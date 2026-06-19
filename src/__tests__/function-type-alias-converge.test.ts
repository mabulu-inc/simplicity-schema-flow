import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { detectDrift } from '../drift/index.js';
import { getExistingFunctions } from '../introspect/index.js';
import { parseFunction } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_fn_alias_${Date.now()}`;

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

async function actualWithFunctions(): Promise<ActualState> {
  const fns = await getExistingFunctions(client, TEST_SCHEMA);
  return { ...emptyActual(), functions: new Map(fns.map((f) => [f.name, f])) };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA "${TEST_SCHEMA}" CASCADE`);
  client.release();
  await pool.end();
});

describe('function type-alias convergence (issue #63)', () => {
  it('a TABLE return using timestamptz/int8/array aliases converges to zero ops', async () => {
    const fn = parseFunction(`
name: alias_table_fn
language: sql
returns: 'TABLE(user_id int8, expires_at timestamptz, roles text[])'
body: |
  SELECT 1::bigint, now(), ARRAY['a']::text[]
`);

    // First apply creates it.
    await applyPlan({ ...emptyDesired(), functions: [fn] }, emptyActual());

    // Re-plan against the live DB — must report zero function ops.
    const plan = buildPlan({ ...emptyDesired(), functions: [fn] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
    });
    const fnOps = plan.operations.filter((op) => op.type === 'create_function');
    expect(fnOps).toHaveLength(0);
  });

  it('a scalar int8 return and a varchar arg converge to zero ops', async () => {
    const fn = parseFunction(`
name: alias_scalar_fn
language: sql
returns: int8
args:
  - name: p
    type: varchar
body: |
  SELECT length(p)::bigint
`);

    await applyPlan({ ...emptyDesired(), functions: [fn] }, emptyActual());

    const plan = buildPlan({ ...emptyDesired(), functions: [fn] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
    });
    expect(plan.operations.filter((op) => op.type === 'create_function')).toHaveLength(0);
  });

  it('drift reports no difference for alias-only signatures', async () => {
    const fn = parseFunction(`
name: alias_table_fn
language: sql
returns: 'TABLE(user_id int8, expires_at timestamptz, roles text[])'
body: |
  SELECT 1::bigint, now(), ARRAY['a']::text[]
`);
    const report = detectDrift({ ...emptyDesired(), functions: [fn] }, await actualWithFunctions());
    const fnDrift = report.items.filter((i) => i.type === 'function' && i.object === 'alias_table_fn');
    expect(fnDrift).toHaveLength(0);
  });
});
