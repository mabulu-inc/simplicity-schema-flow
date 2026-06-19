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
  drop_function: 'Dropped function',
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
  revoke_membership: 'Revoked membership',
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

// Present-tense variants used by `plan` output, where nothing has happened yet
// and past-tense reads as a false completion claim.
const PRESENT_DESCRIPTIONS: Record<OperationType, string> = {
  create_table: 'Create table',
  drop_table: 'Drop table',
  add_column: 'Add column',
  alter_column: 'Alter column',
  drop_column: 'Drop column',
  add_index: 'Add index',
  drop_index: 'Drop index',
  add_check: 'Add check',
  add_check_not_valid: 'Add check (NOT VALID)',
  drop_check: 'Drop check',
  add_foreign_key: 'Add foreign key',
  add_foreign_key_not_valid: 'Add foreign key (NOT VALID)',
  validate_constraint: 'Validate constraint',
  drop_foreign_key: 'Drop foreign key',
  add_unique_constraint: 'Add unique constraint',
  drop_unique_constraint: 'Drop unique constraint',
  add_exclusion_constraint: 'Add exclusion constraint',
  drop_exclusion_constraint: 'Drop exclusion constraint',
  create_enum: 'Create enum',
  add_enum_value: 'Add enum value',
  remove_enum_value: 'Remove enum value',
  create_function: 'Create function',
  drop_function: 'Drop function',
  create_trigger: 'Create trigger',
  drop_trigger: 'Drop trigger',
  enable_rls: 'Enable RLS',
  disable_rls: 'Disable RLS',
  force_rls: 'Force RLS',
  disable_force_rls: 'Disable force RLS',
  create_policy: 'Apply policy',
  drop_policy: 'Drop policy',
  create_view: 'Create view',
  drop_view: 'Drop view',
  create_materialized_view: 'Create materialized view',
  drop_materialized_view: 'Drop materialized view',
  refresh_materialized_view: 'Refresh materialized view',
  create_extension: 'Create extension',
  drop_extension: 'Drop extension',
  create_role: 'Create role',
  alter_role: 'Alter role',
  grant_table: 'Grant',
  grant_column: 'Grant',
  revoke_table: 'Revoke',
  revoke_column: 'Revoke',
  grant_function: 'Grant',
  revoke_function: 'Revoke',
  grant_membership: 'Grant membership',
  revoke_membership: 'Revoke membership',
  grant_schema: 'Grant schema',
  grant_sequence: 'Grant',
  revoke_sequence: 'Revoke',
  run_precheck: 'Run precheck',
  expand_column: 'Expand column',
  create_dual_write_trigger: 'Create dual-write trigger',
  set_comment: 'Set comment',
  add_seed: 'Seed',
  seed_table: 'Seed',
  tighten_not_null: 'Tighten NOT NULL',
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

export function formatOperationMessage(op: Operation, options: { dryRun?: boolean } = {}): string {
  const prefix = (options.dryRun ? PRESENT_DESCRIPTIONS : DESCRIPTIONS)[op.type];
  if (op.type === 'seed_table' && op.seedResult) {
    const parts: string[] = [];
    if (op.seedResult.inserted > 0) parts.push(`${op.seedResult.inserted} inserted`);
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
