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

// ─── Partitioning ───────────────────────────────────────────────

export type PartitionStrategy = 'range' | 'list' | 'hash';

/**
 * Declares a table as a partitioned parent (`CREATE TABLE … PARTITION BY`).
 * `key` lists the partition-key columns; PostgreSQL requires every unique
 * constraint / primary key on the table to include all of them. Child
 * partitions are NOT modeled here — they are created out-of-band (e.g. by
 * pg_partman) and are deliberately ignored by introspection so a re-run is a
 * clean no-op on the parent.
 */
export interface PartitionByDef {
  strategy: PartitionStrategy;
  key: string[];
}

export type PartitionGranularity = 'day' | 'week' | 'month' | 'year';

/**
 * Declarative rolling-partition maintenance, delegated to pg_partman. Attaching
 * this to a partitioned parent registers it with pg_partman (`create_parent`)
 * and sets its `part_config` so the rolling window is reconciled on each
 * maintenance run. Requires `pg_partman` declared under `extensions:` and a
 * single-column `partition_by.key` (pg_partman partitions on one control
 * column).
 */
export interface PartitionsDef {
  /** Partition size — maps to pg_partman's interval (e.g. month → '1 month'). */
  granularity: PartitionGranularity;
  /**
   * Rolling window around now() in `granularity` units, as `[back, forward]`.
   * `back` (≤ 0) becomes the retention horizon; `forward` (≥ 0) becomes the
   * number of future partitions premade. E.g. `[-24, 3]` = keep 24 months of
   * history, premake 3 months ahead.
   */
  window: [number, number];
  /** Ensure a DEFAULT catch-all partition. Defaults to true. */
  default?: boolean;
  /**
   * On aging out of the window, detach the partition but keep its table
   * (true, default — data-safe) versus drop it (false — destructive).
   */
  retention_keep_table?: boolean;
}

/**
 * Global pg_partman maintenance schedule. pg_partman's `run_maintenance_proc()`
 * services every configured parent in one call, so the cadence is database-wide,
 * not per-table. Emitted as a single pg_cron job — only when `pg_cron` is
 * declared under `extensions:`.
 */
export interface PartitionMaintenanceDef {
  /** Cron expression for the maintenance job. Defaults to '@daily'. */
  schedule?: string;
}

// ─── Table ──────────────────────────────────────────────────────

export interface TableSchema {
  table: string;
  columns: ColumnDef[];
  partition_by?: PartitionByDef;
  partitions?: PartitionsDef;
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
  mixins?: string[];
  comment?: string;
  /**
   * Apply this table (its CREATE plus indexes/constraints/seeds) in a dedicated
   * transaction that commits BEFORE the main apply transaction. Lets per-tx
   * hooks in the main tx resolve rows seeded here (e.g. a service user an audit
   * trigger stamps from). A bootstrap table may not have a foreign key to a
   * non-bootstrap table — that's rejected at plan time.
   */
  bootstrap?: boolean;
}

// ─── Extend ─────────────────────────────────────────────────────

/**
 * An `extend:` file augments an existing table (imported or local) without
 * redeclaring it. The named table's columns/indexes/mixins/policies/grants/
 * checks/triggers/seeds are merged in. Re-declaring an existing column is an
 * error (type changes go through a pre-script). Multiple extends for one table
 * are allowed and merge in source order (imports first, then local).
 */
export interface ExtendSchema {
  extend: string;
  columns?: ColumnDef[];
  indexes?: IndexDef[];
  checks?: CheckDef[];
  triggers?: TriggerDef[];
  policies?: PolicyDef[];
  grants?: GrantDef[];
  mixins?: string[];
  rls?: boolean;
  force_rls?: boolean;
  seeds?: SeedRow[];
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

/**
 * An extension to ensure. A bare string in YAML (`- pg_partman`) is normalized
 * to `{ name }`; the object form pins the install schema
 * (`{ name: pg_partman, schema: partman }` → `CREATE EXTENSION … SCHEMA …`).
 */
export interface ExtensionRef {
  name: string;
  schema?: string;
}

export interface ExtensionsSchema {
  extensions: ExtensionRef[];
  schema_grants?: SchemaGrant[];
  partition_maintenance?: PartitionMaintenanceDef;
}

// ─── Mixin ──────────────────────────────────────────────────────

/**
 * A mixin parameter declaration. Parameters let a sharable mixin (and the
 * functions shipped alongside it) reference app-specific things — the FK
 * target for `created_by`, the GUC an audit trigger reads — without coupling
 * to any one app. The consuming app supplies values via `imports[].params`;
 * `{{name}}` placeholders are interpolated into the mixin's columns/refs/
 * indexes/policies and into the shipping package's function bodies. A default
 * makes the common case param-free.
 */
export interface MixinParam {
  default?: string;
}

export interface MixinSchema {
  mixin: string;
  params?: Record<string, MixinParam>;
  columns?: ColumnDef[];
  indexes?: IndexDef[];
  checks?: CheckDef[];
  triggers?: TriggerDef[];
  policies?: PolicyDef[];
  grants?: GrantDef[];
  rls?: boolean;
  force_rls?: boolean;
  comment?: string;
}
