import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseExtensions } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import type { ExtensionsSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
});

afterAll(async () => {
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

function desiredWith(extensions: ExtensionsSchema | null): DesiredState {
  return {
    tables: [],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions,
  };
}

// ─── Parser ──────────────────────────────────────────────────────

describe('parser: extension { name, schema } form', () => {
  it('normalizes a bare string to { name }', () => {
    const ext = parseExtensions(`extensions:\n  - pg_trgm\n`);
    expect(ext.extensions).toEqual([{ name: 'pg_trgm' }]);
  });

  it('keeps the install schema from the object form', () => {
    const ext = parseExtensions(`extensions:\n  - name: pg_partman\n    schema: partman\n`);
    expect(ext.extensions).toEqual([{ name: 'pg_partman', schema: 'partman' }]);
  });

  it('accepts a mix of string and object entries', () => {
    const ext = parseExtensions(`extensions:\n  - pgcrypto\n  - name: pg_partman\n    schema: partman\n`);
    expect(ext.extensions).toEqual([{ name: 'pgcrypto' }, { name: 'pg_partman', schema: 'partman' }]);
  });

  it('rejects unknown fields on the object form', () => {
    expect(() => parseExtensions(`extensions:\n  - name: x\n    version: '1.0'\n`)).toThrow(/unknown field/i);
  });
});

// ─── Planner: SQL generation ─────────────────────────────────────

describe('planner: CREATE EXTENSION … SCHEMA', () => {
  it('emits SCHEMA clause when a schema is pinned', () => {
    const plan = buildPlan(desiredWith({ extensions: [{ name: 'pg_partman', schema: 'partman' }] }), emptyActual());
    const op = plan.operations.find((o) => o.type === 'create_extension' && o.objectName === 'pg_partman');
    expect(op).toBeDefined();
    expect(op!.sql).toBe('CREATE EXTENSION IF NOT EXISTS "pg_partman" SCHEMA "partman"');
  });

  it('omits SCHEMA clause for the bare form', () => {
    const plan = buildPlan(desiredWith({ extensions: [{ name: 'pgcrypto' }] }), emptyActual());
    const op = plan.operations.find((o) => o.type === 'create_extension' && o.objectName === 'pgcrypto');
    expect(op!.sql).toBe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  });

  it('drops an installed extension that is not declared (compares by name)', () => {
    const plan = buildPlan(
      desiredWith({ extensions: [{ name: 'pgcrypto', schema: 'public' }] }),
      { ...emptyActual(), extensions: ['pgcrypto', 'citext'] },
      { allowDestructive: true },
    );
    // pgcrypto already installed → no create; citext undeclared → drop.
    expect(plan.operations.find((o) => o.type === 'create_extension')).toBeUndefined();
    const drop = plan.operations.find((o) => o.type === 'drop_extension' && o.objectName === 'citext');
    expect(drop).toBeDefined();
  });
});

// ─── E2E: extension actually lands in the pinned schema ──────────

describe('E2E: extension installed into a custom schema', () => {
  it('CREATE EXTENSION … SCHEMA puts the extension objects in that schema', async () => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ext`);

    const plan = buildPlan(desiredWith({ extensions: [{ name: 'pgcrypto', schema: 'ext' }] }), emptyActual());
    const op = plan.operations.find((o) => o.type === 'create_extension' && o.objectName === 'pgcrypto');
    expect(op).toBeDefined();
    await client.query(op!.sql);

    const res = await client.query(
      `SELECT n.nspname AS schema
         FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pgcrypto'`,
    );
    expect(res.rows[0]?.schema).toBe('ext');
  });
});
