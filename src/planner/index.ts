/**
 * Planner / diff engine for simplicity-schema.
 *
 * Compares desired (YAML) state vs actual (introspected) state and
 * produces an ordered list of operations to converge the database.
 */

import type {
  TableSchema,
  ColumnDef,
  IndexDef,
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
  | 'add_seed';

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
      // Create new enum
      const values = desiredEnum.values.map((v) => `'${v}'`).join(', ');
      ops.push({
        type: 'create_enum',
        phase: 3,
        objectName: desiredEnum.name,
        sql: `CREATE TYPE "${desiredEnum.name}" AS ENUM (${values})`,
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
      ops.push({
        type: 'create_role',
        phase: 4,
        objectName: desiredRole.role,
        sql: `CREATE ROLE "${desiredRole.role}"${attrs ? ' ' + attrs : ''}`,
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

function diffFunctions(desired: FunctionSchema[], actual: Map<string, FunctionSchema>, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const fn of desired) {
    // CREATE OR REPLACE — always emit for desired functions
    const args = fn.args ? fn.args.map((a) => `${a.name} ${a.type}`).join(', ') : '';
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

    if (fn.comment) {
      ops.push({
        type: 'set_comment',
        phase: 14,
        objectName: fn.name,
        sql: `COMMENT ON FUNCTION "${pgSchema}"."${fn.name}"(${args}) IS '${escapeQuote(fn.comment)}'`,
        destructive: false,
      });
    }

    // Function grants (phase 13)
    if (fn.grants) {
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
    if (col.unique) def += ' UNIQUE';
    if (col.generated) def += ` GENERATED ALWAYS AS (${col.generated}) STORED`;
    colDefs.push(def);

    if (col.references) fkColumns.push(col);
  }

  // Composite primary key
  if (table.primary_key && table.primary_key.length > 0) {
    const pkCols = table.primary_key.map((c) => `"${c}"`).join(', ');
    colDefs.push(`PRIMARY KEY (${pkCols})`);
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
      colDefs.push(`CONSTRAINT "${ucName}" UNIQUE (${ucCols})`);
    }
  }

  ops.push({
    type: 'create_table',
    phase: 6,
    objectName: table.table,
    sql: `CREATE TABLE "${pgSchema}"."${table.table}" (\n  ${colDefs.join(',\n  ')}\n)`,
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
    }
  }

  // Foreign keys (phase 8) — added as NOT VALID
  for (const col of fkColumns) {
    const ref = col.references!;
    const constraintName = `fk_${table.table}_${col.name}_${ref.table}`;
    const onDelete = ref.on_delete || 'NO ACTION';
    const onUpdate = ref.on_update || 'NO ACTION';
    let fkSql = `ALTER TABLE "${pgSchema}"."${table.table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${col.name}") REFERENCES "${pgSchema}"."${ref.table}" ("${ref.column}") ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
    if (ref.deferrable) {
      fkSql += ref.initially_deferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE INITIALLY IMMEDIATE';
    }
    fkSql += ' NOT VALID';
    ops.push({
      type: 'add_foreign_key_not_valid',
      phase: 8,
      objectName: `${table.table}.${col.name}`,
      sql: fkSql,
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

  // Seeds (phase 15)
  if (table.seeds) {
    for (const seed of table.seeds) {
      ops.push(createSeedOp(table.table, seed, table.columns, pgSchema));
    }
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
        const constraintName = `fk_${desired.table}_${col.name}_${ref.table}`;
        const onDelete = ref.on_delete || 'NO ACTION';
        const onUpdate = ref.on_update || 'NO ACTION';
        let fkSql = `ALTER TABLE "${pgSchema}"."${desired.table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${col.name}") REFERENCES "${pgSchema}"."${ref.table}" ("${ref.column}") ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
        if (ref.deferrable) {
          fkSql += ref.initially_deferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE INITIALLY IMMEDIATE';
        }
        fkSql += ' NOT VALID';
        ops.push({
          type: 'add_foreign_key_not_valid',
          phase: 8,
          objectName: `${desired.table}.${col.name}`,
          sql: fkSql,
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

  // Drop columns not in desired
  for (const col of existing.columns) {
    if (!desiredColMap.has(col.name)) {
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
      pgSchema,
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

  // Diff grants
  if (desired.grants) {
    for (const grant of desired.grants) {
      ops.push(createGrantOp(desired.table, grant, pgSchema));
    }
    // Auto-generate sequence grants for serial/bigserial columns
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
  if (desired.seeds) {
    for (const seed of desired.seeds) {
      ops.push(createSeedOp(desired.table, seed, desired.columns, pgSchema));
    }
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

  // Nullable change
  const desiredNullable = desired.nullable !== false;
  const existingNullable = existing.nullable !== false;
  if (desiredNullable !== existingNullable) {
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
        sql: `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${checkName}" CHECK ("${desired.name}" IS NOT NULL) NOT VALID`,
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
    ops.push({
      type: 'alter_column',
      phase: 6,
      objectName: `${table}.${desired.name}`,
      sql: `ALTER TABLE "${pgSchema}"."${table}" ALTER COLUMN "${desired.name}" DROP DEFAULT`,
      destructive: false,
    });
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

function diffIndexes(table: string, desired: IndexDef[], existing: IndexDef[], pgSchema: string): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map<string, IndexDef>();
  for (const idx of existing) {
    if (idx.name) existingByName.set(idx.name, idx);
  }

  for (const idx of desired) {
    const name = idx.name || `idx_${table}_${idx.columns.join('_')}`;
    if (!existingByName.has(name)) {
      ops.push(createIndexOp(table, { ...idx, name }, pgSchema));
    }
  }

  // Drop indexes not in desired
  const desiredNames = new Set(desired.map((idx) => idx.name || `idx_${table}_${idx.columns.join('_')}`));
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

function createIndexOp(table: string, idx: IndexDef, pgSchema: string): Operation {
  const name = idx.name || `idx_${table}_${idx.columns.join('_')}`;
  const method = idx.method || 'btree';
  const unique = idx.unique ? 'UNIQUE ' : '';
  const cols = idx.columns.map((c) => (idx.opclass ? `"${c}" ${idx.opclass}` : `"${c}"`)).join(', ');
  let sql = `CREATE ${unique}INDEX CONCURRENTLY "${name}" ON "${pgSchema}"."${table}" USING ${method} (${cols})`;
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
    if (!existingByName.has(check.name)) {
      ops.push({
        type: 'add_check',
        phase: 6,
        objectName: `${table}.${check.name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${check.name}" CHECK (${check.expression})`,
        destructive: false,
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
  pgSchema: string,
): Operation[] {
  const ops: Operation[] = [];
  const existingByName = new Map(existing.map((uc) => [uc.name || `uq_${table}_${uc.columns.join('_')}`, uc]));

  for (const uc of desired) {
    const ucName = uc.name || `uq_${table}_${uc.columns.join('_')}`;
    if (!existingByName.has(ucName)) {
      // Safe unique constraint pattern (PRD §8.3):
      // 1. CREATE UNIQUE INDEX CONCURRENTLY (non-blocking)
      // 2. ALTER TABLE ADD CONSTRAINT ... USING INDEX (instant)
      const cols = uc.columns.map((c) => `"${c}"`).join(', ');
      ops.push({
        type: 'add_index',
        phase: 7,
        objectName: ucName,
        sql: `CREATE UNIQUE INDEX CONCURRENTLY "${ucName}" ON "${pgSchema}"."${table}" (${cols})`,
        destructive: false,
        concurrent: true,
      });
      ops.push({
        type: 'add_unique_constraint',
        phase: 8,
        objectName: `${table}.${ucName}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" ADD CONSTRAINT "${ucName}" UNIQUE USING INDEX "${ucName}"`,
        destructive: false,
        concurrent: true,
      });
    }
  }

  // Drop unique constraints not in desired
  const desiredNames = new Set(desired.map((uc) => uc.name || `uq_${table}_${uc.columns.join('_')}`));
  for (const [name] of existingByName) {
    if (!desiredNames.has(name)) {
      ops.push({
        type: 'drop_unique_constraint',
        phase: 6,
        objectName: `${table}.${name}`,
        sql: `ALTER TABLE "${pgSchema}"."${table}" DROP CONSTRAINT "${name}"`,
        destructive: true,
      });
    }
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
    } else if (triggerNeedsRecreate(trigger, existingTrigger)) {
      ops.push({
        type: 'drop_trigger',
        phase: 11,
        objectName: `${table}.${trigger.name}`,
        sql: `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${pgSchema}"."${table}"`,
        destructive: false,
      });
      ops.push(createTriggerOp(table, trigger, pgSchema));
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
  let sql = `CREATE TRIGGER "${trigger.name}" ${trigger.timing} ${events} ON "${pgSchema}"."${table}" FOR EACH ${forEach} EXECUTE FUNCTION ${trigger.function}()`;
  if (trigger.when) {
    sql = `CREATE TRIGGER "${trigger.name}" ${trigger.timing} ${events} ON "${pgSchema}"."${table}" FOR EACH ${forEach} WHEN (${trigger.when}) EXECUTE FUNCTION ${trigger.function}()`;
  }
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
  if (desired.to !== existing.to) return true;
  if ((desired.using || '') !== (existing.using || '')) return true;
  if ((desired.check || '') !== (existing.check || '')) return true;
  return false;
}

function createPolicyOp(table: string, policy: PolicyDef, pgSchema: string): Operation {
  const cmd = policy.for || 'ALL';
  const permissive = policy.permissive !== false ? 'PERMISSIVE' : 'RESTRICTIVE';
  let sql = `CREATE POLICY "${policy.name}" ON "${pgSchema}"."${table}" AS ${permissive} FOR ${cmd} TO "${policy.to}"`;
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

function diffViews(desired: ViewSchema[], actual: Map<string, ViewSchema>, pgSchema: string): Operation[] {
  const ops: Operation[] = [];

  for (const view of desired) {
    ops.push({
      type: 'create_view',
      phase: 9,
      objectName: view.name,
      sql: `CREATE OR REPLACE VIEW "${pgSchema}"."${view.name}" AS ${view.query}`,
      destructive: false,
    });

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
  for (const [name] of actual) {
    if (!desiredNames.has(name)) {
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
        sql: `CREATE MATERIALIZED VIEW "${pgSchema}"."${mv.name}" AS ${mv.query}`,
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
          sql: `CREATE MATERIALIZED VIEW "${pgSchema}"."${mv.name}" AS ${mv.query}`,
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

function createSeedOp(table: string, seed: Record<string, unknown>, columns: ColumnDef[], pgSchema: string): Operation {
  const keys = Object.keys(seed);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const vals = keys.map((k) => formatSeedValue(seed[k])).join(', ');
  // Find primary key columns for ON CONFLICT
  const pkCols = columns.filter((c) => c.primary_key).map((c) => `"${c.name}"`);
  const pkClause = pkCols.length > 0 ? `(${pkCols.join(', ')})` : '(id)';
  const updateCols = keys
    .filter((k) => !columns.find((c) => c.name === k && c.primary_key))
    .map((k) => `"${k}" = EXCLUDED."${k}"`)
    .join(', ');

  let sql = `INSERT INTO "${pgSchema}"."${table}" (${cols}) VALUES (${vals})`;
  if (updateCols) {
    sql += ` ON CONFLICT ${pkClause} DO UPDATE SET ${updateCols}`;
  } else {
    sql += ` ON CONFLICT ${pkClause} DO NOTHING`;
  }

  return {
    type: 'add_seed',
    phase: 15,
    objectName: table,
    sql,
    destructive: false,
  };
}

function formatSeedValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  return `'${escapeQuote(String(val))}'`;
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
