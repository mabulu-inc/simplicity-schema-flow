import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getExistingFunctions } from '../introspect/index.js';
import { parseFunction } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { generateSql } from '../sql/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_fn_sp_${Date.now()}`;

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

/** Apply a declared function, then re-plan — a hardened function must converge
 *  to zero function ops (no perpetual redefinition drift). */
async function applyAndExpectConvergence(desired: ReturnType<typeof parseFunction>) {
  const plan = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
    pgSchema: TEST_SCHEMA,
  });
  await client.query(generateSql(plan, { pgSchema: TEST_SCHEMA }));

  const after = buildPlan({ ...emptyDesired(), functions: [desired] }, await actualWithFunctions(), {
    pgSchema: TEST_SCHEMA,
  });
  expect(after.operations.filter((o) => o.type === 'create_function')).toHaveLength(0);
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

describe('pinning search_path on SECURITY DEFINER functions (issue #70)', () => {
  it('pins an empty search_path (force fully-qualified) and re-plans to a no-op', async () => {
    const desired = parseFunction(`
name: sp_empty
language: sql
returns: integer
security: definer
set:
  search_path: ''
body: 'SELECT 1'
`);
    await applyAndExpectConvergence(desired);

    // Introspection reads the empty pin back as '' (Postgres stores it as "").
    const fn = (await getExistingFunctions(client, TEST_SCHEMA)).find((f) => f.name === 'sp_empty');
    expect(fn!.security).toBe('definer');
    expect(fn!.set).toEqual({ search_path: '' });

    // Confirm the pin actually landed on the live function.
    const cfg = await client.query(
      `SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'sp_empty'`,
      [TEST_SCHEMA],
    );
    expect(cfg.rows[0].proconfig).toEqual(['search_path=""']);
  });

  it('pins a multi-schema search_path and re-plans to a no-op', async () => {
    const desired = parseFunction(`
name: sp_multi
language: sql
returns: integer
security: definer
set:
  search_path: 'pg_catalog, public'
body: 'SELECT 1'
`);
    await applyAndExpectConvergence(desired);

    const fn = (await getExistingFunctions(client, TEST_SCHEMA)).find((f) => f.name === 'sp_multi');
    expect(fn!.set).toEqual({ search_path: 'pg_catalog, public' });
  });

  it('single-quotes scalar GUCs so a unit value applies cleanly and re-plans to a no-op', async () => {
    const desired = parseFunction(`
name: sp_scalar
language: sql
returns: integer
set:
  statement_timeout: '5s'
body: 'SELECT 1'
`);
    await applyAndExpectConvergence(desired);

    const fn = (await getExistingFunctions(client, TEST_SCHEMA)).find((f) => f.name === 'sp_scalar');
    expect(fn!.set).toEqual({ statement_timeout: '5s' });
  });
});
