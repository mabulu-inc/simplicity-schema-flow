import { describe, it, expect } from 'vitest';
import { lintPlan, type LintResult } from '../index.js';
import type { Operation, PlanResult } from '../../planner/index.js';

function makePlan(operations: Operation[], blocked: Operation[] = []): PlanResult {
  return { operations, blocked };
}

function makeOp(overrides: Partial<Operation> & Pick<Operation, 'type' | 'sql'>): Operation {
  return {
    type: overrides.type,
    phase: overrides.phase ?? 0,
    objectName: overrides.objectName ?? 'test_table',
    sql: overrides.sql,
    destructive: overrides.destructive ?? false,
  };
}

function findWarning(result: LintResult, rule: string) {
  return result.warnings.find((w) => w.rule === rule);
}

describe('lintPlan', () => {
  it('returns no warnings for an empty plan', () => {
    const result = lintPlan(makePlan([]));
    expect(result.warnings).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('returns no warnings for safe operations', () => {
    const result = lintPlan(
      makePlan([
        makeOp({ type: 'create_table', sql: 'CREATE TABLE foo (id uuid PRIMARY KEY)' }),
        makeOp({ type: 'add_column', sql: 'ALTER TABLE foo ADD COLUMN name text' }),
        makeOp({ type: 'add_index', sql: 'CREATE INDEX idx_foo_name ON foo (name)' }),
      ]),
    );
    expect(result.warnings).toEqual([]);
  });

  // Rule: drop-column
  it('warns on drop_column operations', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'drop_column',
          sql: 'ALTER TABLE users DROP COLUMN email',
          objectName: 'users',
          destructive: true,
        }),
      ]),
    );
    const w = findWarning(result, 'drop-column');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.message.toLowerCase()).toContain('drop');
  });

  // Rule: drop-table
  it('warns on drop_table operations', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'drop_table',
          sql: 'DROP TABLE users',
          objectName: 'users',
          destructive: true,
        }),
      ]),
    );
    const w = findWarning(result, 'drop-table');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.message.toLowerCase()).toContain('drop');
  });

  // Rule: set-not-null-direct
  it('warns on direct SET NOT NULL without safe CHECK pattern', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'alter_column',
          sql: 'ALTER TABLE users ALTER COLUMN email SET NOT NULL',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'set-not-null-direct');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('does not warn on SET NOT NULL if plan also adds a CHECK constraint', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'add_check',
          sql: 'ALTER TABLE users ADD CONSTRAINT chk_email CHECK (email IS NOT NULL) NOT VALID',
          objectName: 'users',
        }),
        makeOp({
          type: 'alter_column',
          sql: 'ALTER TABLE users ALTER COLUMN email SET NOT NULL',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'set-not-null-direct');
    expect(w).toBeUndefined();
  });

  // Rule: add-column-with-default
  it('warns on adding a column with a volatile default', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'add_column',
          sql: 'ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now()',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'add-column-with-default');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('does not warn on adding a column with a constant default', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'add_column',
          sql: 'ALTER TABLE users ADD COLUMN active boolean DEFAULT true',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'add-column-with-default');
    expect(w).toBeUndefined();
  });

  // Rule: type-change
  it('warns on column type changes', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'alter_column',
          sql: 'ALTER TABLE users ALTER COLUMN age TYPE bigint',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'type-change');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  // Rule: type-narrowing
  it('warns on type narrowing (e.g., text to varchar)', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'alter_column',
          sql: 'ALTER TABLE users ALTER COLUMN name TYPE varchar(50)',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'type-narrowing');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  // Rule: missing-fk-index
  it('warns on foreign key without matching index', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'add_foreign_key_not_valid',
          sql: 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)',
          objectName: 'orders',
        }),
      ]),
    );
    const w = findWarning(result, 'missing-fk-index');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('info');
  });

  it('does not warn on FK if plan also adds an index on the FK column', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'add_foreign_key_not_valid',
          sql: 'ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)',
          objectName: 'orders',
        }),
        makeOp({
          type: 'add_index',
          sql: 'CREATE INDEX idx_orders_user_id ON orders (user_id)',
          objectName: 'orders',
        }),
      ]),
    );
    const w = findWarning(result, 'missing-fk-index');
    expect(w).toBeUndefined();
  });

  // Rule: rename-detection
  it('detects possible rename (drop + add with similar pattern)', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'drop_column',
          sql: 'ALTER TABLE users DROP COLUMN name',
          objectName: 'users',
          destructive: true,
        }),
        makeOp({
          type: 'add_column',
          sql: 'ALTER TABLE users ADD COLUMN full_name text',
          objectName: 'users',
        }),
      ]),
    );
    const w = findWarning(result, 'rename-detection');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('info');
  });

  it('does not flag rename if drop and add are on different tables', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'drop_column',
          sql: 'ALTER TABLE users DROP COLUMN name',
          objectName: 'users',
          destructive: true,
        }),
        makeOp({
          type: 'add_column',
          sql: 'ALTER TABLE orders ADD COLUMN full_name text',
          objectName: 'orders',
        }),
      ]),
    );
    const w = findWarning(result, 'rename-detection');
    expect(w).toBeUndefined();
  });

  // Summary
  it('produces correct summary with counts by severity', () => {
    const result = lintPlan(
      makePlan([
        makeOp({
          type: 'drop_table',
          sql: 'DROP TABLE users',
          objectName: 'users',
          destructive: true,
        }),
        makeOp({
          type: 'drop_column',
          sql: 'ALTER TABLE orders DROP COLUMN amount',
          objectName: 'orders',
          destructive: true,
        }),
        makeOp({
          type: 'add_column',
          sql: 'ALTER TABLE orders ADD COLUMN total text',
          objectName: 'orders',
        }),
      ]),
    );
    // drop-table + drop-column + rename-detection
    expect(result.summary.total).toBeGreaterThanOrEqual(2);
    expect(result.summary.bySeverity).toBeDefined();
  });

  // Also checks blocked operations
  it('lints blocked operations too', () => {
    const result = lintPlan(
      makePlan(
        [],
        [
          makeOp({
            type: 'drop_table',
            sql: 'DROP TABLE users',
            objectName: 'users',
            destructive: true,
          }),
        ],
      ),
    );
    const w = findWarning(result, 'drop-table');
    expect(w).toBeDefined();
  });
});
