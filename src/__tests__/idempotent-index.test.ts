import { describe, it, expect } from 'vitest';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

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

describe('idempotent index and unique constraint creation', () => {
  it('emits IF NOT EXISTS on CREATE INDEX CONCURRENTLY for regular indexes', () => {
    const yaml = `
table: orders
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: status
    type: text
indexes:
  - name: idx_orders_status
    columns: [status]
`;
    const table = parseTable(yaml);
    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };
    const plan = buildPlan(desired, emptyActual(), { schema: 'public' });
    const indexOp = plan.operations.find((op) => op.objectName === 'idx_orders_status' && op.type === 'add_index');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).toContain('IF NOT EXISTS');
    expect(indexOp!.sql).toMatch(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS/);
  });

  it('emits IF NOT EXISTS on CREATE UNIQUE INDEX CONCURRENTLY for unique indexes', () => {
    const yaml = `
table: products
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: sku
    type: text
indexes:
  - name: idx_products_sku
    columns: [sku]
    unique: true
`;
    const table = parseTable(yaml);
    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };
    const plan = buildPlan(desired, emptyActual(), { schema: 'public' });
    const indexOp = plan.operations.find((op) => op.objectName === 'idx_products_sku' && op.type === 'add_index');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).toContain('IF NOT EXISTS');
    expect(indexOp!.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS/);
  });

  it('emits IF NOT EXISTS on CREATE UNIQUE INDEX CONCURRENTLY for unique constraints on existing tables', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
unique_constraints:
  - name: uq_users_email
    columns: [email]
`;
    const table = parseTable(yaml);
    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };
    // Provide existing table so it goes through diffTable → diffUniqueConstraints
    const actual: ActualState = {
      ...emptyActual(),
      tables: new Map([
        [
          'users',
          {
            table: 'users',
            columns: [
              { name: 'id', type: 'uuid', primary_key: true },
              { name: 'email', type: 'text' },
            ],
          },
        ],
      ]),
    };
    const plan = buildPlan(desired, actual, { schema: 'public' });
    const ucIndexOp = plan.operations.find((op) => op.objectName === 'uq_users_email' && op.type === 'add_index');
    expect(ucIndexOp).toBeDefined();
    expect(ucIndexOp!.sql).toContain('IF NOT EXISTS');
    expect(ucIndexOp!.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS/);

    // The ALTER TABLE ADD CONSTRAINT step should also be guarded with pg_constraint check
    const ucConstraintOp = plan.operations.find(
      (op) => op.objectName === 'users.uq_users_email' && op.type === 'add_unique_constraint',
    );
    expect(ucConstraintOp).toBeDefined();
    expect(ucConstraintOp!.sql).toContain('IF NOT EXISTS');
    expect(ucConstraintOp!.sql).toContain('pg_constraint');
  });

  it('emits IF NOT EXISTS on partial indexes with WHERE clause', () => {
    const yaml = `
table: events
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: active
    type: boolean
indexes:
  - name: idx_events_active
    columns: [active]
    where: "active = true"
`;
    const table = parseTable(yaml);
    const desired: DesiredState = {
      ...emptyDesired(),
      tables: [table],
    };
    const plan = buildPlan(desired, emptyActual(), { schema: 'public' });
    const indexOp = plan.operations.find((op) => op.objectName === 'idx_events_active' && op.type === 'add_index');
    expect(indexOp).toBeDefined();
    expect(indexOp!.sql).toContain('IF NOT EXISTS');
    expect(indexOp!.sql).toContain('WHERE active = true');
  });
});
