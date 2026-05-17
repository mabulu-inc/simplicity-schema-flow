// Schema type definitions for schema-flow YAML files

// ─── Foreign Key ────────────────────────────────────────────────

export type ForeignKeyAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';

export interface ForeignKeyRef {
  table: string;
  column: string;
  name?: string;
  schema?: string;
  on_delete?: ForeignKeyAction;
  on_update?: ForeignKeyAction;
  deferrable?: boolean;
  initially_deferred?: boolean;
}

// ─── Expand (zero-downtime column migration) ────────────────────

export interface ExpandDef {
  from: string;
  transform: string;
  reverse?: string;
  batch_size?: number;
}

// ─── Column ─────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  primary_key?: boolean;
  unique?: boolean;
  unique_name?: string;
  default?: string;
  check?: string;
  comment?: string;
  references?: ForeignKeyRef;
  generated?: string;
  expand?: ExpandDef;
}

// ─── Index ──────────────────────────────────────────────────────

export type IndexMethod = 'btree' | 'gin' | 'gist' | 'hash' | 'brin';

/**
 * An index "key" — either a plain column name (`"email"`) or an expression
 * (`{ expression: "LOWER(email)" }`, `{ expression: "COALESCE(x, '…')" }`).
 * Expression keys let schema-flow manage the full set of Postgres indexes
 * declaratively, including functional and coalescing ones that would
 * otherwise live outside the YAML contract.
 */
/**
 * Per-key ordering metadata for an index column. `order` defaults to `ASC`;
 * `nulls` defaults to `LAST` for `ASC` and `FIRST` for `DESC` (matching
 * Postgres). Both are optional — a bare `string` `IndexKey` (or `IndexColumn`
 * with neither field set) means "all defaults".
 */
export type IndexOrder = 'ASC' | 'DESC';
export type IndexNulls = 'FIRST' | 'LAST';

export interface IndexColumn {
  column: string;
  order?: IndexOrder;
  nulls?: IndexNulls;
}

export type IndexKey = string | { expression: string } | IndexColumn;

export type DeferrableMode = 'initially_immediate' | 'initially_deferred';

export interface IndexDef {
  name?: string;
  /**
   * Ordered list of index keys. Each entry is either a column name (string)
   * or an object with an `expression` field containing a SQL expression.
   * Partial indexes use the top-level `where` clause, not per-key.
   */
  columns: IndexKey[];
  unique?: boolean;
  method?: IndexMethod;
  where?: string;
  include?: string[];
  opclass?: string;
  /**
   * Only meaningful when `unique: true`. When set, the unique index treats
   * NULL values as equal for the purpose of uniqueness enforcement, so a
   * second row with the same NULLs in the indexed columns conflicts.
   * Postgres ≥15.
   */
  nulls_not_distinct?: boolean;
  /**
   * When true, the unique index is also wrapped in a `pg_constraint` row
   * (i.e. emitted as a `UNIQUE` constraint backed by this index). Required
   * for `deferrable:` and for canonical FK target naming. Requires
   * `unique: true`, btree, no partial `where:`, no expression keys, and no
   * non-default column ordering — these are PG's restrictions on
   * `ALTER TABLE ADD CONSTRAINT ... USING INDEX`.
   */
  as_constraint?: boolean;
  /**
   * Defer the constraint check from per-statement to commit-time. Requires
   * `as_constraint: true` (bare unique indexes cannot be deferred). Values:
   *  - `initially_immediate`: deferrable but checked immediately by default;
   *    transactions can opt in with `SET CONSTRAINTS … DEFERRED`.
   *  - `initially_deferred`: checked at COMMIT by default; transactions can
   *    re-enable immediate checking with `SET CONSTRAINTS … IMMEDIATE`.
   */
  deferrable?: DeferrableMode;
  comment?: string;
}

// ─── Check Constraint ───────────────────────────────────────────

export interface CheckDef {
  name: string;
  expression: string;
  comment?: string;
}

// ─── Exclusion Constraint ───────────────────────────────────────

export interface ExclusionConstraintElement {
  /** Indexed column name. (Future widening: an `expression` field for
   *  expression-based EXCLUDE keys.) */
  column: string;
  /** Operator token used between the value and the row's existing
   *  values. Common cases: `=` for equality, `&&` for range/geometry
   *  overlap. Pass-through; no escaping. */
  operator: string;
}

export interface ExclusionConstraintDef {
  name?: string;
  /** Index method. Defaults to `gist`. Multi-element non-spatial cases
   *  typically need `btree_gist` listed in `extensions.yaml`. */
  using?: string;
  elements: ExclusionConstraintElement[];
  /** Optional partial-constraint predicate (e.g. `geofence IS NOT NULL`). */
  where?: string;
  comment?: string;
}

// ─── Trigger ────────────────────────────────────────────────────

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
export type TriggerForEach = 'ROW' | 'STATEMENT';

export interface TriggerDef {
  name: string;
  timing: TriggerTiming;
  events: TriggerEvent[];
  function: string;
  for_each?: TriggerForEach;
  when?: string;
  comment?: string;
}

// ─── RLS Policy ─────────────────────────────────────────────────

export type PolicyCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';

export interface PolicyDef {
  name: string;
  for?: PolicyCommand;
  to: string;
  using?: string;
  check?: string;
  permissive?: boolean;
  comment?: string;
}

// ─── Grants ─────────────────────────────────────────────────────

export interface GrantDef {
  to: string;
  privileges: string[];
  columns?: string[];
  with_grant_option?: boolean;
}

export interface FunctionGrantDef {
  to: string;
  privileges: string[];
}

// ─── Precheck ───────────────────────────────────────────────────

export interface PrecheckDef {
  name: string;
  query: string;
  message: string;
}

// ─── Seed ───────────────────────────────────────────────────────

export interface SqlExpression {
  __sql: string;
}

export type SeedRow = Record<string, unknown>;

export type SeedOnConflict = 'DO NOTHING';

// ─── Table ──────────────────────────────────────────────────────

export interface TableSchema {
  table: string;
  columns: ColumnDef[];
  primary_key?: string[];
  primary_key_name?: string;
  indexes?: IndexDef[];
  checks?: CheckDef[];
  exclusion_constraints?: ExclusionConstraintDef[];
  triggers?: TriggerDef[];
  rls?: boolean;
  force_rls?: boolean;
  policies?: PolicyDef[];
  grants?: GrantDef[];
  prechecks?: PrecheckDef[];
  seeds?: SeedRow[];
  seeds_on_conflict?: SeedOnConflict;
  mixins?: string[];
  comment?: string;
}

// ─── Enum ───────────────────────────────────────────────────────

export interface EnumSchema {
  name: string;
  values: string[];
  comment?: string;
}

// ─── Function ───────────────────────────────────────────────────

export type FunctionSecurity = 'invoker' | 'definer';
export type FunctionVolatility = 'volatile' | 'stable' | 'immutable';
export type FunctionParallel = 'unsafe' | 'safe' | 'restricted';
export type FunctionArgMode = 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';

export interface FunctionArg {
  name: string;
  type: string;
  mode?: FunctionArgMode;
  default?: string;
}

export interface FunctionSchema {
  name: string;
  language: string;
  returns: string;
  args?: FunctionArg[];
  body: string;
  security?: FunctionSecurity;
  volatility?: FunctionVolatility;
  parallel?: FunctionParallel;
  strict?: boolean;
  leakproof?: boolean;
  cost?: number;
  rows?: number;
  set?: Record<string, string>;
  grants?: FunctionGrantDef[];
  comment?: string;
}

// ─── View ───────────────────────────────────────────────────────

export interface ViewSchema {
  name: string;
  materialized?: false;
  query: string;
  options?: Record<string, string | boolean>;
  triggers?: TriggerDef[];
  grants?: GrantDef[];
  comment?: string;
}

// ─── Materialized View ──────────────────────────────────────────

export interface MaterializedViewSchema {
  name: string;
  materialized: true;
  query: string;
  indexes?: IndexDef[];
  grants?: GrantDef[];
  comment?: string;
}

// ─── Role ───────────────────────────────────────────────────────

export interface RoleSchema {
  role: string;
  login?: boolean;
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  inherit?: boolean;
  bypassrls?: boolean;
  replication?: boolean;
  connection_limit?: number;
  in?: string[];
  comment?: string;
}

// ─── Extensions ─────────────────────────────────────────────────

export interface SchemaGrant {
  to: string;
  schemas: string[];
}

export interface ExtensionsSchema {
  extensions: string[];
  schema_grants?: SchemaGrant[];
}

// ─── Mixin ──────────────────────────────────────────────────────

export interface MixinSchema {
  mixin: string;
  columns?: ColumnDef[];
  indexes?: IndexDef[];
  checks?: CheckDef[];
  triggers?: TriggerDef[];
  policies?: PolicyDef[];
  grants?: GrantDef[];
  rls?: boolean;
  force_rls?: boolean;
}
