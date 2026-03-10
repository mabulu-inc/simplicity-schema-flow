// Public API surface for @mabulu-inc/simplicity-schema

// Core
export { resolveConfig } from './core/config.js';
export type { SimplicitySchemaConfig, ConfigOverrides } from './core/config.js';
export { withClient, withTransaction, closePool, testConnection } from './core/db.js';
export type { ClientOptions } from './core/db.js';
export { discoverSchemaFiles } from './core/files.js';
export type { Phase, SchemaFile, DiscoveredFiles } from './core/files.js';
export { createLogger } from './core/logger.js';
export type { Logger, LoggerOptions } from './core/logger.js';
export { LogLevel } from './core/logger.js';

// Schema parsing
export {
  parseTable,
  parseEnum,
  parseFunction,
  parseView,
  parseRole,
  parseExtensions,
  parseMixin,
  parseSchemaFile,
  parseTableFile,
  parseFunctionFile,
  parseEnumFile,
  parseViewFile,
  parseRoleFile,
} from './schema/parser.js';
export type { SchemaKind, ParsedSchema } from './schema/parser.js';
export { loadMixins, applyMixins } from './schema/mixins.js';
export type { MixinRegistry } from './schema/mixins.js';

// Schema types
export type {
  ForeignKeyAction,
  ForeignKeyRef,
  ExpandDef,
  ColumnDef,
  IndexMethod,
  IndexDef,
  CheckDef,
  UniqueConstraintDef,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  TriggerDef,
  PolicyCommand,
  PolicyDef,
  GrantDef,
  FunctionGrantDef,
  PrecheckDef,
  SeedRow,
  TableSchema,
  EnumSchema,
  FunctionSecurity,
  FunctionVolatility,
  FunctionParallel,
  FunctionArgMode,
  FunctionArg,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  SchemaGrant,
  ExtensionsSchema,
  MixinSchema,
} from './schema/types.js';

// Introspection
export {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
} from './introspect/index.js';

// Planner
export { buildPlan } from './planner/index.js';
export type { OperationType, Operation, DesiredState, ActualState, PlanOptions, PlanResult } from './planner/index.js';

// Executor
export {
  execute,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  detectInvalidIndexes,
  reindexInvalid,
} from './executor/index.js';
export type { ExecuteOptions, ExecuteResult, InvalidIndex } from './executor/index.js';

// Drift detection
export { detectDrift } from './drift/index.js';
export type { DriftItemType, DriftStatus, DriftItem, DriftReport } from './drift/index.js';

// Lint
export { lintPlan } from './lint/index.js';
export type { LintSeverity, LintWarning, LintResult } from './lint/index.js';

// Rollback
export {
  ensureSnapshotsTable,
  saveSnapshot,
  getLatestSnapshot,
  listSnapshots,
  deleteSnapshot,
  computeRollback,
  runDown,
} from './rollback/index.js';
export type { MigrationSnapshot, RollbackResult, RunDownOptions, RunDownResult } from './rollback/index.js';

// Expand/contract
export { ensureExpandStateTable, planExpandColumn, runBackfill, runContract, getExpandStatus } from './expand/index.js';
export type {
  ExpandOperationType,
  ExpandOperation,
  ExpandState,
  BackfillOptions,
  BackfillResult,
  ContractOptions,
  ContractResult,
} from './expand/index.js';

// Scaffold / generate
export { generateFromDb, scaffoldInit, scaffoldPre, scaffoldPost, scaffoldMixin } from './scaffold/index.js';
export type { GenerateInput, GeneratedFile } from './scaffold/index.js';

// SQL generation
export { generateSql, generateSqlFile, formatMigrationSql } from './sql/index.js';
export type { GenerateSqlOptions } from './sql/index.js';

// ERD generation
export { generateErd } from './erd/index.js';

// CLI pipeline
export {
  runPipeline,
  runAll,
  runPre,
  runMigrate,
  runPost,
  runValidate,
  runBaseline,
  initProject,
  getStatus,
} from './cli/pipeline.js';
export type { PipelineOptions, StatusResult, BaselineResult } from './cli/pipeline.js';
