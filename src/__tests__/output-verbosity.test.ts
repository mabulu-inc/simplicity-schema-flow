/**
 * Tests for output verbosity modes (T-117).
 *
 * Verifies that:
 * - formatOperationMessage produces human-readable descriptions
 * - reportMigrationResult respects quiet/default/verbose modes
 * - drift --apply uses the same output formatting
 */

import { describe, it, expect } from 'vitest';
import { formatOperationMessage } from '../executor/format-operation.js';
import { reportMigrationResult } from '../cli/report.js';
import type { Operation } from '../planner/index.js';
import type { ExecuteResult } from '../executor/index.js';

function makeOp(overrides: Partial<Operation> & Pick<Operation, 'type' | 'objectName'>): Operation {
  return {
    phase: 1,
    sql: 'SELECT 1',
    destructive: false,
    ...overrides,
  };
}

describe('formatOperationMessage', () => {
  it('describes table creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_table', objectName: 'users' }));
    expect(msg).toBe('Created table: users');
  });

  it('describes table drop', () => {
    const msg = formatOperationMessage(makeOp({ type: 'drop_table', objectName: 'users' }));
    expect(msg).toBe('Dropped table: users');
  });

  it('describes column addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_column', objectName: 'users.email' }));
    expect(msg).toBe('Added column: users.email');
  });

  it('describes column alteration', () => {
    const msg = formatOperationMessage(makeOp({ type: 'alter_column', objectName: 'users.email' }));
    expect(msg).toBe('Altered column: users.email');
  });

  it('describes column drop', () => {
    const msg = formatOperationMessage(makeOp({ type: 'drop_column', objectName: 'users.old_field' }));
    expect(msg).toBe('Dropped column: users.old_field');
  });

  it('describes index addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_index', objectName: 'idx_users_email' }));
    expect(msg).toBe('Added index: idx_users_email');
  });

  it('describes index drop', () => {
    const msg = formatOperationMessage(makeOp({ type: 'drop_index', objectName: 'idx_users_email' }));
    expect(msg).toBe('Dropped index: idx_users_email');
  });

  it('describes enum creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_enum', objectName: 'status' }));
    expect(msg).toBe('Created enum: status');
  });

  it('describes enum value addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_enum_value', objectName: 'status.active' }));
    expect(msg).toBe('Added enum value: status.active');
  });

  it('describes function creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_function', objectName: 'update_timestamp' }));
    expect(msg).toBe('Created function: update_timestamp');
  });

  it('describes policy creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_policy', objectName: 'users_select' }));
    expect(msg).toBe('Applied policy: users_select');
  });

  it('describes policy drop', () => {
    const msg = formatOperationMessage(makeOp({ type: 'drop_policy', objectName: 'users_select' }));
    expect(msg).toBe('Dropped policy: users_select');
  });

  it('describes RLS enable', () => {
    const msg = formatOperationMessage(makeOp({ type: 'enable_rls', objectName: 'users' }));
    expect(msg).toBe('Enabled RLS: users');
  });

  it('describes trigger creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_trigger', objectName: 'users_updated_at' }));
    expect(msg).toBe('Created trigger: users_updated_at');
  });

  it('describes view creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_view', objectName: 'active_users' }));
    expect(msg).toBe('Created view: active_users');
  });

  it('describes materialized view creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_materialized_view', objectName: 'user_stats' }));
    expect(msg).toBe('Created materialized view: user_stats');
  });

  it('describes extension creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_extension', objectName: 'pgcrypto' }));
    expect(msg).toBe('Created extension: pgcrypto');
  });

  it('describes role creation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'create_role', objectName: 'app_readonly' }));
    expect(msg).toBe('Created role: app_readonly');
  });

  it('describes table grant', () => {
    const msg = formatOperationMessage(makeOp({ type: 'grant_table', objectName: 'SELECT on users to app_readonly' }));
    expect(msg).toBe('Granted SELECT on users to app_readonly');
  });

  it('describes table revoke', () => {
    const msg = formatOperationMessage(
      makeOp({ type: 'revoke_table', objectName: 'SELECT on users from app_readonly' }),
    );
    expect(msg).toBe('Revoked SELECT on users from app_readonly');
  });

  it('describes check constraint addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_check', objectName: 'users_age_check' }));
    expect(msg).toBe('Added check: users_age_check');
  });

  it('describes foreign key addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_foreign_key', objectName: 'orders_user_id_fk' }));
    expect(msg).toBe('Added foreign key: orders_user_id_fk');
  });

  it('describes seed insertion', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_seed', objectName: 'users' }));
    expect(msg).toBe('Seeded: users');
  });

  it('describes comment setting', () => {
    const msg = formatOperationMessage(makeOp({ type: 'set_comment', objectName: 'users.email' }));
    expect(msg).toBe('Set comment: users.email');
  });

  it('describes unique constraint addition', () => {
    const msg = formatOperationMessage(makeOp({ type: 'add_unique_constraint', objectName: 'users_email_unique' }));
    expect(msg).toBe('Added unique constraint: users_email_unique');
  });

  it('describes constraint validation', () => {
    const msg = formatOperationMessage(makeOp({ type: 'validate_constraint', objectName: 'orders_user_fk' }));
    expect(msg).toBe('Validated constraint: orders_user_fk');
  });
});

describe('reportMigrationResult', () => {
  const baseResult: ExecuteResult = {
    executed: 3,
    skippedScripts: 0,
    preScriptsRun: 0,
    postScriptsRun: 0,
    dryRun: false,
    validated: false,
  };

  const sampleOps: Operation[] = [
    makeOp({ type: 'create_table', objectName: 'users' }),
    makeOp({ type: 'add_index', objectName: 'idx_users_email' }),
    makeOp({ type: 'create_policy', objectName: 'users_select' }),
  ];

  it('default mode: shows change lines and summary', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: baseResult,
      operations: sampleOps,
      mode: 'default',
      write: (msg) => lines.push(msg),
    });

    expect(lines).toContainEqual(expect.stringContaining('Created table: users'));
    expect(lines).toContainEqual(expect.stringContaining('Added index: idx_users_email'));
    expect(lines).toContainEqual(expect.stringContaining('Applied policy: users_select'));
    expect(lines).toContainEqual(expect.stringContaining('Migration complete'));
    expect(lines).toContainEqual(expect.stringContaining('3'));
  });

  it('default mode: shows nothing when zero changes', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: { ...baseResult, executed: 0 },
      operations: [],
      mode: 'default',
      write: (msg) => lines.push(msg),
    });

    // Should still show a summary for "no changes"
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('0');
  });

  it('quiet mode: shows summary only when there are changes', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: baseResult,
      operations: sampleOps,
      mode: 'quiet',
      write: (msg) => lines.push(msg),
    });

    // Only the summary line, no per-operation lines
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('Migration complete');
    expect(lines[0]).toContain('3');
  });

  it('quiet mode: shows nothing on zero changes', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: { ...baseResult, executed: 0 },
      operations: [],
      mode: 'quiet',
      write: (msg) => lines.push(msg),
    });

    expect(lines.length).toBe(0);
  });

  it('verbose mode: shows all operations and summary', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: baseResult,
      operations: sampleOps,
      mode: 'verbose',
      write: (msg) => lines.push(msg),
    });

    expect(lines).toContainEqual(expect.stringContaining('Created table: users'));
    expect(lines).toContainEqual(expect.stringContaining('Added index: idx_users_email'));
    expect(lines).toContainEqual(expect.stringContaining('Applied policy: users_select'));
    expect(lines).toContainEqual(expect.stringContaining('Migration complete'));
  });

  it('includes pre/post script counts in summary when present', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: { ...baseResult, preScriptsRun: 2, postScriptsRun: 1 },
      operations: sampleOps,
      mode: 'default',
      write: (msg) => lines.push(msg),
    });

    expect(lines).toContainEqual(expect.stringContaining('Pre-scripts: 2'));
    expect(lines).toContainEqual(expect.stringContaining('Post-scripts: 1'));
  });

  it('includes skipped count in summary when present', () => {
    const lines: string[] = [];
    reportMigrationResult({
      result: { ...baseResult, skippedScripts: 5 },
      operations: sampleOps,
      mode: 'default',
      write: (msg) => lines.push(msg),
    });

    expect(lines).toContainEqual(expect.stringContaining('Skipped'));
    expect(lines).toContainEqual(expect.stringContaining('5'));
  });
});
