import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { parseTable } from '../schema/parser.js';
import type { FunctionSchema, IndexDef } from '../schema/types.js';

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

// ─── Unit Tests: planner logic ──────────────────────────────────

describe('idempotent index comments (planner)', () => {
  it('does not emit set_comment when index comment matches existing', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: status
    type: text
indexes:
  - name: idx_items_status
    columns: [status]
    comment: "Speeds up status lookups"
`);

    const existingIndex: IndexDef = {
      name: 'idx_items_status',
      columns: ['status'],
      unique: false,
      comment: 'Speeds up status lookups',
    };

    const actual: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [
              { name: 'id', type: 'uuid', primary_key: true },
              { name: 'status', type: 'text' },
            ],
            indexes: [existingIndex],
          },
        ],
      ]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const commentOps = plan.operations.filter(
      (op) => op.type === 'set_comment' && op.objectName === 'idx_items_status',
    );
    expect(commentOps).toHaveLength(0);
  });

  it('emits set_comment when index comment differs from existing', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: status
    type: text
indexes:
  - name: idx_items_status
    columns: [status]
    comment: "Updated comment"
`);

    const existingIndex: IndexDef = {
      name: 'idx_items_status',
      columns: ['status'],
      unique: false,
      comment: 'Old comment',
    };

    const actual: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [
              { name: 'id', type: 'uuid', primary_key: true },
              { name: 'status', type: 'text' },
            ],
            indexes: [existingIndex],
          },
        ],
      ]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const commentOps = plan.operations.filter(
      (op) => op.type === 'set_comment' && op.objectName === 'idx_items_status',
    );
    expect(commentOps).toHaveLength(1);
  });
});

describe('idempotent functions (planner)', () => {
  it('does not emit create_function when function matches existing', () => {
    const fn: FunctionSchema = {
      name: 'my_func',
      language: 'plpgsql',
      returns: 'void',
      body: "BEGIN\n  RAISE NOTICE 'hello';\nEND;",
      security: 'invoker',
      volatility: 'volatile',
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([['my_func', { ...fn }]]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [fn],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const fnOps = plan.operations.filter((op) => op.type === 'create_function' && op.objectName === 'my_func');
    expect(fnOps).toHaveLength(0);
  });

  it('does not emit create_function when bodies differ only in whitespace', () => {
    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [
        {
          name: 'ws_func',
          language: 'plpgsql',
          returns: 'void',
          body: "BEGIN\n  RAISE NOTICE 'hello';\nEND;",
          security: 'invoker',
          volatility: 'volatile',
        },
      ],
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([
        [
          'ws_func',
          {
            name: 'ws_func',
            language: 'plpgsql',
            returns: 'void',
            body: "BEGIN\n  RAISE NOTICE 'hello';\nEND;  ",
            security: 'invoker',
            volatility: 'volatile',
          },
        ],
      ]),
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const fnOps = plan.operations.filter((op) => op.type === 'create_function' && op.objectName === 'ws_func');
    expect(fnOps).toHaveLength(0);
  });

  it('emits create_function when function body actually differs', () => {
    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [
        {
          name: 'changed_func',
          language: 'plpgsql',
          returns: 'void',
          body: "BEGIN\n  RAISE NOTICE 'updated';\nEND;",
          security: 'invoker',
          volatility: 'volatile',
        },
      ],
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([
        [
          'changed_func',
          {
            name: 'changed_func',
            language: 'plpgsql',
            returns: 'void',
            body: "BEGIN\n  RAISE NOTICE 'original';\nEND;",
            security: 'invoker',
            volatility: 'volatile',
          },
        ],
      ]),
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const fnOps = plan.operations.filter((op) => op.type === 'create_function' && op.objectName === 'changed_func');
    expect(fnOps).toHaveLength(1);
  });

  it('emits create_function when volatility differs', () => {
    const fn: FunctionSchema = {
      name: 'vol_func',
      language: 'plpgsql',
      returns: 'void',
      body: "BEGIN\n  RAISE NOTICE 'test';\nEND;",
      security: 'invoker',
      volatility: 'stable',
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([
        [
          'vol_func',
          {
            ...fn,
            volatility: 'volatile',
          },
        ],
      ]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [fn],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const fnOps = plan.operations.filter((op) => op.type === 'create_function' && op.objectName === 'vol_func');
    expect(fnOps).toHaveLength(1);
  });

  it('does not emit set_comment when function comment matches existing', () => {
    const fn: FunctionSchema = {
      name: 'commented_func',
      language: 'plpgsql',
      returns: 'void',
      body: 'BEGIN\n  NULL;\nEND;',
      security: 'invoker',
      volatility: 'volatile',
      comment: 'My function comment',
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([['commented_func', { ...fn }]]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [fn],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const commentOps = plan.operations.filter((op) => op.type === 'set_comment' && op.objectName === 'commented_func');
    expect(commentOps).toHaveLength(0);
  });

  it('does not emit grant_function when function is unchanged', () => {
    const fn: FunctionSchema = {
      name: 'grant_func',
      language: 'plpgsql',
      returns: 'void',
      body: 'BEGIN\n  NULL;\nEND;',
      security: 'invoker',
      volatility: 'volatile',
      grants: [{ to: 'app_user', privileges: ['EXECUTE'] }],
    };

    const actual: ActualState = {
      ...emptyActual(),
      functions: new Map([['grant_func', { ...fn }]]),
    };

    const desired: DesiredState = {
      ...emptyDesired(),
      functions: [fn],
    };

    const plan = buildPlan(desired, actual, { schema: 'public' });
    const grantOps = plan.operations.filter(
      (op) => op.type === 'grant_function' && op.objectName.startsWith('grant_func'),
    );
    expect(grantOps).toHaveLength(0);
  });
});

// ─── E2E Tests: real PostgreSQL round-trip ──────────────────────

describe('idempotent index comments (E2E)', () => {
  let project: TestProject;
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54329/postgres';

  beforeAll(async () => {
    project = await useTestProject(connectionString);
  }, 30000);

  afterAll(async () => {
    if (project) await project.cleanup();
  }, 30000);

  it('produces 0 operations on second plan for index with comment', async () => {
    writeSchema(project.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: status
    type: text
indexes:
  - name: idx_items_status
    columns: [status]
    comment: "Speeds up status lookups"
`,
    });

    // First migration
    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    // Second migration — should produce 0 operations
    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);
  }, 60000);
});

describe('idempotent functions (E2E)', () => {
  let project: TestProject;
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54329/postgres';

  beforeAll(async () => {
    project = await useTestProject(connectionString);
  }, 30000);

  afterAll(async () => {
    if (project) await project.cleanup();
  }, 30000);

  it('produces 0 operations on second plan for function', async () => {
    writeSchema(project.dir, {
      'functions/my_func.yaml': `
name: hello_world
language: plpgsql
returns: void
security: invoker
volatility: volatile
body: |
  BEGIN
    RAISE NOTICE 'hello world';
  END;
`,
    });

    // First migration
    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    // Second migration — should produce 0 operations
    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);
  }, 60000);

  it('produces 0 operations on second plan for function with comment', async () => {
    writeSchema(project.dir, {
      'functions/commented_func.yaml': `
name: commented_hello
language: plpgsql
returns: void
security: invoker
volatility: volatile
comment: "Says hello"
body: |
  BEGIN
    RAISE NOTICE 'hello';
  END;
`,
    });

    // First migration
    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    // Second migration — should produce 0 operations
    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);
  }, 60000);
});
