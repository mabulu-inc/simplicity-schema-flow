import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { buildPlan, type DesiredState, type ActualState, type Operation } from '../planner/index.js';
import { execute } from '../executor/index.js';
import { formatOperationMessage } from '../executor/format-operation.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;

let schemaCount = 0;
function uniqueSchema(): string {
  return `batch_seed_test_${Date.now()}_${schemaCount++}`;
}

const logger = createLogger({ verbose: false, quiet: true, json: false });

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

// ─── Planner Tests ───────────────────────────────────────────────

describe('Batch seeds — planner', () => {
  it('emits a single seed_table operation instead of multiple add_seed ops', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
          { id: 3, name: 'pending' },
        ],
      },
    ];
    const result = buildPlan(desired, emptyActual());
    const seedOps = result.operations.filter((o) => o.type === 'seed_table');
    const addSeedOps = result.operations.filter((o) => o.type === 'add_seed');
    expect(seedOps).toHaveLength(1);
    expect(addSeedOps).toHaveLength(0);
    expect(seedOps[0].objectName).toBe('statuses');
    expect(seedOps[0].seedRows).toHaveLength(3);
  });

  it('carries seed column metadata with types and PK info', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        seeds: [{ id: '00000000-0000-0000-0000-000000000001', email: 'admin@example.com' }],
      },
    ];
    const result = buildPlan(desired, emptyActual());
    const seedOps = result.operations.filter((o) => o.type === 'seed_table');
    expect(seedOps).toHaveLength(1);
    const op = seedOps[0];
    expect(op.seedColumns).toBeDefined();
    expect(op.seedColumns!.find((c) => c.name === 'id')?.isPk).toBe(true);
    expect(op.seedColumns!.find((c) => c.name === 'email')?.isPk).toBeFalsy();
  });

  it('propagates seeds_on_conflict DO NOTHING', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [{ id: 1, name: 'active' }],
        seeds_on_conflict: 'DO NOTHING',
      },
    ];
    const result = buildPlan(desired, emptyActual());
    const seedOps = result.operations.filter((o) => o.type === 'seed_table');
    expect(seedOps).toHaveLength(1);
    expect(seedOps[0].seedOnConflict).toBe('DO NOTHING');
  });

  it('emits seed_table for alter path too', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('statuses', {
      table: 'statuses',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
    });
    const result = buildPlan(desired, actual);
    const seedOps = result.operations.filter((o) => o.type === 'seed_table');
    expect(seedOps).toHaveLength(1);
    expect(seedOps[0].seedRows).toHaveLength(2);
  });
});

// ─── Executor Tests ──────────────────────────────────────────────

describe('Batch seeds — executor', () => {
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

  it('bulk inserts all seed rows into a new table', async () => {
    const ops: Operation[] = [
      {
        type: 'create_table',
        phase: 6,
        objectName: 'statuses',
        sql: `CREATE TABLE "${testSchema}"."statuses" ("id" integer PRIMARY KEY, "name" text NOT NULL)`,
        destructive: false,
      },
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'statuses',
        sql: '',
        destructive: false,
        seedRows: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
          { id: 3, name: 'pending' },
        ],
        seedColumns: [
          { name: 'id', type: 'integer', isPk: true },
          { name: 'name', type: 'text', isPk: false },
        ],
      },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    expect(result.executed).toBe(2); // create_table + seed_table

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT id, name FROM "${testSchema}"."statuses" ORDER BY id`);
      expect(res.rows).toHaveLength(3);
      expect(res.rows[0]).toEqual({ id: 1, name: 'active' });
      expect(res.rows[1]).toEqual({ id: 2, name: 'inactive' });
      expect(res.rows[2]).toEqual({ id: 3, name: 'pending' });
    } finally {
      client.release();
    }

    // Check seed result counts
    const seedOp = result.executedOperations.find((o) => o.type === 'seed_table')!;
    expect(seedOp.seedResult).toEqual({ inserted: 3, updated: 0, unchanged: 0 });
  });

  it('reports correct counts for mixed insert/update/unchanged', async () => {
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      await client.query(`CREATE TABLE "${testSchema}"."statuses" ("id" integer PRIMARY KEY, "name" text NOT NULL)`);
      // Pre-populate: id=1 with same data (will be unchanged), id=2 with different data (will be updated)
      await client.query(`INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (1, 'active'), (2, 'old_name')`);
    } finally {
      client.release();
    }

    const ops: Operation[] = [
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'statuses',
        sql: '',
        destructive: false,
        seedRows: [
          { id: 1, name: 'active' }, // unchanged
          { id: 2, name: 'inactive' }, // updated
          { id: 3, name: 'pending' }, // inserted
        ],
        seedColumns: [
          { name: 'id', type: 'integer', isPk: true },
          { name: 'name', type: 'text', isPk: false },
        ],
      },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    expect(result.executed).toBe(1);

    // Verify data
    const client2 = await pool.connect();
    try {
      const res = await client2.query(`SELECT id, name FROM "${testSchema}"."statuses" ORDER BY id`);
      expect(res.rows).toHaveLength(3);
      expect(res.rows[0]).toEqual({ id: 1, name: 'active' });
      expect(res.rows[1]).toEqual({ id: 2, name: 'inactive' });
      expect(res.rows[2]).toEqual({ id: 3, name: 'pending' });
    } finally {
      client2.release();
    }

    // Check counts
    const seedOp = result.executedOperations.find((o) => o.type === 'seed_table')!;
    expect(seedOp.seedResult).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
  });

  it('handles DO NOTHING conflict — inserts only, skips existing', async () => {
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      await client.query(`CREATE TABLE "${testSchema}"."statuses" ("id" integer PRIMARY KEY, "name" text NOT NULL)`);
      await client.query(`INSERT INTO "${testSchema}"."statuses" ("id", "name") VALUES (1, 'original')`);
    } finally {
      client.release();
    }

    const ops: Operation[] = [
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'statuses',
        sql: '',
        destructive: false,
        seedRows: [
          { id: 1, name: 'changed' }, // should be skipped
          { id: 2, name: 'new' }, // should be inserted
        ],
        seedColumns: [
          { name: 'id', type: 'integer', isPk: true },
          { name: 'name', type: 'text', isPk: false },
        ],
        seedOnConflict: 'DO NOTHING',
      },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    // Verify original is preserved, new is inserted
    const client2 = await pool.connect();
    try {
      const res = await client2.query(`SELECT id, name FROM "${testSchema}"."statuses" ORDER BY id`);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]).toEqual({ id: 1, name: 'original' }); // NOT changed
      expect(res.rows[1]).toEqual({ id: 2, name: 'new' });
    } finally {
      client2.release();
    }

    const seedOp = result.executedOperations.find((o) => o.type === 'seed_table')!;
    expect(seedOp.seedResult).toEqual({ inserted: 1, updated: 0, unchanged: 1 });
  });

  it('handles SQL expressions in seed values', async () => {
    const ops: Operation[] = [
      {
        type: 'create_table',
        phase: 6,
        objectName: 'events',
        sql: `CREATE TABLE "${testSchema}"."events" ("id" integer PRIMARY KEY, "created_at" timestamptz NOT NULL)`,
        destructive: false,
      },
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'events',
        sql: '',
        destructive: false,
        seedRows: [
          { id: 1, created_at: { __sql: 'now()' } },
          { id: 2, created_at: { __sql: 'now()' } },
        ],
        seedColumns: [
          { name: 'id', type: 'integer', isPk: true },
          { name: 'created_at', type: 'timestamptz', isPk: false },
        ],
      },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    expect(result.executed).toBe(2);

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT id, created_at FROM "${testSchema}"."events" ORDER BY id`);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0].created_at).toBeInstanceOf(Date);
      expect(res.rows[1].created_at).toBeInstanceOf(Date);
    } finally {
      client.release();
    }
  });

  it('handles seeds with uuid primary keys', async () => {
    const ops: Operation[] = [
      {
        type: 'create_table',
        phase: 6,
        objectName: 'users',
        sql: `CREATE TABLE "${testSchema}"."users" ("id" uuid PRIMARY KEY, "email" text NOT NULL)`,
        destructive: false,
      },
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'users',
        sql: '',
        destructive: false,
        seedRows: [
          { id: '00000000-0000-0000-0000-000000000001', email: 'admin@example.com' },
          { id: '00000000-0000-0000-0000-000000000002', email: 'user@example.com' },
        ],
        seedColumns: [
          { name: 'id', type: 'uuid', isPk: true },
          { name: 'email', type: 'text', isPk: false },
        ],
      },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    expect(result.executed).toBe(2);

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT id, email FROM "${testSchema}"."users" ORDER BY email`);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0].email).toBe('admin@example.com');
      expect(res.rows[1].email).toBe('user@example.com');
    } finally {
      client.release();
    }
  });

  it('handles null and boolean values in seed data', async () => {
    const ops: Operation[] = [
      {
        type: 'create_table',
        phase: 6,
        objectName: 'settings',
        sql: `CREATE TABLE "${testSchema}"."settings" ("key" text PRIMARY KEY, "value" text, "enabled" boolean NOT NULL DEFAULT true)`,
        destructive: false,
      },
      {
        type: 'seed_table',
        phase: 15,
        objectName: 'settings',
        sql: '',
        destructive: false,
        seedRows: [
          { key: 'maintenance', value: null, enabled: false },
          { key: 'notifications', value: 'email', enabled: true },
        ],
        seedColumns: [
          { name: 'key', type: 'text', isPk: true },
          { name: 'value', type: 'text', isPk: false },
          { name: 'enabled', type: 'boolean', isPk: false },
        ],
      },
    ];

    await execute({
      connectionString: DATABASE_URL,
      operations: ops,
      pgSchema: testSchema,
      logger,
    });

    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT key, value, enabled FROM "${testSchema}"."settings" ORDER BY key`);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]).toEqual({ key: 'maintenance', value: null, enabled: false });
      expect(res.rows[1]).toEqual({ key: 'notifications', value: 'email', enabled: true });
    } finally {
      client.release();
    }
  });
});

// ─── Format Tests ────────────────────────────────────────────────

describe('Batch seeds — format', () => {
  it('formats seed_table with counts', () => {
    const op: Operation = {
      type: 'seed_table',
      phase: 15,
      objectName: 'statuses',
      sql: '',
      destructive: false,
      seedResult: { inserted: 3, updated: 2, unchanged: 1 },
    };
    const msg = formatOperationMessage(op);
    expect(msg).toBe('Seeded: statuses (3 inserted, 2 updated, 1 unchanged)');
  });

  it('formats seed_table without counts as fallback', () => {
    const op: Operation = {
      type: 'seed_table',
      phase: 15,
      objectName: 'statuses',
      sql: '',
      destructive: false,
    };
    const msg = formatOperationMessage(op);
    expect(msg).toBe('Seeded: statuses');
  });

  it('omits zero-count categories', () => {
    const op: Operation = {
      type: 'seed_table',
      phase: 15,
      objectName: 'units',
      sql: '',
      destructive: false,
      seedResult: { inserted: 5, updated: 0, unchanged: 0 },
    };
    const msg = formatOperationMessage(op);
    expect(msg).toBe('Seeded: units (5 inserted)');
  });
});
