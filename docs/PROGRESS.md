# Progress Log

## Current State

<!-- Updated by each Ralph Loop iteration. Read this FIRST. -->

Last completed task: T-013 (Scaffold / generate)
Next eligible task: T-014 (Rollback)

## Completed Tasks

- **T-001**: Project setup and config system — TypeScript project (tsconfig, vitest, pnpm), config resolution with defaults/env/yaml/CLI overrides. 16 tests passing.
- **T-002**: Database connection management — Pool singleton, withClient, withTransaction, retry logic for transient errors, configurable timeouts, testConnection. 19 tests passing.
- **T-000**: Docker-based test database setup — docker-compose.yml with PG 17 on port 54329 (tmpfs, healthcheck), .env/.env.example, vitest loads dotenv, db.test.ts uses DATABASE_URL without fallback. 35 tests passing.
- **T-003**: File discovery and tracking — glob-based YAML/SQL discovery from schema dir with phase classification (pre/schema/post), SHA-256 hash-based file tracker using \_simplicity.history table, change detection via hash comparison. 62 tests passing.
- **T-004**: Logger — Structured leveled logger (debug/info/warn/error) with colored output, verbose/quiet/json modes, configurable output streams. 15 tests passing.
- **T-005**: Schema type definitions — All YAML schema types defined in `src/schema/types.ts`: TableSchema, ColumnDef, IndexDef, CheckDef, UniqueConstraintDef, TriggerDef, PolicyDef, FunctionSchema, FunctionArg, EnumSchema, ViewSchema, MaterializedViewSchema, RoleSchema, ExtensionsSchema, MixinSchema, GrantDef, FunctionGrantDef, PrecheckDef, and supporting types. 77 tests passing (no regressions).
- **T-006**: YAML parser — `src/schema/parser.ts` with parsers for all schema kinds (table, enum, function, view, materialized view, role, extensions, mixin). Validates required fields, validates enum values (timing, method, security, etc.), applies defaults. `parseSchemaFile` auto-detects kind from YAML content. 38 new tests, 115 total passing.
- **T-007**: Mixin system — `src/schema/mixins.ts` with `loadMixins` (builds name→MixinSchema registry, rejects duplicates) and `applyMixins` (merges columns/indexes/checks/triggers/policies/grants into table schemas, skips duplicate columns, substitutes `{table}` placeholder in all string fields). Immutable — does not mutate inputs. 19 new tests, 134 total passing.
- **T-008**: Database introspection — `src/introspect/index.ts` with `getExistingTables`, `getExistingEnums`, `getExistingFunctions`, `getExistingViews`, `getExistingMaterializedViews`, `getExistingRoles`, and `introspectTable` (columns with types/nullability/defaults/PKs, indexes, check constraints, foreign keys, triggers, RLS policies, table/column comments). All queries use pg_catalog for accuracy. 16 new tests, 150 total passing.
- **T-009**: Planner / diff engine — `src/planner/index.ts` with `buildPlan` that compares desired (YAML) state vs actual (introspected) state. Produces ordered operations across all object types (extensions, enums, roles, functions, tables, columns, indexes, FKs, views, materialized views, triggers, RLS policies, grants, comments, seeds). FKs added as NOT VALID then validated. Destructive operations blocked unless allowDestructive set. Operations sorted by phase for correct dependency order. 49 new tests, 199 total passing.
- **T-010**: Executor — `src/executor/index.ts` with `execute` function that runs planned operations in phased order within transactions. Advisory locking (pg_try_advisory_lock) prevents concurrent migrations. Dry-run mode logs operations without executing. Validate mode executes in a rolled-back transaction. Pre/post SQL scripts run in separate transactions with SHA-256 hash tracking (skip unchanged files). Automatic rollback on errors. Ensures `_simplicity` schema exists. 12 new tests, 211 total passing.
- **T-011**: CLI entry point — `src/cli/index.ts` with argument parsing (`src/cli/args.ts`), help text (`src/cli/help.ts`), and pipeline orchestration (`src/cli/pipeline.ts`). Commands: run (full/pre/migrate/post), plan (dry-run), validate (rollback transaction), status (applied files + pending changes), init (create directory structure), help, version. Full pipeline wiring: discover → parse → expand mixins → introspect DB → plan → execute. 35 new tests, 246 total passing.
- **T-012**: Drift detection — `src/drift/index.ts` with `detectDrift` function. Structured `DriftReport` covering all object types. 31 tests, 277 total passing.
- **T-013**: Scaffold / generate — `src/scaffold/index.ts` with `generateFromDb` (introspects DB objects and produces YAML files, one per table/enum/function/view/role), `scaffoldInit` (creates standard directory structure), `scaffoldPre`/`scaffoldPost` (timestamped SQL templates), `scaffoldMixin` (YAML mixin template). Writes files to disk when outputDir provided. 15 new tests, 292 total passing.
