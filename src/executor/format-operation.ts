/**
 * Human-readable descriptions for migration operations.
 */

import type { Operation, OperationType } from '../planner/index.js';

const DESCRIPTIONS: Record<OperationType, string> = {
  // Tables & Columns
  create_table: 'Created table',
  drop_table: 'Dropped table',
  add_column: 'Added column',
  alter_column: 'Altered column',
  drop_column: 'Dropped column',
  // Indexes
  add_index: 'Added index',
  drop_index: 'Dropped index',
  // Constraints
  add_check: 'Added check',
  add_check_not_valid: 'Added check (NOT VALID)',
  drop_check: 'Dropped check',
  add_foreign_key: 'Added foreign key',
  add_foreign_key_not_valid: 'Added foreign key (NOT VALID)',
  validate_constraint: 'Validated constraint',
  drop_foreign_key: 'Dropped foreign key',
  add_unique_constraint: 'Added unique constraint',
  drop_unique_constraint: 'Dropped unique constraint',
  add_exclusion_constraint: 'Added exclusion constraint',
  drop_exclusion_constraint: 'Dropped exclusion constraint',
  // Enums
  create_enum: 'Created enum',
  add_enum_value: 'Added enum value',
  remove_enum_value: 'Removed enum value',
  // Functions
  create_function: 'Created function',
  // Triggers
  create_trigger: 'Created trigger',
  drop_trigger: 'Dropped trigger',
  // RLS
  enable_rls: 'Enabled RLS',
  disable_rls: 'Disabled RLS',
  force_rls: 'Forced RLS',
  disable_force_rls: 'Disabled force RLS',
  create_policy: 'Applied policy',
  drop_policy: 'Dropped policy',
  // Views
  create_view: 'Created view',
  drop_view: 'Dropped view',
  create_materialized_view: 'Created materialized view',
  drop_materialized_view: 'Dropped materialized view',
  refresh_materialized_view: 'Refreshed materialized view',
  // Extensions
  create_extension: 'Created extension',
  drop_extension: 'Dropped extension',
  // Roles & Grants
  create_role: 'Created role',
  alter_role: 'Altered role',
  grant_table: 'Granted',
  grant_column: 'Granted',
  revoke_table: 'Revoked',
  revoke_column: 'Revoked',
  grant_function: 'Granted',
  revoke_function: 'Revoked',
  grant_membership: 'Granted membership',
  grant_schema: 'Granted schema',
  grant_sequence: 'Granted',
  revoke_sequence: 'Revoked',
  // Prechecks
  run_precheck: 'Ran precheck',
  // Expand/contract
  expand_column: 'Expanded column',
  create_dual_write_trigger: 'Created dual-write trigger',
  // Other
  set_comment: 'Set comment',
  add_seed: 'Seeded',
  seed_table: 'Seeded',
  tighten_not_null: 'Tightened NOT NULL',
};

const GRANT_REVOKE_TYPES = new Set<OperationType>([
  'grant_table',
  'grant_column',
  'revoke_table',
  'revoke_column',
  'grant_function',
  'revoke_function',
  'grant_sequence',
  'revoke_sequence',
]);

export function formatOperationMessage(op: Operation): string {
  const prefix = DESCRIPTIONS[op.type];
  if (op.type === 'seed_table' && op.seedResult) {
    const parts: string[] = [];
    if (op.seedResult.inserted > 0) parts.push(`${op.seedResult.inserted} inserted`);
    if (op.seedResult.updated > 0) parts.push(`${op.seedResult.updated} updated`);
    if (op.seedResult.unchanged > 0) parts.push(`${op.seedResult.unchanged} unchanged`);
    if (parts.length > 0) {
      return `${prefix}: ${op.objectName} (${parts.join(', ')})`;
    }
    return `${prefix}: ${op.objectName}`;
  }
  if (GRANT_REVOKE_TYPES.has(op.type)) {
    return `${prefix} ${op.objectName}`;
  }
  return `${prefix}: ${op.objectName}`;
}
