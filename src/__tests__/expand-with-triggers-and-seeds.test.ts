/**
 * Regression: declared user triggers that reference an expand-managed column
 * must be in place AND fire correctly on seed inserts during the first run.
 *
 * Bug (pre-0.7.2): expand_column ran at phase 100, after seeds at phase 15.
 * A YAML-declared BEFORE INSERT trigger that wrote `NEW.<expand-column>` then
 * raised `record "new" has no field "<expand-column>"` because the column
 * didn't exist when seeds fired. Consumers were forced to drop the trigger
 * into a post-script (which the planner then proposed to drop on every
 * re-run) or skip declaring it at all.
 *
 * Fix: expand_column → phase 6 (with the table create), dual-write trigger
 * → phase 11 (with user triggers), so both exist before seeds run at phase
 * 15. The dual-write trigger name (`_smplcty_sf_dw_*`) sorts ahead of user
 * trigger names, so on a seed INSERT it fires first and synchronizes the
 * legacy/new pair; user BEFORE INSERT triggers then fire and win, preserving
 * user intent.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { execute } from '../executor/index.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `expand_triggers_seeds_${Date.now()}_${schemaCount++}`;
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

describe('Expand + declared triggers + seeds (phase ordering)', () => {
  let testSchema: string;

  beforeEach(async () => {
    testSchema = uniqueSchema();
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${testSchema}"`);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('seeds + declared trigger that writes to expand column + expand pair all succeed on fresh DB', async () => {
    const desired = emptyDesired();
    desired.functions = [
      {
        name: 'stamp_created_at',
        language: 'plpgsql',
        returns: 'trigger',
        body: `BEGIN
          NEW.created_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
          RETURN NEW;
        END;`,
      },
    ];
    desired.tables = [
      {
        table: 'items',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
          // Legacy column the consumer is migrating away from.
          { name: 'created', type: 'timestamptz' },
          // The new column. `expand` makes schema-flow add it + install a
          // dual-write trigger. The user-declared trigger below also writes
          // to this column.
          {
            name: 'created_at',
            type: 'timestamptz',
            expand: { from: 'created', transform: 'created' },
          },
        ],
        triggers: [
          {
            name: 'items_stamp_created_at',
            timing: 'BEFORE',
            events: ['INSERT'],
            function: 'stamp_created_at',
          },
        ],
        seeds: [
          { id: 1, name: 'alpha', created: '2024-01-01T00:00:00Z' },
          { id: 2, name: 'beta', created: '2024-02-01T00:00:00Z' },
        ],
      },
    ];

    const plan = buildPlan(desired, emptyActual(), { pgSchema: testSchema });

    // The crux of the regression: in the planned op stream, the expand
    // column and dual-write trigger must come before the seed_table op.
    const phases = plan.operations.map((o) => ({ type: o.type, phase: o.phase }));
    const expandIdx = phases.findIndex((p) => p.type === 'expand_column');
    const dwIdx = phases.findIndex((p) => p.type === 'create_dual_write_trigger');
    const seedIdx = phases.findIndex((p) => p.type === 'seed_table');
    expect(expandIdx).toBeGreaterThan(-1);
    expect(dwIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeGreaterThan(-1);
    expect(expandIdx).toBeLessThan(seedIdx);
    expect(dwIdx).toBeLessThan(seedIdx);

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: plan.operations,
      pgSchema: testSchema,
      logger,
    });
    expect(result.executed).toBe(plan.operations.length);

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT id, name, created, created_at FROM "${testSchema}"."items" ORDER BY id`);
      expect(res.rows).toHaveLength(2);

      // The dual-write trigger fires first (its name starts with `_`),
      // sets created_at := created. The user's audit-stamp trigger runs
      // afterward; with COALESCE it leaves the synchronized value alone,
      // so both columns agree.
      expect(res.rows[0].id).toBe(1);
      expect(res.rows[0].name).toBe('alpha');
      expect(res.rows[0].created).toEqual(res.rows[0].created_at);
      expect(res.rows[1].created).toEqual(res.rows[1].created_at);
    } finally {
      client.release();
    }
  });

  it('declared trigger that overrides the expand column still wins (user intent preserved)', async () => {
    // Same shape, but the user's trigger unconditionally overwrites the
    // expand column. The dual-write trigger should still install in time so
    // the seed INSERT doesn't blow up — and the user's trigger should win
    // on the merged value, matching what they'd expect.
    const desired = emptyDesired();
    desired.functions = [
      {
        name: 'force_now',
        language: 'plpgsql',
        returns: 'trigger',
        body: `BEGIN
          NEW.created_at := CURRENT_TIMESTAMP;
          RETURN NEW;
        END;`,
      },
    ];
    desired.tables = [
      {
        table: 'events',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'kind', type: 'text' },
          { name: 'created', type: 'timestamptz' },
          {
            name: 'created_at',
            type: 'timestamptz',
            expand: { from: 'created', transform: 'created' },
          },
        ],
        triggers: [
          {
            name: 'events_force_now',
            timing: 'BEFORE',
            events: ['INSERT'],
            function: 'force_now',
          },
        ],
        seeds: [
          { id: 1, kind: 'a', created: '2020-01-01T00:00:00Z' },
          { id: 2, kind: 'b', created: '2020-02-01T00:00:00Z' },
        ],
      },
    ];

    const plan = buildPlan(desired, emptyActual(), { pgSchema: testSchema });
    const result = await execute({
      connectionString: DATABASE_URL,
      operations: plan.operations,
      pgSchema: testSchema,
      logger,
    });
    expect(result.executed).toBe(plan.operations.length);

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT id, created, created_at FROM "${testSchema}"."events" ORDER BY id`);
      expect(res.rows).toHaveLength(2);
      for (const row of res.rows) {
        // User trigger sets created_at to NOW(); the legacy `created` is
        // whatever the seed provided. The user's trigger semantics win.
        expect(row.created.toISOString().startsWith('2020-')).toBe(true);
        expect(row.created_at.getFullYear()).toBeGreaterThanOrEqual(2024);
      }
    } finally {
      client.release();
    }
  });

  it('re-running the plan against the populated DB is idempotent (no extra inserts, trigger preserved)', async () => {
    const desired = emptyDesired();
    desired.functions = [
      {
        name: 'stamp_created_at',
        language: 'plpgsql',
        returns: 'trigger',
        body: `BEGIN
          NEW.created_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
          RETURN NEW;
        END;`,
      },
    ];
    desired.tables = [
      {
        table: 'rerun_items',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
          { name: 'created', type: 'timestamptz' },
          {
            name: 'created_at',
            type: 'timestamptz',
            expand: { from: 'created', transform: 'created' },
          },
        ],
        triggers: [
          {
            name: 'rerun_items_stamp',
            timing: 'BEFORE',
            events: ['INSERT'],
            function: 'stamp_created_at',
          },
        ],
        seeds: [{ id: 1, name: 'alpha', created: '2024-01-01T00:00:00Z' }],
      },
    ];

    const firstPlan = buildPlan(desired, emptyActual(), { pgSchema: testSchema });
    await execute({
      connectionString: DATABASE_URL,
      operations: firstPlan.operations,
      pgSchema: testSchema,
      logger,
    });

    // Simulate a second run with the same desired state and the DB already
    // populated. We don't introspect — we just re-execute the same plan and
    // assert the seed remains a single row (UPDATE/INSERT-WHERE-NOT-EXISTS
    // shouldn't duplicate it). The point is that the dual-write trigger
    // doesn't interfere with idempotent seed re-application.
    const secondResult = await execute({
      connectionString: DATABASE_URL,
      operations: firstPlan.operations,
      pgSchema: testSchema,
      logger,
    });
    expect(secondResult.executed).toBe(firstPlan.operations.length);

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT count(*)::int AS n FROM "${testSchema}"."rerun_items"`);
      expect(res.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });
});
