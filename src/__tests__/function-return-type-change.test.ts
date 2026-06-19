import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getExistingFunctions } from '../introspect/index.js';
import { parseFunction } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_fn_rt_${Date.now()}`;

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

async function actualWithFunctions(): Promise<ActualState> {
  const fns = await getExistingFunctions(client, TEST_SCHEMA);
  return { ...emptyActual(), functions: new Map(fns.map((f) => [f.name, f])) };
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

describe('function return-type change → DROP+CREATE (issue #62)', () => {
  it('blocks the change (drop only, no doomed create) without --allow-destructive', async () => {
    await client.query(`CREATE FUNCTION "${TEST_SCHEMA}".rt_blocked() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);

    const desired = parseFunction(`
name: rt_blocked
language: sql
returns: bigint
body: 'SELECT 1::bigint'
`);

    const plan = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
      allowDestructive: false,
    });

    // The drop is destructive → blocked. The create must NOT be attempted,
    // since CREATE OR REPLACE can't change a return type (it would fail 42P13).
    expect(plan.blocked.some((o) => o.type === 'drop_function')).toBe(true);
    expect(plan.operations.some((o) => o.type === 'create_function' && o.objectName === 'rt_blocked')).toBe(false);
  });

  it('emits drop_function CASCADE then create_function with --allow-destructive, and converges', async () => {
    await client.query(`CREATE FUNCTION "${TEST_SCHEMA}".rt_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);

    const desired = parseFunction(`
name: rt_fn
language: sql
returns: bigint
body: 'SELECT 1::bigint'
`);

    const plan = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
      allowDestructive: true,
    });

    const drop = plan.operations.find((o) => o.type === 'drop_function' && o.objectName === 'rt_fn');
    const create = plan.operations.find((o) => o.type === 'create_function' && o.objectName === 'rt_fn');
    expect(drop).toBeDefined();
    expect(drop!.sql).toMatch(/DROP FUNCTION[\s\S]*CASCADE/);
    expect(create).toBeDefined();
    expect(drop!.phase).toBeLessThan(create!.phase);

    // Apply, then re-plan — must converge to zero function ops.
    await client.query(generateSql(plan, { pgSchema: TEST_SCHEMA }));
    const after = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
    });
    expect(after.operations.filter((o) => o.type === 'create_function' || o.type === 'drop_function')).toHaveLength(0);

    const ret = await client.query(
      `SELECT pg_get_function_result(p.oid) AS r FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'rt_fn'`,
      [TEST_SCHEMA],
    );
    expect(ret.rows[0].r).toBe('bigint');
  });

  it('does not emit a drop when only the body changes (CREATE OR REPLACE suffices)', async () => {
    await client.query(`CREATE FUNCTION "${TEST_SCHEMA}".rt_body() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);

    const desired = parseFunction(`
name: rt_body
language: sql
returns: integer
body: 'SELECT 2'
`);

    const plan = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
      pgSchema: TEST_SCHEMA,
      allowDestructive: true,
    });
    expect(plan.operations.some((o) => o.type === 'drop_function' && o.objectName === 'rt_body')).toBe(false);
    expect(plan.operations.some((o) => o.type === 'create_function' && o.objectName === 'rt_body')).toBe(true);
  });
});
