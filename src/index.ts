// Public API surface for @smplcty/schema-flow

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
  IndexOrder,
  IndexNulls,
  IndexKey,
  IndexColumn,
  IndexDef,
  DeferrableMode,
  CheckDef,
  ExclusionConstraintDef,
  ExclusionConstraintElement,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  TriggerDef,
  PolicyCommand,
  PolicyDef,
  GrantDef,
  FunctionGrantDef,
  PrecheckDef,
  SqlExpression,
  SeedRow,
  SeedOnConflict,
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
export { formatOperationMessage } from './executor/format-operation.js';

// CLI reporting
export { reportMigrationResult } from './cli/report.js';
export type { VerbosityMode, ReportOptions } from './cli/report.js';

// Drift detection
export { detectDrift, hydrateActualSeeds } from './drift/index.js';
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
export {
  ensureExpandStateTable,
  planExpandColumn,
  runBackfill,
  runBackfillAll,
  runContract,
  runContractAll,
  getExpandStatus,
} from './expand/index.js';
export type {
  ExpandOperationType,
  ExpandOperation,
  ExpandState,
  BackfillOptions,
  BackfillResult,
  BackfillAllOptions,
  BackfillAllResult,
  ContractOptions,
  ContractResult,
  ContractAllOptions,
  ContractAllResult,
  ContractedRow,
  SkippedRow,
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
