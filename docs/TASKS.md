# Task List

## Milestone 0: Infrastructure

### T-000: Docker-based test database setup
- **Status**: DONE
- **Depends**: (none)
- **Description**: Create `docker-compose.yml` with a PostgreSQL 17 container on port 54329 (with healthcheck, tmpfs for speed). Create `.env.example` with `DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres`. Create `.env` (gitignored) copied from example. Update `vitest.config.ts` (or create `test/setup.ts`) to load `.env` via `dotenv`. Fix `src/core/__tests__/db.test.ts` to use `process.env.DATABASE_URL` without a hardcoded port fallback. Verify all existing tests pass against the containerized database.
- **Produces**: `docker-compose.yml`, `.env.example`, `.env`, updated test files

## Milestone 1: Core Foundation

### T-001: Project setup and config system
- **Status**: DONE
- **Depends**: (none)
- **Description**: Set up TypeScript project (tsconfig, vitest, pnpm). Implement config resolution — convention-over-configuration defaults, env var lookup (`SIMPLICITY_SCHEMA_DATABASE_URL` → `DATABASE_URL`), optional `simplicity-schema.config.yaml` file, CLI flag overrides.
- **Produces**: `src/core/config.ts`, `src/core/config-file.ts`, tests

### T-002: Database connection management
- **Status**: DONE
- **Depends**: T-001
- **Description**: Implement connection pool (pg.Pool singleton), `withClient`, `withTransaction`, retry logic for transient errors (lock timeout, serialization failure, deadlock). Configurable lock_timeout and statement_timeout.
- **Produces**: `src/core/db.ts`, tests

### T-003: File discovery and tracking
- **Status**: DONE
- **Depends**: T-001
- **Description**: Implement glob-based discovery of YAML/SQL files from the schema directory. Implement file tracker — `_simplicity.history` table with file_path, SHA-256 hash, phase, applied_at. All files are hash-tracked uniformly and re-run only when content changes.
- **Produces**: `src/core/files.ts`, `src/core/tracker.ts`, tests

### T-004: Logger
- **Status**: DONE
- **Depends**: T-001
- **Description**: Implement structured leveled logger with colored output.
- **Produces**: `src/core/logger.ts`

## Milestone 2: Schema Parsing

### T-005: Schema type definitions
- **Status**: DONE
- **Depends**: T-001
- **Description**: Define all YAML schema types — TableSchema, ColumnDef, IndexDef, CheckDef, UniqueConstraintDef, TriggerDef, PolicyDef, FunctionSchema, FunctionArg, EnumSchema, ViewSchema, MaterializedViewSchema, RoleSchema, ExtensionsSchema, MixinSchema, GrantDef, FunctionGrantDef, PrecheckDef, and all supporting types.
- **Produces**: `src/schema/types.ts`

### T-006: YAML parser
- **Status**: TODO
- **Depends**: T-005
- **Description**: Implement YAML-to-typed-object parsers for each schema kind. Validate required fields, apply defaults.
- **Produces**: `src/schema/parser.ts`, tests

### T-007: Mixin system
- **Status**: TODO
- **Depends**: T-006
- **Description**: Implement mixin loading — parse mixin YAML files, merge mixin columns/indexes/triggers/policies/grants into table schemas that reference them.
- **Produces**: `src/schema/mixins.ts`, tests

## Milestone 3: Introspection

### T-008: Database introspection
- **Status**: TODO
- **Depends**: T-002, T-005
- **Description**: Implement queries against pg_catalog / information_schema to read current DB state — tables, columns, constraints, indexes, triggers, enums, functions, views, materialized views, roles, grants. Return typed data structures matching the schema types.
- **Produces**: `src/introspect/index.ts`, tests

## Milestone 4: Planning and Execution

### T-009: Planner / diff engine
- **Status**: TODO
- **Depends**: T-006, T-008
- **Description**: Implement the diff engine — compare desired (YAML) state vs. actual (introspected) state. Produce an ordered list of operations: create/alter/drop for tables, columns, indexes, constraints, FKs, enums, functions, views, triggers, policies, grants, roles, comments, seeds. Block destructive operations unless allowDestructive is set. Emit tables without FKs first, add FKs later.
- **Produces**: `src/planner/index.ts`, tests

### T-010: Executor
- **Status**: TODO
- **Depends**: T-009, T-003
- **Description**: Implement the executor — run operations in phased order (pre → extensions → enums → roles → functions → tables → views → mat views → triggers → RLS → grants → comments → seeds → post) within transactions. Support advisory locking, dry-run mode, validate mode.
- **Produces**: `src/executor/index.ts`, tests

## Milestone 5: CLI

### T-011: CLI entry point
- **Status**: TODO
- **Depends**: T-010
- **Description**: Implement CLI with commands: `run`, `run pre`, `run migrate`, `run post`, `plan`, `validate`, `status`, `init`, `help`. Wire up config resolution, logging, and the migration pipeline.
- **Produces**: `src/cli/index.ts`, tests

## Milestone 6: Secondary Features

### T-012: Drift detection
- **Status**: TODO
- **Depends**: T-009
- **Description**: Implement read-only drift detection — compare YAML to live DB for all object types and produce a structured DriftReport.
- **Produces**: `src/drift/index.ts`, tests

### T-013: Scaffold / generate
- **Status**: TODO
- **Depends**: T-008
- **Description**: Implement DB-to-YAML generation — introspect an existing database and produce YAML files. Also support `init` (project directory scaffolding) and `new pre|post|mixin` templates.
- **Produces**: `src/scaffold/index.ts`, tests

### T-014: Rollback
- **Status**: TODO
- **Depends**: T-010
- **Description**: Implement snapshot capture before each migration and reverse operation computation. Support `down` command to rollback to a previous snapshot.
- **Produces**: `src/rollback/index.ts`, tests

### T-015: Expand/contract (zero-downtime migrations)
- **Status**: TODO
- **Depends**: T-010
- **Description**: Implement expand/contract column migrations — add new column, create dual-write trigger, backfill, contract (drop old). Track expand state. Support `contract` and `expand-status` CLI commands.
- **Produces**: `src/expand/index.ts`, tests

### T-016: SQL generation
- **Status**: TODO
- **Depends**: T-009
- **Description**: Render a migration plan as a standalone `.sql` file.
- **Produces**: `src/sql/index.ts`, tests

### T-017: Lint
- **Status**: TODO
- **Depends**: T-009
- **Description**: Implement static analysis rules on migration plans — warn about dangerous patterns (dropping columns, long-held locks, etc.).
- **Produces**: `src/lint/index.ts`, tests

### T-018: ERD generation
- **Status**: TODO
- **Depends**: T-006
- **Description**: Generate Mermaid ER diagrams from YAML table definitions.
- **Produces**: `src/erd/index.ts`, tests

## Milestone 7: Public API and Testing Infrastructure

### T-019: Public API surface
- **Status**: TODO
- **Depends**: T-011, T-012, T-013, T-014, T-015, T-016, T-017, T-018
- **Description**: Create `src/index.ts` that re-exports all public functionality and type definitions for programmatic use.
- **Produces**: `src/index.ts`

### T-020: Test infrastructure
- **Status**: TODO
- **Depends**: T-002
- **Description**: Implement test helpers — `useTestProject` for creating isolated PG schemas, `writeSchema` for writing YAML to temp dirs, `migrate`/`drift` helpers for running the pipeline in tests.
- **Produces**: `src/testing/index.ts`, tests
