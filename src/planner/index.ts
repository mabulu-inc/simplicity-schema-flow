/**
 * Planner / diff engine for schema-flow.
 *
 * Compares desired (YAML) state vs actual (introspected) state and
 * produces an ordered list of operations to converge the database.
 */

import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  IndexKey,
  CheckDef,
  UniqueConstraintDef,
  TriggerDef,
  PolicyDef,
  GrantDef,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ExtensionsSchema,
  SeedOnConflict,
} from '../schema/types.js';
import { planExpandColumn } from '../expand/index.js';

// ─── Operation Types ───────────────────────────────────────────

export type OperationType =
  // Tables & Columns
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'alter_column'
  | 'drop_column'
  // Indexes
  | 'add_index'
  | 'drop_index'
  // Constraints
  | 'add_check'
  | 'add_check_not_valid'
  | 'drop_check'
  | 'add_foreign_key'
  | 'add_foreign_key_not_valid'
  | 'validate_constraint'
  | 'drop_foreign_key'
  | 'add_unique_constraint'
  | 'drop_unique_constraint'
  // Enums
  | 'create_enum'
  | 'add_enum_value'
  | 'remove_enum_value'
  // Functions
  | 'create_function'
  // Triggers
  | 'create_trigger'
  | 'drop_trigger'
  // RLS
  | 'enable_rls'
  | 'disable_rls'
  | 'force_rls'
  | 'disable_force_rls'
  | 'create_policy'
  | 'drop_policy'
  // Views
  | 'create_view'
  | 'drop_view'
  | 'create_materialized_view'
  | 'drop_materialized_view'
  | 'refresh_materialized_view'
  // Extensions
  | 'create_extension'
  | 'drop_extension'
  // Roles & Grants
  | 'create_role'
  | 'alter_role'
  | 'grant_table'
  | 'grant_column'
  | 'revoke_table'
  | 'revoke_column'
  | 'grant_function'
  | 'revoke_function'
  | 'grant_membership'
  | 'grant_schema'
  | 'grant_sequence'
  | 'revoke_sequence'
  // Prechecks
  | 'run_precheck'
  // Expand/contract
  | 'expand_column'
  | 'create_dual_write_trigger'
  | 'backfill_column'
  // Other
  | 'set_comment'
  | 'add_seed'
  | 'seed_table';

export interface Operation {
  type: OperationType;
  /** Phase order for execution (lower = earlier) */
  phase: number;
  /** Object name (e.g. table name, enum name) */
  objectName: string;
  /** SQL to execute */
  sql: string;
  /** Whether this is a destructive operation */
  destructive: boolean;
  /** Whether this operation must run outside a transaction (e.g. CONCURRENTLY) */
  concurrent?: boolean;
  /** Abort message for precheck failures */
  precheckMessage?: string;
  /** Seed rows for seed_table operations */
  seedRows?: Record<string, unknown>[];
  /** Column metadata for seed_table operations */
  seedColumns?: { name: string; type: string; isPk: boolean }[];
  /** Conflict strategy for seed_table operations */
  seedOnConflict?: SeedOnConflict;
  /** Result counts filled by executor after seed_table execution */
  seedResult?: { inserted: number; updated: number; unchanged: number };
}

// ─── Desired State (parsed from YAML) ──────────────────────────

export interface DesiredState {
  tables: TableSchema[];
  enums: EnumSchema[];
  functions: FunctionSchema[];
  views: ViewSchema[];
  materializedViews: MaterializedViewSchema[];
  roles: RoleSchema[];
  extensions: ExtensionsSchema | null;
}

// ─── Actual State (introspected from DB) ───────────────────────

export interface ActualState {
  tables: Map<string, TableSchema>;
  enums: Map<string, EnumSchema>;
  functions: Map<string, FunctionSchema>;
  views: Map<string, ViewSchema>;
  materializedViews: Map<string, MaterializedViewSchema>;
  roles: Map<string, RoleSchema>;
  extensions: string[];
}

export interface PlanOptions {
  allowDestructive?: boolean;
  pgSchema?: string;
}

export interface PlanResult {
  operations: Operation[];
  /** Operations that were blocked because allowDestructive is false */
  blocked: Operation[];
}

// ─── Main Planner ──────────────────────────────────────────────

export function buildPlan(desired: DesiredState, actual: ActualState, options: PlanOptions = {}): PlanResult {
  const { allowDestructive = false, pgSchema = 'public' } = options;
  const allOps: Operation[] = [];

  // Diff extensions
  allOps.push(...diffExtensions(desired.extensions, actual.extensions));

  // Diff enums
  allOps.push(...diffEnums(desired.enums, actual.enums, pgSchema));

  // Diff roles
  allOps.push(...diffRoles(desired.roles, actual.roles));

  // Diff functions
  allOps.push(...diffFunctions(desired.functions, actual.functions, pgSchema));

  // Diff tables (without FKs first)
  allOps.push(...diffTables(desired.tables, actual.tables, pgSchema));

  // Diff views
  allOps.push(...diffViews(desired.views, actual.views, pgSchema));

  // Diff materialized views
  allOps.push(...diffMaterializedViews(desired.materializedViews, actual.materializedViews, pgSchema));

  // Sort by phase
  allOps.sort((a, b) => a.phase - b.phase);

  // Separate destructive operations if not allowed
  const operations: Operation[] = [];
  const blocked: Operation[] = [];

  for (const op of allOps) {
    if (op.destructive && !allowDestructive) {
      blocked.push(op);
    } else {
      operations.push(op);
    }
  }

  return { operations, blocked };
}

// ─── Extensions ────────────────────────────────────────────────

function diffExtensions(desired: ExtensionsSchema | null, actual: string[]): Operation[] {
  const ops: Operation[] = [];
  const desiredExts = desired?.extensions ?? [];

  for (const ext of desiredExts) {
    if (!actual.includes(ext)) {
      ops.push({
        type: 'create_extension',
        phase: 2,
        objectName: ext,
        sql: `CREATE EXTENSION IF NOT EXISTS "${ext}"`,
        destructive: false,
      });
    }
  }

  // Extensions in DB but not in YAML → drop (destructive)
  for (const ext of actual) {
    if (!desiredExts.includes(ext)) {
      ops.push({
        type: 'drop_extension',
        phase: 2,
        objectName: ext,
        sql: `DROP EXTENSION IF EXISTS "${ext}"`,
        destructive: true,
      });
    }
  }

  // Schema grants (GRANT USAGE ON SCHEMA ... TO ...)
  if (desired?.schema_grants) {
    for (const sg of desired.schema_grants) {
      for (const schema of sg.schemas) {
        ops.push({
          type: 'grant_schema',
          phase: 13,
          objectName: `${schema}.${sg.to}`,
          sql: `GRANT USAGE ON SCHEMA "${schema}" TO "${sg.to}"`,
          destructive: false,
        });
      }
    }
  }

  return ops;
}

// ─── Enums ─────────────────────────────────────────────────────

function diffEnums(desired: EnumSchema[], actual: Map<string, EnumSchema>, _pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const desiredEnum of desired) {
    const existing = actual.get(desiredEnum.name);
    if (!existing) {
      // Create new enum (idempotent — PostgreSQL lacks CREATE TYPE IF NOT EXISTS)
      const values = desiredEnum.values.map((v) => `'${v}'`).join(', ');
      ops.push({
        type: 'create_enum',
        phase: 3,
        objectName: desiredEnum.name,
        sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${desiredEnum.name}') THEN CREATE TYPE "${desiredEnum.name}" AS ENUM (${values}); END IF; END $$`,
        destructive: false,
      });
      if (desiredEnum.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: desiredEnum.name,
          sql: `COMMENT ON TYPE "${desiredEnum.name}" IS '${escapeQuote(desiredEnum.comment)}'`,
          destructive: false,
        });
      }
    } else {
      // Add new values (append-only)
      for (const val of desiredEnum.values) {
        if (!existing.values.includes(val)) {
          ops.push({
            type: 'add_enum_value',
            phase: 3,
            objectName: desiredEnum.name,
            sql: `ALTER TYPE "${desiredEnum.name}" ADD VALUE IF NOT EXISTS '${val}'`,
            destructive: false,
          });
        }
      }
      // Detect removed values (destructive)
      for (const val of existing.values) {
        if (!desiredEnum.values.includes(val)) {
          ops.push({
            type: 'remove_enum_value',
            phase: 3,
            objectName: desiredEnum.name,
            sql: `-- Enum value '${val}' removed from "${desiredEnum.name}" (requires recreating the type)`,
            destructive: true,
          });
        }
      }
    }
  }

  return ops;
}

// ─── Roles ─────────────────────────────────────────────────────

function diffRoles(desired: RoleSchema[], actual: Map<string, RoleSchema>): Operation[] {
  const ops: Operation[] = [];

  for (const desiredRole of desired) {
    const existing = actual.get(desiredRole.role);
    if (!existing) {
      const attrs = buildRoleAttributes(desiredRole);
      const createStmt = `CREATE ROLE "${desiredRole.role}"${attrs ? ' ' + attrs : ''}`;
      ops.push({
        type: 'create_role',
        phase: 4,
        objectName: desiredRole.role,
        sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${desiredRole.role}') THEN ${createStmt}; END IF; END $$`,
        destructive: false,
      });
    } else {
      // Check if attributes differ
      const alterAttrs = diffRoleAttributes(desiredRole, existing);
      if (alterAttrs) {
        ops.push({
          type: 'alter_role',
          phase: 4,
          objectName: desiredRole.role,
          sql: `ALTER ROLE "${desiredRole.role}" ${alterAttrs}`,
          destructive: false,
        });
      }
    }

    // Role group memberships
    if (desiredRole.in && desiredRole.in.length > 0) {
      const existingMemberships = existing?.in ?? [];
      for (const group of desiredRole.in) {
        if (!existingMemberships.includes(group)) {
          ops.push({
            type: 'grant_membership',
            phase: 4,
            objectName: `${desiredRole.role}.${group}`,
            sql: `GRANT "${group}" TO "${desiredRole.role}"`,
            destructive: false,
          });
        }
      }
    }

    if (desiredRole.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: desiredRole.role,
        sql: `COMMENT ON ROLE "${desiredRole.role}" IS '${escapeQuote(desiredRole.comment)}'`,
        destructive: false,
      });
    }
  }

  return ops;
}

function buildRoleAttributes(role: RoleSchema): string {
  const parts: string[] = [];
  if (role.login === true) parts.push('LOGIN');
  if (role.login === false) parts.push('NOLOGIN');
  if (role.superuser === true) parts.push('SUPERUSER');
  if (role.createdb === true) parts.push('CREATEDB');
  if (role.createrole === true) parts.push('CREATEROLE');
  if (role.inherit === false) parts.push('NOINHERIT');
  if (role.bypassrls === true) parts.push('BYPASSRLS');
  if (role.replication === true) parts.push('REPLICATION');
  if (role.connection_limit !== undefined && role.connection_limit !== -1) {
    parts.push(`CONNECTION LIMIT ${role.connection_limit}`);
  }
  return parts.join(' ');
}

function diffRoleAttributes(desired: RoleSchema, actual: RoleSchema): string | null {
  const parts: string[] = [];
  if (desired.login !== undefined && desired.login !== actual.login) {
    parts.push(desired.login ? 'LOGIN' : 'NOLOGIN');
  }
  if (desired.superuser !== undefined && desired.superuser !== actual.superuser) {
    parts.push(desired.superuser ? 'SUPERUSER' : 'NOSUPERUSER');
  }
  if (desired.createdb !== undefined && desired.createdb !== actual.createdb) {
    parts.push(desired.createdb ? 'CREATEDB' : 'NOCREATEDB');
  }
  if (desired.createrole !== undefined && desired.createrole !== actual.createrole) {
    parts.push(desired.createrole ? 'CREATEROLE' : 'NOCREATEROLE');
  }
  if (desired.inherit !== undefined && desired.inherit !== actual.inherit) {
    parts.push(desired.inherit ? 'INHERIT' : 'NOINHERIT');
  }
  if (desired.bypassrls !== undefined && desired.bypassrls !== actual.bypassrls) {
    parts.push(desired.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS');
  }
  if (desired.replication !== undefined && desired.replication !== actual.replication) {
    parts.push(desired.replication ? 'REPLICATION' : 'NOREPLICATION');
  }
  if (desired.connection_limit !== undefined && desired.connection_limit !== actual.connection_limit) {
    parts.push(`CONNECTION LIMIT ${desired.connection_limit}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// ─── Functions ─────────────────────────────────────────────────

function functionNeedsUpdate(desired: FunctionSchema, existing: FunctionSchema): boolean {
  if (normalizeWhitespace(desired.body) !== normalizeWhitespace(existing.body)) return true;
  if ((desired.language || 'plpgsql') !== (existing.language || 'plpgsql')) return true;
  if (desired.returns !== existing.returns) return true;
  if ((desired.security || 'invoker') !== (existing.security || 'invoker')) return true;
  if ((desired.volatility || 'volatile') !== (existing.volatility || 'volatile')) return true;
  if ((desired.parallel || 'unsafe') !== (existing.parallel || 'unsafe')) return true;
  if (!!desired.strict !== !!existing.strict) return true;
  if (!!desired.leakproof !== !!existing.leakproof) return true;
  if ((desired.cost ?? null) !== (existing.cost ?? null)) return true;
  if ((desired.rows ?? null) !== (existing.rows ?? null)) return true;
  const desiredSet = JSON.stringify(desired.set || {});
  const existingSet = JSON.stringify(existing.set || {});
  if (desiredSet !== existingSet) return true;
  const desiredArgs = JSON.stringify(desired.args || []);
  const existingArgs = JSON.stringify(existing.args || []);
  if (desiredArgs !== existingArgs) return true;
  return false;
}

function diffFunctions(desired: FunctionSchema[], actual: Map<string, FunctionSchema>, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const fn of desired) {
    const args = fn.args
      ? fn.args
          .map((a) => {
            const parts: string[] = [];
            if (a.mode && a.mode !== 'IN') parts.push(a.mode);
            parts.push(a.name);
            parts.push(a.type);
            if (a.default != null) parts.push(`DEFAULT ${a.default}`);
            return parts.join(' ');
          })
          .join(', ')
      : '';

    const existing = actual.get(fn.name);
    const needsUpdate = !existing || functionNeedsUpdate(fn, existing);

    if (needsUpdate) {
      const security = fn.security === 'definer' ? 'SECURITY DEFINER' : 'SECURITY INVOKER';
      const volatility = (fn.volatility || 'volatile').toUpperCase();
      const language = fn.language || 'plpgsql';
      const body = fn.body;

      const parts = [
        `CREATE OR REPLACE FUNCTION "${pgSchema}"."${fn.name}"(${args}) RETURNS ${fn.returns} AS $$ ${body} $$ LANGUAGE ${language}`,
        volatility,
        security,
      ];
      if (fn.parallel && fn.parallel !== 'unsafe') parts.push(`PARALLEL ${fn.parallel.toUpperCase()}`);
      if (fn.strict) parts.push('STRICT');
      if (fn.leakproof) parts.push('LEAKPROOF');
      if (fn.cost != null) parts.push(`COST ${fn.cost}`);
      if (fn.rows != null) parts.push(`ROWS ${fn.rows}`);
      if (fn.set) {
        for (const [key, value] of Object.entries(fn.set)) {
          parts.push(`SET ${key} = ${value}`);
        }
      }

      ops.push({
        type: 'create_function',
        phase: 5,
        objectName: fn.name,
        sql: parts.join(' '),
        destructive: false,
      });
    }

    if (fn.comment && fn.comment !== existing?.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: fn.name,
        sql: `COMMENT ON FUNCTION "${pgSchema}"."${fn.name}"(${args}) IS '${escapeQuote(fn.comment)}'`,
        destructive: false,
      });
    }

    // Function grants (phase 13) — only emit when function was updated or is new
    if (fn.grants && needsUpdate) {
      const argTypes = fn.args ? fn.args.map((a) => a.type).join(', ') : '';
      for (const grant of fn.grants) {
        const privileges = grant.privileges.join(', ');
        ops.push({
          type: 'grant_function',
          phase: 13,
          objectName: `${fn.name}.${grant.to}`,
          sql: `GRANT ${privileges} ON FUNCTION "${pgSchema}"."${fn.name}"(${argTypes}) TO "${grant.to}"`,
          destructive: false,
        });
      }
    }
  }

  return ops;
}

// ─── Tables ────────────────────────────────────────────────────

function diffTables(desired: TableSchema[], actual: Map<string, TableSchema>, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const desiredTable of desired) {
    const existing = actual.get(desiredTable.table);
    if (!existing) {
      ops.push(...createTableOps(desiredTable, pgSchema));
    } else {
      ops.push(...alterTableOps(desiredTable, existing, pgSchema));
    }
  }

  // Tables in DB but not desired → drop (destructive)
  const desiredNames = new Set(desired.map((t) => t.table));
  for (const [name] of actual) {
    if (!desiredNames.has(name)) {
      ops.push({
        type: 'drop_table',
        phase: 6,
        objectName: name,
        sql: `DROP TABLE "${pgSchema}"."${name}" CASCADE`,
        destructive: true,
      });
    }
  }

  return ops;
}

/**
 * Wraps an ADD CONSTRAINT statement in a DO block that checks pg_constraint
 * first, making the operation idempotent. PostgreSQL does not support
 * ADD CONSTRAINT IF NOT EXISTS, so we use a PL/pgSQL guard.
 */
function wrapConstraintIdempotent(constraintName: string, alterSql: string): string {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraintName}') THEN ${alterSql}; END IF; END $$`;
}

function createTableOps(table: TableSchema, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  // Prechecks (phase 0 — run before any operations)
  if (table.prechecks) {
    for (const pc of table.prechecks) {
      ops.push({
        type: 'run_precheck',
        phase: 0,
        objectName: `${table.table}.${pc.name}`,
        sql: pc.query,
        destructive: false,
        precheckMessage: pc.message,
      });
    }
  }

  // Build CREATE TABLE with columns (no FKs), excluding expand columns
  const colDefs: string[] = [];
  const fkColumns: ColumnDef[] = [];
  const expandColumns: ColumnDef[] = [];

  for (const col of table.columns) {
    // Expand columns are handled separately via expand operations
    if (col.expand) {
      expandColumns.push(col);
      continue;
    }

    let def = `"${col.name}" ${col.type}`;
    if (col.primary_key) def += ' PRIMARY KEY';
    if (col.nullable === false && !col.primary_key) def += ' NOT NULL';
    if (col.default !== undefined) def += ` DEFAULT ${col.default}`;
    if (col.unique && col.unique_name) {
      // Named unique constraint — separate table-level constraint
    } else if (col.unique) {
      def += ' UNIQUE';
    }
    if (col.generated) def += ` GENERATED ALWAYS AS (${col.generated}) STORED`;
    colDefs.push(def);

    if (col.references) fkColumns.push(col);
  }

  // Column-level named unique constraints
  for (const col of table.columns) {
    if (col.unique && col.unique_name) {
      colDefs.push(`CONSTRAINT "${col.unique_name}" UNIQUE ("${col.name}")`);
    }
  }

  // Composite primary key
  if (table.primary_key && table.primary_key.length > 0) {
    const pkCols = table.primary_key.map((c) => `"${c}"`).join(', ');
    if (table.primary_key_name) {
      colDefs.push(`CONSTRAINT "${table.primary_key_name}" PRIMARY KEY (${pkCols})`);
    } else {
      colDefs.push(`PRIMARY KEY (${pkCols})`);
    }
  }

  // Check constraints
  if (table.checks) {
    for (const check of table.checks) {
      colDefs.push(`CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    }
  }

  // Unique constraints
  if (table.unique_constraints) {
    for (const uc of table.unique_constraints) {
      const ucCols = uc.columns.map((c) => `"${c}"`).join(', ');
      const ucName = uc.name || `uq_${table.table}_${uc.columns.join('_')}`;
      const nnd = uc.nulls_not_distinct ? ' NULLS NOT DISTINCT' : '';
      colDefs.push(`CONSTRAINT "${ucName}" UNIQUE${nnd} (${ucCols})`);
    }
  }

  ops.push({
    type: 'create_table',
    phase: 6,
    objectName: table.table,
    sql: `CREATE TABLE IF NOT EXISTS "${pgSchema}"."${table.table}" (\n  ${colDefs.join(',\n  ')}\n)`,
    destructive: false,
  });

  // Expand columns — generate expand operations (phase 100+)
  for (const col of expandColumns) {
    const expandOps = planExpandColumn(table.table, col.name, col.type, col.expand!, pgSchema);
    for (const eop of expandOps) {
      ops.push({
        type: eop.type as OperationType,
        phase: eop.phase,
        objectName: eop.objectName,
        sql: eop.sql,
        destructive: eop.destructive,
      });
    }
  }

  // Indexes (phase 7)
  if (table.indexes) {
    for (const idx of table.indexes) {
      ops.push(createIndexOp(table.table, idx, pgSchema));
      if (idx.comment) {
        const idxName = idx.name || defaultIndexName(table.table, idx);
        ops.push({
          type: 'set_comment',
          phase: 7,
          objectName: idxName,
          sql: `COMMENT ON INDEX "${pgSchema}"."${idxName}" IS '${escapeQuote(idx.comment)}'`,
          destructive: false,
          concurrent: true,
        });
      }
    }
  }

  // Foreign keys (phase 8) — added as NOT VALID
  for (const col of fkColumns) {
    const ref = col.references!;
    const constraintName = ref.name || `fk_${table.table}_${col.name}_${ref.table}`;
    const onDelete = ref.on_delete || 'NO ACTION';
    const onUpdate = ref.on_update || 'NO ACTION';
    const refSchema = ref.schema || pgSchema;
    let fkSql = `ALTER TABLE "${pgSchema}"."${table.table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${col.name}") REFERENCES "${refSchema}"."${ref.table}" ("${ref.column}") ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
    if (ref.deferrable) {
      fkSql += ref.initially_deferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE INITIALLY IMMEDIATE';
    }
    fkSql += ' NOT VALID';
    ops.push({
      type: 'add_foreign_key_not_valid',
      phase: 8,
      objectName: `${table.table}.${col.name}`,
      sql: wrapConstraintIdempotent(constraintName, fkSql),
      destructive: false,
    });
    ops.push({
      type: 'validate_constraint',
      phase: 8,
      objectName: `${table.table}.${constraintName}`,
      sql: `ALTER TABLE "${pgSchema}"."${table.table}" VALIDATE CONSTRAINT "${constraintName}"`,
      destructive: false,
    });
  }

  // Triggers (phase 11)
  if (table.triggers) {
    for (const trigger of table.triggers) {
      ops.push(createTriggerOp(table.table, trigger, pgSchema));
      if (trigger.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table.table}.${trigger.name}`,
          sql: `COMMENT ON TRIGGER "${trigger.name}" ON "${pgSchema}"."${table.table}" IS '${escapeQuote(trigger.comment)}'`,
          destructive: false,
        });
      }
    }
  }

  // RLS (phase 12)
  if (table.rls || (table.policies && table.policies.length > 0)) {
    ops.push({
      type: 'enable_rls',
      phase: 12,
      objectName: table.table,
      sql: `ALTER TABLE "${pgSchema}"."${table.table}" ENABLE ROW LEVEL SECURITY`,
      destructive: false,
    });
  }
  if (table.force_rls) {
    ops.push({
      type: 'force_rls',
      phase: 12,
      objectName: table.table,
      sql: `ALTER TABLE "${pgSchema}"."${table.table}" FORCE ROW LEVEL SECURITY`,
      destructive: false,
    });
  }
  if (table.policies) {
    for (const policy of table.policies) {
      ops.push(createPolicyOp(table.table, policy, pgSchema));
      if (policy.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table.table}.${policy.name}`,
          sql: `COMMENT ON POLICY "${policy.name}" ON "${pgSchema}"."${table.table}" IS '${escapeQuote(policy.comment)}'`,
          destructive: false,
        });
      }
    }
  }

  // Grants (phase 13)
  if (table.grants) {
    for (const grant of table.grants) {
      ops.push(createGrantOp(table.table, grant, pgSchema));
    }
    // Auto-generate sequence grants for serial/bigserial columns
    ops.push(...createSequenceGrantOps(table.table, table.columns, table.grants, pgSchema));
  }

  // Comments (phase 14)
  if (table.comment) {
    ops.push({
      type: 'set_comment',
      phase: 14,
      objectName: table.table,
      sql: `COMMENT ON TABLE "${pgSchema}"."${table.table}" IS '${escapeQuote(table.comment)}'`,
      destructive: false,
    });
  }

  for (const col of table.columns) {
    if (col.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: `${table.table}.${col.name}`,
        sql: `COMMENT ON COLUMN "${pgSchema}"."${table.table}"."${col.name}" IS '${escapeQuote(col.comment)}'`,
        destructive: false,
      });
    }
  }

  if (table.checks) {
    for (const check of table.checks) {
      if (check.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table.table}.${check.name}`,
          sql: `COMMENT ON CONSTRAINT "${check.name}" ON "${pgSchema}"."${table.table}" IS '${escapeQuote(check.comment)}'`,
          destructive: false,
        });
      }
    }
  }

  if (table.unique_constraints) {
    for (const uc of table.unique_constraints) {
      if (uc.comment) {
        const ucName = uc.name || `uq_${table.table}_${uc.columns.join('_')}`;
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table.table}.${ucName}`,
          sql: `COMMENT ON CONSTRAINT "${ucName}" ON "${pgSchema}"."${table.table}" IS '${escapeQuote(uc.comment)}'`,
          destructive: false,
        });
      }
    }
  }

  // Seeds (phase 15)
  if (table.seeds && table.seeds.length > 0) {
    ops.push(createSeedTableOp(table.table, table.seeds, table.columns, pgSchema, table.seeds_on_conflict));
  }

  return ops;
}

function alterTableOps(desired: TableSchema, existing: TableSchema, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  // Prechecks (phase 0 — run before any operations)
  if (desired.prechecks) {
    for (const pc of desired.prechecks) {
      ops.push({
        type: 'run_precheck',
        phase: 0,
        objectName: `${desired.table}.${pc.name}`,
        sql: pc.query,
        destructive: false,
        precheckMessage: pc.message,
      });
    }
  }

  const existingColMap = new Map(existing.columns.map((c) => [c.name, c]));
  const desiredColMap = new Map(desired.columns.map((c) => [c.name, c]));

  // Add new columns
  for (const col of desired.columns) {
    const existingCol = existingColMap.get(col.name);
    if (!existingCol) {
      // Expand columns use expand operations instead of plain add_column
      if (col.expand) {
        const expandOps = planExpandColumn(desired.table, col.name, col.type, col.expand, pgSchema);
        for (const eop of expandOps) {
          ops.push({
            type: eop.type as OperationType,
            phase: eop.phase,
            objectName: eop.objectName,
            sql: eop.sql,
            destructive: eop.destructive,
          });
        }
        continue;
      }

      let def = `"${col.name}" ${col.type}`;
      if (col.nullable === false) def += ' NOT NULL';
      if (col.default !== undefined) def += ` DEFAULT ${col.default}`;
      if (col.generated) def += ` GENERATED ALWAYS AS (${col.generated}) STORED`;
      ops.push({
        type: 'add_column',
        phase: 6,
        objectName: `${desired.table}.${col.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${desired.table}" ADD COLUMN ${def}`,
        destructive: false,
      });

      // FK for new column
      if (col.references) {
        const ref = col.references;
        const constraintName = ref.name || `fk_${desired.table}_${col.name}_${ref.table}`;
        const onDelete = ref.on_delete || 'NO ACTION';
        const onUpdate = ref.on_update || 'NO ACTION';
        const refSchema = ref.schema || pgSchema;
        let fkSql = `ALTER TABLE "${pgSchema}"."${desired.table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${col.name}") REFERENCES "${refSchema}"."${ref.table}" ("${ref.column}") ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
        if (ref.deferrable) {
          fkSql += ref.initially_deferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE INITIALLY IMMEDIATE';
        }
        fkSql += ' NOT VALID';
        ops.push({
          type: 'add_foreign_key_not_valid',
          phase: 8,
          objectName: `${desired.table}.${col.name}`,
          sql: wrapConstraintIdempotent(constraintName, fkSql),
          destructive: false,
        });
        ops.push({
          type: 'validate_constraint',
          phase: 8,
          objectName: `${desired.table}.${constraintName}`,
          sql: `ALTER TABLE "${pgSchema}"."${desired.table}" VALIDATE CONSTRAINT "${constraintName}"`,
          destructive: false,
        });
      }

      if (col.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${desired.table}.${col.name}`,
          sql: `COMMENT ON COLUMN "${pgSchema}"."${desired.table}"."${col.name}" IS '${escapeQuote(col.comment)}'`,
          destructive: false,
        });
      }
    } else {
      // Alter existing column if different
      ops.push(...diffColumn(desired.table, col, existingCol, pgSchema));
    }
  }

  // Drop columns not in desired. Also remember which columns are going away
  // so constraint-diff functions below can skip drops that Postgres will
  // auto-cascade (dropping a column cascades any table-level constraint
  // involving only that column, per Postgres ALTER TABLE docs).
  const droppedColNames = new Set<string>();
  for (const col of existing.columns) {
    if (!desiredColMap.has(col.name)) {
      droppedColNames.add(col.name);
      ops.push({
        type: 'drop_column',
        phase: 6,
        objectName: `${desired.table}.${col.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${desired.table}" DROP COLUMN "${col.name}"`,
        destructive: true,
      });
    }
  }

  // Diff unique constraints (safe 2-step pattern: CONCURRENTLY index + USING INDEX)
  ops.push(
    ...diffUniqueConstraints(
      desired.table,
      desired.unique_constraints || [],
      existing.unique_constraints || [],
      desired.columns,
      pgSchema,
      droppedColNames,
    ),
  );

  // Diff indexes
  ops.push(...diffIndexes(desired.table, desired.indexes || [], existing.indexes || [], pgSchema));

  // Diff checks
  ops.push(...diffChecks(desired.table, desired.checks || [], existing.checks || [], pgSchema));

  // Diff triggers
  ops.push(...diffTriggers(desired.table, desired.triggers || [], existing.triggers || [], pgSchema));

  // Diff RLS
  ops.push(...diffRls(desired, existing, pgSchema));

  // Diff policies
  ops.push(...diffPolicies(desired.table, desired.policies || [], existing.policies || [], pgSchema));

  // Diff grants. Previously this blindly re-emitted every declared grant on
  // every run — the plan's biggest source of noise for no-op migrations.
  // Now we compare the normalized desired vs existing grant sets and only
  // emit the delta (GRANT for newly-declared privileges, REVOKE for ones
  // removed from YAML).
  ops.push(...diffGrants(desired.table, desired.grants || [], existing.grants || [], pgSchema));

  // Sequence grants are auto-derived from table grants for serial/bigserial
  // columns and aren't yet introspected back, so we still emit them blindly
  // here. They use `GRANT USAGE, SELECT` which is idempotent in Postgres
  // (no error, no re-grant), but they do still count against the plan size.
  // Follow-up: introspect sequence privileges and diff them here too.
  if (desired.grants) {
    ops.push(...createSequenceGrantOps(desired.table, desired.columns, desired.grants, pgSchema));
  }

  // Comment
  if (desired.comment && desired.comment !== existing.comment) {
    ops.push({
      type: 'set_comment',
      phase: 14,
      objectName: desired.table,
      sql: `COMMENT ON TABLE "${pgSchema}"."${desired.table}" IS '${escapeQuote(desired.comment)}'`,
      destructive: false,
    });
  }

  // Seeds
  if (desired.seeds && desired.seeds.length > 0) {
    ops.push(createSeedTableOp(desired.table, desired.seeds, desired.columns, pgSchema, desired.seeds_on_conflict));
  }

  return ops;
}

function diffColumn(table: string, desired: ColumnDef, existing: ColumnDef, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  // Type change
  if (normalizeTypeName(desired.type) !== normalizeTypeName(existing.type)) {
    ops.push({
      type: 'alter_column',
      phase: 6,
      objectName: `${table}.${desired.name}`,
      sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" TYPE ${desired.type}`,
      destructive: false,
    });
  }

  // Nullable change — skip for primary key columns (PK columns are always NOT NULL)
  const isPrimaryKey = desired.primary_key || existing.primary_key;
  const desiredNullable = desired.nullable !== false;
  const existingNullable = existing.nullable !== false;
  if (!isPrimaryKey && desiredNullable !== existingNullable) {
    if (desiredNullable) {
      ops.push({
        type: 'alter_column',
        phase: 6,
        objectName: `${table}.${desired.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" DROP NOT NULL`,
        destructive: false,
      });
    } else {
      // Safe NOT NULL pattern (PRD §8.3):
      // 1. ADD CHECK (col IS NOT NULL) NOT VALID
      // 2. VALIDATE CONSTRAINT (scans without ACCESS EXCLUSIVE lock)
      // 3. ALTER COLUMN SET NOT NULL (instant — PG trusts validated check)
      // 4. DROP the redundant check constraint
      const checkName = `chk_${table}_${desired.name}_not_null`;
      ops.push({
        type: 'add_check_not_valid',
        phase: 6,
        objectName: `${table}.${desired.name}`,
        sql: wrapConstraintIdempotent(
          checkName,
          `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${checkName}" CHECK ("${desired.name}" IS NOT NULL) NOT VALID`,
        ),
        destructive: false,
      });
      ops.push({
        type: 'validate_constraint',
        phase: 6,
        objectName: `${table}.${checkName}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" VALIDATE CONSTRAINT "${checkName}"`,
        destructive: false,
      });
      ops.push({
        type: 'alter_column',
        phase: 6,
        objectName: `${table}.${desired.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" SET NOT NULL`,
        destructive: false,
      });
      ops.push({
        type: 'drop_check',
        phase: 6,
        objectName: `${table}.${checkName}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT "${checkName}"`,
        destructive: false,
      });
    }
  }

  // Default change
  if (desired.default !== undefined && desired.default !== existing.default) {
    ops.push({
      type: 'alter_column',
      phase: 6,
      objectName: `${table}.${desired.name}`,
      sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" SET DEFAULT ${desired.default}`,
      destructive: false,
    });
  } else if (desired.default === undefined && existing.default !== undefined) {
    // Don't drop auto-generated sequence defaults for serial/bigserial columns
    const isSerialType = /^(serial|bigserial)$/i.test(desired.type);
    const isSequenceDefault = /^nextval\(/i.test(existing.default ?? '');
    if (!(isSerialType && isSequenceDefault)) {
      ops.push({
        type: 'alter_column',
        phase: 6,
        objectName: `${table}.${desired.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" DROP DEFAULT`,
        destructive: false,
      });
    }
  }

  // Comment change
  if (desired.comment && desired.comment !== existing.comment) {
    ops.push({
      type: 'set_comment',
      phase: 14,
      objectName: `${table}.${desired.name}`,
      sql: `COMMENT ON COLUMN "${pgSchema}"."${table}"."${desired.name}" IS '${escapeQuote(desired.comment)}'`,
      destructive: false,
    });
  }

  return ops;
}

// ─── Indexes ───────────────────────────────────────────────────

/**
 * Slug for a single index key, used when generating a default index name.
 * Plain columns pass through; expressions are aggressively slugged — the
 * human-readable name isn't load-bearing for expressions (they're typically
 * given an explicit `name` in YAML), but we still produce something stable
 * in case the user forgets to name one.
 */
function indexKeySlug(key: IndexKey): string {
  if (typeof key === 'string') return key;
  return (
    key.expression
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'expr'
  );
}

/** Default generated name for an index missing `name` in YAML. Exported so
 *  drift can compute the same name. */
export function defaultIndexName(table: string, idx: IndexDef): string {
  return `idx_${table}_${idx.columns.map(indexKeySlug).join('_')}`;
}

/**
 * SQL fragment for one index key in the CREATE INDEX column list.
 * Plain columns are quoted identifiers; expressions are wrapped in parens
 * per Postgres syntax: `CREATE INDEX … USING btree ((lower(email)))`.
 */
function indexKeySql(key: IndexKey, opclass?: string): string {
  const base = typeof key === 'string' ? `"${key}"` : `(${key.expression})`;
  return opclass ? `${base} ${opclass}` : base;
}

/**
 * Identity of an index key for cross-state equality. Whitespace is
 * collapsed and case-folded for expressions because Postgres's
 * `pg_get_expr` re-renders them with its own spacing; two equivalent
 * expressions shouldn't look different to the diff just because of
 * formatting. Whitespace adjacent to `(`, `)`, or `,` is also stripped
 * so e.g. `lower(email)` matches `lower( email )`.
 */
function indexKeyIdentity(key: IndexKey): string {
  if (typeof key === 'string') return `col:${key.toLowerCase()}`;
  return `expr:${normalizeExpressionForCompare(key.expression)}`;
}

function normalizeExpressionForCompare(expr: string): string {
  return expr
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

/** Combined identity for an index's full key list (columns + opclass).
 *  Exported so drift uses the same equality semantics. */
export function indexKeysIdentity(idx: IndexDef): string {
  return idx.columns.map((k) => indexKeyIdentity(k)).join('|') + (idx.opclass ? `|opclass:${idx.opclass}` : '');
}

function diffIndexes(table: string, desired: IndexDef[], existing: IndexDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map<string, IndexDef>();
  for (const idx of existing) {
    if (idx.name) existingByName.set(idx.name, idx);
  }

  for (const idx of desired) {
    const name = idx.name || defaultIndexName(table, idx);
    const existingIdx = existingByName.get(name);
    if (!existingIdx) {
      ops.push(createIndexOp(table, { ...idx, name }, pgSchema));
    } else if (indexNeedsRecreate(idx, existingIdx)) {
      // Keys, where-clause, include-list, or uniqueness changed. PG has no
      // ALTER INDEX for these; drop and recreate.
      ops.push({
        type: 'drop_index',
        phase: 7,
        objectName: name,
        sql: `DROP INDEX IF EXISTS "${pgSchema}"."${name}"`,
        destructive: true,
      });
      ops.push(createIndexOp(table, { ...idx, name }, pgSchema));
    }
    if (idx.comment && idx.comment !== existingIdx?.comment) {
      ops.push({
        type: 'set_comment',
        phase: 7,
        objectName: name,
        sql: `COMMENT ON INDEX "${pgSchema}"."${name}" IS '${escapeQuote(idx.comment)}'`,
        destructive: false,
        concurrent: true,
      });
    }
  }

  // Drop indexes not in desired
  const desiredNames = new Set(desired.map((idx) => idx.name || defaultIndexName(table, idx)));
  for (const idx of existing) {
    if (idx.name && !desiredNames.has(idx.name)) {
      ops.push({
        type: 'drop_index',
        phase: 7,
        objectName: idx.name,
        sql: `DROP INDEX IF EXISTS "${pgSchema}"."${idx.name}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

function indexNeedsRecreate(desired: IndexDef, existing: IndexDef): boolean {
  if (!!desired.unique !== !!existing.unique) return true;
  if ((desired.method || 'btree') !== (existing.method || 'btree')) return true;
  if (indexKeysIdentity(desired) !== indexKeysIdentity(existing)) return true;
  const desiredWhere = normalizeIndexClause(desired.where);
  const existingWhere = normalizeIndexClause(existing.where);
  if (desiredWhere !== existingWhere) return true;
  const desiredInclude = (desired.include || []).slice().sort().join(',');
  const existingInclude = (existing.include || []).slice().sort().join(',');
  if (desiredInclude !== existingInclude) return true;
  return false;
}

export function normalizeIndexClause(clause: string | undefined): string {
  if (!clause) return '';
  return clause.replace(/\s+/g, ' ').trim().toLowerCase();
}

function createIndexOp(table: string, idx: IndexDef, pgSchema: string): Operation {
  const name = idx.name || defaultIndexName(table, idx);
  const method = idx.method || 'btree';
  const unique = idx.unique ? 'UNIQUE ' : '';
  const cols = idx.columns.map((c) => indexKeySql(c, idx.opclass)).join(', ');
  let sql = `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${pgSchema}"."${table}" USING ${method} (${cols})`;
  if (idx.include && idx.include.length > 0) {
    sql += ` INCLUDE (${idx.include.map((c) => `"${c}"`).join(', ')})`;
  }
  if (idx.where) {
    sql += ` WHERE ${idx.where}`;
  }
  return {
    type: 'add_index',
    phase: 7,
    objectName: name,
    sql,
    destructive: false,
    concurrent: true,
  };
}

// ─── Checks ────────────────────────────────────────────────────

function diffChecks(table: string, desired: CheckDef[], existing: CheckDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map(existing.map((c) => [c.name, c]));

  for (const check of desired) {
    const existingCheck = existingByName.get(check.name);
    if (!existingCheck) {
      ops.push({
        type: 'add_check',
        phase: 6,
        objectName: `${table}.${check.name}`,
        sql: wrapConstraintIdempotent(
          check.name,
          `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${check.name}" CHECK (${check.expression})`,
        ),
        destructive: false,
      });
    } else if (normalizeCheckExpression(existingCheck.expression) !== normalizeCheckExpression(check.expression)) {
      // Expression changed — PG doesn't support ALTER CONSTRAINT for checks, so drop + re-add
      ops.push({
        type: 'drop_check',
        phase: 6,
        objectName: `${table}.${check.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT IF EXISTS "${check.name}"`,
        destructive: false,
      });
      ops.push({
        type: 'add_check',
        phase: 6,
        objectName: `${table}.${check.name}`,
        sql: wrapConstraintIdempotent(
          check.name,
          `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${check.name}" CHECK (${check.expression})`,
        ),
        destructive: false,
      });
    }
    if (check.comment && (!existingCheck || check.comment !== existingCheck.comment)) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: `${table}.${check.name}`,
        sql: `COMMENT ON CONSTRAINT "${check.name}" ON "${pgSchema}"."${table}" IS '${escapeQuote(check.comment)}'`,
        destructive: false,
      });
    }
  }

  // Drop check constraints not in desired. `IF EXISTS` tolerates the case
  // where Postgres has already auto-cascaded the check because all columns
  // it referenced were dropped earlier in the same phase.
  const desiredNames = new Set(desired.map((c) => c.name));
  for (const [name] of existingByName) {
    if (!desiredNames.has(name)) {
      ops.push({
        type: 'drop_check',
        phase: 6,
        objectName: `${table}.${name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

// ─── Unique Constraints (safe 2-step pattern for existing tables) ──

function diffUniqueConstraints(
  table: string,
  desired: UniqueConstraintDef[],
  existing: UniqueConstraintDef[],
  desiredColumns: ColumnDef[],
  pgSchema: string,
  droppedColNames: Set<string> = new Set(),
): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map(existing.map((uc) => [uc.name || `uq_${table}_${uc.columns.join('_')}`, uc]));

  for (const uc of desired) {
    const ucName = uc.name || `uq_${table}_${uc.columns.join('_')}`;
    const existingUc = existingByName.get(ucName);
    const needsRecreate = existingUc && Boolean(uc.nulls_not_distinct) !== Boolean(existingUc.nulls_not_distinct);
    if (needsRecreate) {
      // Drop existing constraint so it can be recreated with updated nulls_not_distinct
      ops.push({
        type: 'drop_unique_constraint',
        phase: 6,
        objectName: `${table}.${ucName}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT IF EXISTS "${ucName}"`,
        destructive: true,
      });
    }
    if (!existingUc || needsRecreate) {
      // Safe unique constraint pattern (PRD §8.3):
      // 1. CREATE UNIQUE INDEX CONCURRENTLY (non-blocking)
      // 2. ALTER TABLE ADD CONSTRAINT ... USING INDEX (instant)
      const cols = uc.columns.map((c) => `"${c}"`).join(', ');
      const nnd = uc.nulls_not_distinct ? ' NULLS NOT DISTINCT' : '';
      ops.push({
        type: 'add_index',
        phase: 7,
        objectName: ucName,
        sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${ucName}" ON "${pgSchema}"."${table}" (${cols})${nnd}`,
        destructive: false,
        concurrent: true,
      });
      ops.push({
        type: 'add_unique_constraint',
        phase: 8,
        objectName: `${table}.${ucName}`,
        sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${ucName}') THEN ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${ucName}" UNIQUE USING INDEX "${ucName}"; END IF; END $$`,
        destructive: false,
        concurrent: true,
      });
    }
    if (uc.comment && (!existingUc || uc.comment !== existingUc.comment)) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: `${table}.${ucName}`,
        sql: `COMMENT ON CONSTRAINT "${ucName}" ON "${pgSchema}"."${table}" IS '${escapeQuote(uc.comment)}'`,
        destructive: false,
      });
    }
  }

  // Build set of column-level unique constraint names from desired columns.
  // These are managed at the column level, not via unique_constraints array,
  // so we must not drop them even if they appear in existing.unique_constraints.
  const columnLevelUniqueNames = new Set<string>();
  for (const col of desiredColumns) {
    if (col.unique) {
      columnLevelUniqueNames.add(col.unique_name || `${table}_${col.name}_key`);
    }
  }

  // Drop unique constraints not in desired (and not managed at column level).
  // Skip when the constraint references any column that's also being dropped —
  // Postgres auto-cascades table-level constraints whose columns go away
  // ("Indexes and table constraints involving the column will be automatically
  // dropped" — ALTER TABLE docs). Emitting a separate DROP CONSTRAINT in the
  // same phase would fail with "does not exist" after the drop_column runs.
  const desiredNames = new Set(desired.map((uc) => uc.name || `uq_${table}_${uc.columns.join('_')}`));
  for (const [name, uc] of existingByName) {
    if (desiredNames.has(name) || columnLevelUniqueNames.has(name)) continue;
    if (uc.columns.some((c) => droppedColNames.has(c))) continue;
    ops.push({
      type: 'drop_unique_constraint',
      phase: 6,
      objectName: `${table}.${name}`,
      sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
      destructive: true,
    });
  }

  return ops;
}

// ─── Triggers ──────────────────────────────────────────────────

function triggerNeedsRecreate(desired: TriggerDef, existing: TriggerDef): boolean {
  if (desired.timing !== existing.timing) return true;
  if ((desired.for_each || 'ROW') !== (existing.for_each || 'ROW')) return true;
  if ((desired.when || '') !== (existing.when || '')) return true;
  if (desired.function !== existing.function) return true;
  const dEvents = [...desired.events].sort().join(',');
  const eEvents = [...existing.events].sort().join(',');
  if (dEvents !== eEvents) return true;
  return false;
}

function diffTriggers(table: string, desired: TriggerDef[], existing: TriggerDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map(existing.map((t) => [t.name, t]));

  for (const trigger of desired) {
    const existingTrigger = existingByName.get(trigger.name);
    if (!existingTrigger) {
      ops.push(createTriggerOp(table, trigger, pgSchema));
      if (trigger.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table}.${trigger.name}`,
          sql: `COMMENT ON TRIGGER "${trigger.name}" ON "${pgSchema}"."${table}" IS '${escapeQuote(trigger.comment)}'`,
          destructive: false,
        });
      }
    } else if (triggerNeedsRecreate(trigger, existingTrigger)) {
      ops.push({
        type: 'drop_trigger',
        phase: 11,
        objectName: `${table}.${trigger.name}`,
        sql: `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${pgSchema}"."${table}"`,
        destructive: false,
      });
      ops.push(createTriggerOp(table, trigger, pgSchema));
      if (trigger.comment) {
        ops.push({
          type: 'set_comment',
          phase: 14,
          objectName: `${table}.${trigger.name}`,
          sql: `COMMENT ON TRIGGER "${trigger.name}" ON "${pgSchema}"."${table}" IS '${escapeQuote(trigger.comment)}'`,
          destructive: false,
        });
      }
    }
  }

  // Drop triggers not in desired
  const desiredNames = new Set(desired.map((t) => t.name));
  for (const trigger of existing) {
    if (!desiredNames.has(trigger.name)) {
      ops.push({
        type: 'drop_trigger',
        phase: 11,
        objectName: `${table}.${trigger.name}`,
        sql: `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${pgSchema}"."${table}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

function createTriggerOp(table: string, trigger: TriggerDef, pgSchema: string): Operation {
  const events = trigger.events.join(' OR ');
  const forEach = trigger.for_each || 'ROW';
  const fnRef = trigger.function.includes('.') ? trigger.function : `"${pgSchema}"."${trigger.function}"`;
  const drop = `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${pgSchema}"."${table}"`;
  let create = `CREATE TRIGGER "${trigger.name}" ${trigger.timing} ${events} ON "${pgSchema}"."${table}" FOR EACH ${forEach} EXECUTE FUNCTION ${fnRef}()`;
  if (trigger.when) {
    create = `CREATE TRIGGER "${trigger.name}" ${trigger.timing} ${events} ON "${pgSchema}"."${table}" FOR EACH ${forEach} WHEN (${trigger.when}) EXECUTE FUNCTION ${fnRef}()`;
  }
  const sql = `${drop};\n${create}`;
  return {
    type: 'create_trigger',
    phase: 11,
    objectName: `${table}.${trigger.name}`,
    sql,
    destructive: false,
  };
}

// ─── Policies ──────────────────────────────────────────────────

function diffRls(desired: TableSchema, existing: TableSchema, pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const table = desired.table;
  const wantRls = !!desired.rls || !!(desired.policies && desired.policies.length > 0);
  const haveRls = !!existing.rls || !!(existing.policies && existing.policies.length > 0);
  const wantForce = !!desired.force_rls;
  const haveForce = !!existing.force_rls;

  if (wantRls && !haveRls) {
    ops.push({
      type: 'enable_rls',
      phase: 12,
      objectName: table,
      sql: `ALTER TABLE "${pgSchema}"."${table}" ENABLE ROW LEVEL SECURITY`,
      destructive: false,
    });
  } else if (!wantRls && haveRls) {
    ops.push({
      type: 'disable_rls',
      phase: 12,
      objectName: table,
      sql: `ALTER TABLE "${pgSchema}"."${table}" DISABLE ROW LEVEL SECURITY`,
      destructive: true,
    });
  }

  if (wantForce && !haveForce) {
    ops.push({
      type: 'force_rls',
      phase: 12,
      objectName: table,
      sql: `ALTER TABLE "${pgSchema}"."${table}" FORCE ROW LEVEL SECURITY`,
      destructive: false,
    });
  } else if (!wantForce && haveForce) {
    ops.push({
      type: 'disable_force_rls',
      phase: 12,
      objectName: table,
      sql: `ALTER TABLE "${pgSchema}"."${table}" NO FORCE ROW LEVEL SECURITY`,
      destructive: true,
    });
  }

  return ops;
}

function diffPolicies(table: string, desired: PolicyDef[], existing: PolicyDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map(existing.map((p) => [p.name, p]));

  for (const policy of desired) {
    const existing_policy = existingByName.get(policy.name);
    if (!existing_policy) {
      ops.push(createPolicyOp(table, policy, pgSchema));
    } else if (policyChanged(policy, existing_policy)) {
      // Drop and recreate to update the policy
      ops.push({
        type: 'drop_policy',
        phase: 12,
        objectName: `${table}.${policy.name}`,
        sql: `DROP POLICY IF EXISTS "${policy.name}" ON "${pgSchema}"."${table}"`,
        destructive: false,
      });
      ops.push(createPolicyOp(table, policy, pgSchema));
    }
    if (policy.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: `${table}.${policy.name}`,
        sql: `COMMENT ON POLICY "${policy.name}" ON "${pgSchema}"."${table}" IS '${escapeQuote(policy.comment)}'`,
        destructive: false,
      });
    }
  }

  // Drop policies not in desired
  const desiredNames = new Set(desired.map((p) => p.name));
  for (const policy of existing) {
    if (!desiredNames.has(policy.name)) {
      ops.push({
        type: 'drop_policy',
        phase: 12,
        objectName: `${table}.${policy.name}`,
        sql: `DROP POLICY IF EXISTS "${policy.name}" ON "${pgSchema}"."${table}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

function policyChanged(desired: PolicyDef, existing: PolicyDef): boolean {
  const dPermissive = desired.permissive !== false;
  const ePermissive = existing.permissive !== false;
  if (dPermissive !== ePermissive) return true;
  if ((desired.for || 'ALL') !== (existing.for || 'ALL')) return true;
  if (normalizePolicyRoles(desired.to) !== normalizePolicyRoles(existing.to)) return true;
  if ((desired.using || '') !== (existing.using || '')) return true;
  if ((desired.check || '') !== (existing.check || '')) return true;
  return false;
}

// Normalize a policy `to` field for comparison. Postgres stores `PUBLIC` as
// the lowercase `public` role; YAML conventionally writes `PUBLIC`. Roles
// can also be a comma-separated list. Case-fold and trim so the desired and
// introspected forms compare equal.
function normalizePolicyRoles(to: string): string {
  return to
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .sort()
    .join(',');
}

function createPolicyOp(table: string, policy: PolicyDef, pgSchema: string): Operation {
  const cmd = policy.for || 'ALL';
  const permissive = policy.permissive !== false ? 'PERMISSIVE' : 'RESTRICTIVE';
  const toClause = policy.to.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : `"${policy.to}"`;
  let sql = `DROP POLICY IF EXISTS "${policy.name}" ON "${pgSchema}"."${table}"; CREATE POLICY "${policy.name}" ON "${pgSchema}"."${table}" AS ${permissive} FOR ${cmd} TO ${toClause}`;
  if (policy.using) sql += ` USING (${policy.using})`;
  if (policy.check) sql += ` WITH CHECK (${policy.check})`;
  return {
    type: 'create_policy',
    phase: 12,
    objectName: `${table}.${policy.name}`,
    sql,
    destructive: false,
  };
}

// ─── Grants ────────────────────────────────────────────────────

// Postgres splits grant storage by privilege kind: privileges that can be
// column-qualified (SELECT, INSERT, UPDATE, REFERENCES) land in
// information_schema.column_privileges when the grant names columns; the
// rest (DELETE, TRUNCATE, TRIGGER) live only in table_privileges. A single
// YAML block mixing both kinds is perfectly expressible, but when we diff
// YAML ↔ DB we have to compare against the split shape Postgres actually
// stores, or we mistake one mixed block for two mismatched grants.
const COLUMN_GRANTABLE_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']);

/**
 * Split any grant that mixes column-qualified privileges with table-only
 * privileges into the two shapes Postgres stores internally. Idempotent for
 * grants that are already purely one or the other. Used on both sides of
 * the grant diff (planner + drift) so the two sides always compare apples
 * to apples.
 */
export function normalizeGrants(grants: GrantDef[]): GrantDef[] {
  const normalized: GrantDef[] = [];
  for (const g of grants) {
    if (!g.columns || g.columns.length === 0) {
      normalized.push(g);
      continue;
    }
    const colPrivs = g.privileges.filter((p) => COLUMN_GRANTABLE_PRIVILEGES.has(p.toUpperCase()));
    const tablePrivs = g.privileges.filter((p) => !COLUMN_GRANTABLE_PRIVILEGES.has(p.toUpperCase()));
    if (colPrivs.length > 0) {
      const part: GrantDef = { to: g.to, privileges: colPrivs, columns: g.columns };
      if (g.with_grant_option) part.with_grant_option = true;
      normalized.push(part);
    }
    if (tablePrivs.length > 0) {
      const part: GrantDef = { to: g.to, privileges: tablePrivs };
      if (g.with_grant_option) part.with_grant_option = true;
      normalized.push(part);
    }
  }

  // A column-qualified grant whose (grantee, privilege, with_grant_option) is
  // already covered by a table-level grant in the same set is a no-op in
  // Postgres — the table grant subsumes it, and the DB never stores the
  // column-level entry separately. Dropping the subsumed entries here keeps
  // both sides of the diff in the same canonical form so a no-change YAML
  // produces zero plan ops. (Issue #29.)
  const tableLevelByGrantee = new Map<string, Set<string>>();
  for (const g of normalized) {
    if (g.columns && g.columns.length > 0) continue;
    const key = `${g.to}::${!!g.with_grant_option}`;
    let set = tableLevelByGrantee.get(key);
    if (!set) {
      set = new Set();
      tableLevelByGrantee.set(key, set);
    }
    for (const p of g.privileges) set.add(p.toUpperCase());
  }

  const deduped: GrantDef[] = [];
  for (const g of normalized) {
    if (!g.columns || g.columns.length === 0) {
      deduped.push(g);
      continue;
    }
    const covered = tableLevelByGrantee.get(`${g.to}::${!!g.with_grant_option}`);
    if (!covered) {
      deduped.push(g);
      continue;
    }
    const remaining = g.privileges.filter((p) => !covered.has(p.toUpperCase()));
    if (remaining.length === 0) continue;
    const part: GrantDef = { to: g.to, privileges: remaining, columns: g.columns };
    if (g.with_grant_option) part.with_grant_option = true;
    deduped.push(part);
  }
  return deduped;
}

/**
 * Stable key for a grant identity (grantee + optional columns). Privileges
 * are compared separately so we can emit partial revokes/grants when they
 * differ.
 */
function grantIdentityKey(g: GrantDef): string {
  const cols = g.columns && g.columns.length > 0 ? [...g.columns].sort().join(',') : '';
  return `${g.to}::${cols}`;
}

/**
 * Compute the minimum set of GRANT / REVOKE ops to reconcile `existing`
 * (introspected from the DB) with `desired` (from YAML). Normalizes both
 * sides first so a single YAML block mixing column-qualified and table-only
 * privileges compares correctly against the split shape Postgres stores.
 *
 * Issues a REVOKE for privileges present in the DB but not desired, a GRANT
 * for privileges desired but absent, and no op when both sides agree.
 * `with_grant_option` changes force a re-grant (REVOKE … GRANT OPTION FOR
 * then GRANT … WITH GRANT OPTION) — Postgres has no single ALTER for this.
 */
function diffGrants(table: string, desired: GrantDef[], existing: GrantDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const normDesired = normalizeGrants(desired);
  const normExisting = normalizeGrants(existing);

  const desiredByKey = new Map<string, GrantDef[]>();
  for (const g of normDesired) {
    const k = grantIdentityKey(g);
    const arr = desiredByKey.get(k);
    if (arr) arr.push(g);
    else desiredByKey.set(k, [g]);
  }
  const existingByKey = new Map<string, GrantDef[]>();
  for (const g of normExisting) {
    const k = grantIdentityKey(g);
    const arr = existingByKey.get(k);
    if (arr) arr.push(g);
    else existingByKey.set(k, [g]);
  }

  const allKeys = new Set<string>([...desiredByKey.keys(), ...existingByKey.keys()]);
  for (const key of allKeys) {
    const desiredAgg = aggregateByGrantOption(desiredByKey.get(key) ?? []);
    const existingAgg = aggregateByGrantOption(existingByKey.get(key) ?? []);

    for (const [wgo, desiredPrivs] of desiredAgg.entries()) {
      const existingPrivs = existingAgg.get(wgo) ?? new Set<string>();
      const toGrant = [...desiredPrivs].filter((p) => !existingPrivs.has(p)).sort();
      if (toGrant.length === 0) continue;
      const sample = (desiredByKey.get(key) ?? []).find((g) => !!g.with_grant_option === wgo);
      if (!sample) continue;
      ops.push(
        createGrantOp(
          table,
          { to: sample.to, privileges: toGrant, columns: sample.columns, with_grant_option: wgo },
          pgSchema,
        ),
      );
    }
    for (const [wgo, existingPrivs] of existingAgg.entries()) {
      const desiredPrivs = desiredAgg.get(wgo) ?? new Set<string>();
      const toRevoke = [...existingPrivs].filter((p) => !desiredPrivs.has(p)).sort();
      if (toRevoke.length === 0) continue;
      const sample = (existingByKey.get(key) ?? []).find((g) => !!g.with_grant_option === wgo);
      if (!sample) continue;
      ops.push(createRevokeOp(table, { ...sample, privileges: toRevoke }, pgSchema));
    }
  }
  return ops;
}

function aggregateByGrantOption(grants: GrantDef[]): Map<boolean, Set<string>> {
  const out = new Map<boolean, Set<string>>();
  for (const g of grants) {
    const wgo = !!g.with_grant_option;
    let set = out.get(wgo);
    if (!set) {
      set = new Set();
      out.set(wgo, set);
    }
    for (const p of g.privileges) set.add(p.toUpperCase());
  }
  return out;
}

function createGrantOp(table: string, grant: GrantDef, pgSchema: string): Operation {
  const privileges = grant.privileges.join(', ');
  const isColumnGrant = grant.columns && grant.columns.length > 0;
  let target: string;
  if (isColumnGrant) {
    const cols = grant.columns!.map((c) => `"${c}"`).join(', ');
    target = `${privileges} (${cols}) ON "${pgSchema}"."${table}"`;
  } else {
    target = `${privileges} ON "${pgSchema}"."${table}"`;
  }
  let sql = `GRANT ${target} TO "${grant.to}"`;
  if (grant.with_grant_option) sql += ' WITH GRANT OPTION';
  return {
    type: isColumnGrant ? 'grant_column' : 'grant_table',
    phase: 13,
    objectName: `${table}.${grant.to}`,
    sql,
    destructive: false,
  };
}

function createRevokeOp(table: string, grant: GrantDef, pgSchema: string): Operation {
  const privileges = grant.privileges.join(', ');
  const isColumnGrant = grant.columns && grant.columns.length > 0;
  let target: string;
  if (isColumnGrant) {
    const cols = grant.columns!.map((c) => `"${c}"`).join(', ');
    target = `${privileges} (${cols}) ON "${pgSchema}"."${table}"`;
  } else {
    target = `${privileges} ON "${pgSchema}"."${table}"`;
  }
  return {
    type: isColumnGrant ? 'revoke_column' : 'revoke_table',
    phase: 13,
    objectName: `${table}.${grant.to}`,
    sql: `REVOKE ${target} FROM "${grant.to}"`,
    destructive: true,
  };
}

// ─── Sequence Grants (auto-generated for serial/bigserial columns) ──

const SERIAL_TYPES = new Set(['serial', 'bigserial', 'smallserial']);
const SEQUENCE_NEEDING_PRIVILEGES = new Set(['INSERT', 'UPDATE', 'ALL', 'ALL PRIVILEGES']);

function createSequenceGrantOps(
  table: string,
  columns: ColumnDef[],
  grants: GrantDef[],
  pgSchema: string,
): Operation[] {
  const ops: Operation[] = [];
  const serialCols = columns.filter((c) => SERIAL_TYPES.has(c.type.toLowerCase()));
  if (serialCols.length === 0) return ops;

  for (const grant of grants) {
    // Only generate sequence grants for roles that need write access
    const needsSequence = grant.privileges.some((p) => SEQUENCE_NEEDING_PRIVILEGES.has(p.toUpperCase()));
    if (!needsSequence) continue;

    for (const col of serialCols) {
      const seqName = `${table}_${col.name}_seq`;
      ops.push({
        type: 'grant_sequence',
        phase: 13,
        objectName: `${seqName}.${grant.to}`,
        sql: `GRANT USAGE, SELECT ON SEQUENCE "${pgSchema}"."${seqName}" TO "${grant.to}"`,
        destructive: false,
      });
    }
  }

  return ops;
}

// ─── Views ─────────────────────────────────────────────────────

function formatViewOptions(options: Record<string, string | boolean> | undefined): string {
  if (!options || Object.keys(options).length === 0) return '';
  const entries = Object.entries(options).map(([k, v]) => `${k} = ${v}`);
  return ` WITH (${entries.join(', ')})`;
}

function diffViews(desired: ViewSchema[], actual: Map<string, ViewSchema>, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const view of desired) {
    ops.push({
      type: 'create_view',
      phase: 9,
      objectName: view.name,
      sql: `CREATE OR REPLACE VIEW "${pgSchema}"."${view.name}"${formatViewOptions(view.options)} AS ${view.query}`,
      destructive: false,
    });

    // Diff triggers on the view (INSTEAD OF triggers)
    const existingView = actual.get(view.name);
    const desiredTriggers = view.triggers || [];
    const existingTriggers = existingView?.triggers || [];
    if (desiredTriggers.length > 0 || existingTriggers.length > 0) {
      ops.push(...diffTriggers(view.name, desiredTriggers, existingTriggers, pgSchema));
    }

    if (view.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: view.name,
        sql: `COMMENT ON VIEW "${pgSchema}"."${view.name}" IS '${escapeQuote(view.comment)}'`,
        destructive: false,
      });
    }

    if (view.grants) {
      for (const grant of view.grants) {
        const privileges = grant.privileges.join(', ');
        ops.push({
          type: 'grant_table',
          phase: 13,
          objectName: `${view.name}.${grant.to}`,
          sql: `GRANT ${privileges} ON "${pgSchema}"."${view.name}" TO "${grant.to}"`,
          destructive: false,
        });
      }
    }
  }

  // Drop views not in desired
  const desiredNames = new Set(desired.map((v) => v.name));
  for (const [name, existingView] of actual) {
    if (!desiredNames.has(name)) {
      // Drop triggers on the view before dropping the view itself
      const existingTriggers = existingView.triggers || [];
      if (existingTriggers.length > 0) {
        ops.push(...diffTriggers(name, [], existingTriggers, pgSchema));
      }
      ops.push({
        type: 'drop_view',
        phase: 9,
        objectName: name,
        sql: `DROP VIEW IF EXISTS "${pgSchema}"."${name}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

// ─── Materialized Views ────────────────────────────────────────

function diffMaterializedViews(
  desired: MaterializedViewSchema[],
  actual: Map<string, MaterializedViewSchema>,
  pgSchema: string,
): Operation[] {
  const ops: Operation[] = [];

  for (const mv of desired) {
    const existing = actual.get(mv.name);
    if (!existing) {
      ops.push({
        type: 'create_materialized_view',
        phase: 10,
        objectName: mv.name,
        sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS "${pgSchema}"."${mv.name}" AS ${mv.query}`,
        destructive: false,
      });
    } else {
      // If query changed, need to drop and recreate
      if (normalizeWhitespace(existing.query) !== normalizeWhitespace(mv.query)) {
        ops.push({
          type: 'drop_materialized_view',
          phase: 10,
          objectName: mv.name,
          sql: `DROP MATERIALIZED VIEW IF EXISTS "${pgSchema}"."${mv.name}"`,
          destructive: true,
        });
        ops.push({
          type: 'create_materialized_view',
          phase: 10,
          objectName: mv.name,
          sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS "${pgSchema}"."${mv.name}" AS ${mv.query}`,
          destructive: false,
        });
        ops.push({
          type: 'refresh_materialized_view',
          phase: 10,
          objectName: mv.name,
          sql: `REFRESH MATERIALIZED VIEW "${pgSchema}"."${mv.name}"`,
          destructive: false,
        });
      }
    }

    if (mv.indexes) {
      for (const idx of mv.indexes) {
        ops.push(createIndexOp(mv.name, idx, pgSchema));
      }
    }

    if (mv.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: mv.name,
        sql: `COMMENT ON MATERIALIZED VIEW "${pgSchema}"."${mv.name}" IS '${escapeQuote(mv.comment)}'`,
        destructive: false,
      });
    }

    if (mv.grants) {
      for (const grant of mv.grants) {
        const privileges = grant.privileges.join(', ');
        ops.push({
          type: 'grant_table',
          phase: 13,
          objectName: `${mv.name}.${grant.to}`,
          sql: `GRANT ${privileges} ON "${pgSchema}"."${mv.name}" TO "${grant.to}"`,
          destructive: false,
        });
      }
    }
  }

  // Drop mat views not in desired
  const desiredNames = new Set(desired.map((v) => v.name));
  for (const [name] of actual) {
    if (!desiredNames.has(name)) {
      ops.push({
        type: 'drop_materialized_view',
        phase: 10,
        objectName: name,
        sql: `DROP MATERIALIZED VIEW IF EXISTS "${pgSchema}"."${name}"`,
        destructive: true,
      });
    }
  }

  return ops;
}

// ─── Seeds ─────────────────────────────────────────────────────

function createSeedTableOp(
  table: string,
  seeds: Record<string, unknown>[],
  columns: ColumnDef[],
  pgSchema: string,
  onConflict?: SeedOnConflict,
): Operation {
  // Collect all column names used across seed rows
  const seedKeySet = new Set<string>();
  for (const seed of seeds) {
    for (const key of Object.keys(seed)) seedKeySet.add(key);
  }

  const seedColumns = [...seedKeySet].map((name) => {
    const colDef = columns.find((c) => c.name === name);
    return {
      name,
      type: normalizeTypeName(colDef?.type || 'text'),
      isPk: colDef?.primary_key === true,
    };
  });

  // If no explicit PK columns found among seed keys, default to 'id'
  const hasPk = seedColumns.some((c) => c.isPk);
  if (!hasPk) {
    const idCol = seedColumns.find((c) => c.name === 'id');
    if (idCol) idCol.isPk = true;
  }

  return {
    type: 'seed_table',
    phase: 15,
    objectName: table,
    sql: `-- Seed "${pgSchema}"."${table}" (${seeds.length} rows)`,
    destructive: false,
    seedRows: seeds,
    seedColumns,
    seedOnConflict: onConflict,
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function escapeQuote(s: string): string {
  return s.replace(/'/g, "''");
}

function normalizeTypeName(t: string): string {
  const lower = t.toLowerCase().trim();
  const aliases: Record<string, string> = {
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    serial: 'integer',
    bigserial: 'bigint',
  };
  return aliases[lower] || lower;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeCheckExpression(s: string): string {
  return s.replace(/::character varying::text/g, '::character varying').replace(/\]::text\[\]/g, ']');
}
