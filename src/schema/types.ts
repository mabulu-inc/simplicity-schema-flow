// Schema type definitions for simplicity-schema YAML files

// ─── Foreign Key ────────────────────────────────────────────────

export type ForeignKeyAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';

export interface ForeignKeyRef {
  table: string;
  column: string;
  on_delete?: ForeignKeyAction;
  on_update?: ForeignKeyAction;
  deferrable?: boolean;
  initially_deferred?: boolean;
}

// ─── Expand (zero-downtime column migration) ────────────────────

export interface ExpandDef {
  from: string;
  transform: string;
}

// ─── Column ─────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  primary_key?: boolean;
  unique?: boolean;
  default?: string;
  comment?: string;
  references?: ForeignKeyRef;
  generated?: string;
  expand?: ExpandDef;
}

// ─── Index ──────────────────────────────────────────────────────

export type IndexMethod = 'btree' | 'gin' | 'gist' | 'hash' | 'brin';

export interface IndexDef {
  name?: string;
  columns: string[];
  unique?: boolean;
  method?: IndexMethod;
  where?: string;
  include?: string[];
  opclass?: string;
}

// ─── Check Constraint ───────────────────────────────────────────

export interface CheckDef {
  name: string;
  expression: string;
  comment?: string;
}

// ─── Unique Constraint ──────────────────────────────────────────

export interface UniqueConstraintDef {
  columns: string[];
  name?: string;
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

export type SeedRow = Record<string, unknown>;

// ─── Table ──────────────────────────────────────────────────────

export interface TableSchema {
  table: string;
  columns: ColumnDef[];
  primary_key?: string[];
  indexes?: IndexDef[];
  checks?: CheckDef[];
  unique_constraints?: UniqueConstraintDef[];
  triggers?: TriggerDef[];
  rls?: boolean;
  force_rls?: boolean;
  policies?: PolicyDef[];
  grants?: GrantDef[];
  prechecks?: PrecheckDef[];
  seeds?: SeedRow[];
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
