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
- **Status**: DONE
- **Depends**: T-005
- **Description**: Implement YAML-to-typed-object parsers for each schema kind. Validate required fields, apply defaults.
- **Produces**: `src/schema/parser.ts`, tests

### T-007: Mixin system
- **Status**: DONE
- **Depends**: T-006
- **Description**: Implement mixin loading — parse mixin YAML files, merge mixin columns/indexes/triggers/policies/grants into table schemas that reference them.
- **Produces**: `src/schema/mixins.ts`, tests

## Milestone 3: Introspection

### T-008: Database introspection
- **Status**: DONE
- **Depends**: T-002, T-005
- **Description**: Implement queries against pg_catalog / information_schema to read current DB state — tables, columns, constraints, indexes, triggers, enums, functions, views, materialized views, roles, grants. Return typed data structures matching the schema types.
- **Produces**: `src/introspect/index.ts`, tests

## Milestone 4: Planning and Execution

### T-009: Planner / diff engine
- **Status**: DONE
- **Depends**: T-006, T-008
- **Description**: Implement the diff engine — compare desired (YAML) state vs. actual (introspected) state. Produce an ordered list of operations: create/alter/drop for tables, columns, indexes, constraints, FKs, enums, functions, views, triggers, policies, grants, roles, comments, seeds. Block destructive operations unless allowDestructive is set. Emit tables without FKs first, add FKs later.
- **Produces**: `src/planner/index.ts`, tests

### T-010: Executor
- **Status**: DONE
- **Depends**: T-009, T-003
- **Description**: Implement the executor — run operations in phased order (pre → extensions → enums → roles → functions → tables → views → mat views → triggers → RLS → grants → comments → seeds → post) within transactions. Support advisory locking, dry-run mode, validate mode.
- **Produces**: `src/executor/index.ts`, tests

## Milestone 5: CLI

### T-011: CLI entry point
- **Status**: DONE
- **Depends**: T-010
- **Description**: Implement CLI with commands: `run`, `run pre`, `run migrate`, `run post`, `plan`, `validate`, `status`, `init`, `help`. Wire up config resolution, logging, and the migration pipeline.
- **Produces**: `src/cli/index.ts`, tests

## Milestone 6: Secondary Features

### T-012: Drift detection
- **Status**: DONE
- **Depends**: T-009
- **Description**: Implement read-only drift detection — compare YAML to live DB for all object types and produce a structured DriftReport.
- **Produces**: `src/drift/index.ts`, tests

### T-013: Scaffold / generate
- **Status**: DONE
- **Depends**: T-008
- **Description**: Implement DB-to-YAML generation — introspect an existing database and produce YAML files. Also support `init` (project directory scaffolding) and `new pre|post|mixin` templates.
- **Produces**: `src/scaffold/index.ts`, tests

### T-014: Rollback
- **Status**: DONE
- **Depends**: T-010
- **Description**: Implement snapshot capture before each migration and reverse operation computation. Support `down` command to rollback to a previous snapshot.
- **Produces**: `src/rollback/index.ts`, tests

### T-015: Expand/contract (zero-downtime migrations)
- **Status**: DONE
- **Depends**: T-010
- **Description**: Implement expand/contract column migrations — add new column, create dual-write trigger, backfill, contract (drop old). Track expand state. Support `contract` and `expand-status` CLI commands.
- **Produces**: `src/expand/index.ts`, tests

### T-016: SQL generation
- **Status**: DONE
- **Depends**: T-009
- **Description**: Render a migration plan as a standalone `.sql` file.
- **Produces**: `src/sql/index.ts`, tests

### T-017: Lint
- **Status**: DONE
- **Depends**: T-009
- **Description**: Implement static analysis rules on migration plans — warn about dangerous patterns (dropping columns, long-held locks, etc.).
- **Produces**: `src/lint/index.ts`, tests

### T-018: ERD generation
- **Status**: DONE
- **Depends**: T-006
- **Description**: Generate Mermaid ER diagrams from YAML table definitions.
- **Produces**: `src/erd/index.ts`, tests

## Milestone 7: Public API and Testing Infrastructure

### T-019: Public API surface
- **Status**: DONE
- **Depends**: T-011, T-012, T-013, T-014, T-015, T-016, T-017, T-018
- **Description**: Create `src/index.ts` that re-exports all public functionality and type definitions for programmatic use.
- **Produces**: `src/index.ts`

### T-020: Test infrastructure
- **Status**: DONE
- **Depends**: T-002
- **Description**: Implement test helpers — `useTestProject` for creating isolated PG schemas, `writeSchema` for writing YAML to temp dirs, `migrate`/`drift` helpers for running the pipeline in tests.
- **Produces**: `src/testing/index.ts`, tests

## Milestone 8: Coverage Gaps — Zero-Downtime Patterns

### T-021: CONCURRENTLY indexes
- **Status**: DONE
- **Depends**: T-010
- **Description**: Add tests (and implement if missing) verifying that `CREATE INDEX CONCURRENTLY` is used for index creation, and that CONCURRENTLY operations run outside of transactions (PRD §8.3). Add a planner test that index operations produce CONCURRENTLY SQL, and an executor test that CONCURRENTLY indexes are not wrapped in BEGIN/COMMIT. Also add SQL generation test verifying CONCURRENTLY ops appear outside transaction blocks (PRD §11.4).
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `sql.test.ts`

### T-022: Safe NOT NULL pattern
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add tests (and implement if missing) for the 4-step safe NOT NULL pattern from PRD §8.3: (1) ADD CHECK (col IS NOT NULL) NOT VALID, (2) VALIDATE CONSTRAINT, (3) ALTER COLUMN SET NOT NULL, (4) DROP redundant check constraint. The planner should produce these 4 operations when a column changes from nullable to non-nullable. Verify with planner tests and an executor integration test against real PG.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-023: Safe unique constraint pattern
- **Status**: DONE
- **Depends**: T-021
- **Description**: Add tests (and implement if missing) for the 2-step safe unique constraint pattern from PRD §8.3: (1) CREATE UNIQUE INDEX CONCURRENTLY, (2) ALTER TABLE ADD CONSTRAINT ... USING INDEX. Verify in planner and executor tests.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-024: Enum value removal blocking
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner tests verifying that removing an enum value is blocked by default (listed in PRD §8.1 destructive operations) and allowed with `--allow-destructive`. If the planner doesn't implement this, add the logic.
- **Produces**: Tests in `planner.test.ts`

## Milestone 9: Coverage Gaps — Grants, Memberships & Operations

### T-025: Grant/revoke for sequences and functions
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner tests (and implement if missing) for `grant_sequence`, `revoke_sequence`, `grant_function`, `revoke_function` operations (PRD §7.3). Function grants defined in function YAML (PRD §4.3) should produce `grant_function` operations. Sequence grants should be auto-generated for tables with serial/identity columns. Add executor integration tests verifying the SQL executes correctly.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-026: Role group memberships (grant_membership)
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner test verifying that when a role has `in: [group_name]`, the planner produces `grant_membership` operations (PRD §4.6, §7.3). Add executor integration test verifying `GRANT group TO role` executes correctly. Also test that role attributes (superuser, createdb, createrole, inherit, bypassrls, replication, connection_limit) produce correct ALTER ROLE SQL.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-027: Materialized view grants, comments, and refresh
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add tests for: (1) grants on materialized views produce `grant_table` operations, (2) comments on materialized views produce `set_comment` operations, (3) `refresh_materialized_view` operation is produced when a materialized view's query changes (PRD §4.5, §7.2 phase 10, §7.3). Add parser, planner, and executor tests.
- **Produces**: Tests in `parser.test.ts`, `planner.test.ts`, `executor.test.ts`

### T-028: Extension schema_grants SQL generation
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner and executor tests verifying that `schema_grants` in extensions YAML (PRD §4.7) produces correct GRANT USAGE ON SCHEMA SQL.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

## Milestone 10: Coverage Gaps — CLI Commands

### T-029: Baseline command
- **Status**: TODO
- **Depends**: T-011
- **Description**: Implement and test the `baseline` command (PRD §6.1). This command marks the current DB state as baseline by creating history entries for all current schema files without running migrations. Add CLI arg parsing test and pipeline integration test.
- **Produces**: Updated `src/cli/args.ts`, `src/cli/pipeline.ts`, tests in `cli.test.ts`

### T-030: Missing CLI command parsing
- **Status**: TODO
- **Depends**: T-011
- **Description**: Add CLI argument parsing tests for all commands missing coverage: `drift`, `lint`, `generate` (with `--output-dir`, `--seeds`), `sql` (with `--output`), `erd` (with `--output`), `new pre --name`, `new post --name`, `new mixin --name`, `down`, `contract`, `expand-status`, `docs`. Add `--apply` flag parsing for drift. Implement any commands not yet wired in the CLI.
- **Produces**: Tests in `cli.test.ts`, updated `src/cli/args.ts`

## Milestone 11: Coverage Gaps — Precheck Execution & Snapshots

### T-031: Precheck execution and abort
- **Status**: TODO
- **Depends**: T-010
- **Description**: Add integration tests verifying that prechecks defined in table YAML (PRD §4.1, §11.6) are actually executed during migration, and that migration aborts with the provided message when a precheck query returns a falsy value. Test both passing and failing prechecks. If the executor doesn't implement precheck execution, add the logic.
- **Produces**: Tests in `executor.test.ts`

### T-032: Auto snapshot capture during migration
- **Status**: TODO
- **Depends**: T-014
- **Description**: Add integration test verifying that the migration pipeline (`runAll`/`runMigrate`) automatically saves a snapshot before executing operations (PRD §11.2). After running a migration, verify a snapshot exists in `_simplicity.snapshots`. Also test that `runDown` after a migration successfully rolls back using the auto-captured snapshot.
- **Produces**: Tests in `executor.test.ts` or `rollback.test.ts`

## Milestone 12: Coverage Gaps — Drift Detection

### T-033: Drift detection completeness
- **Status**: TODO
- **Depends**: T-012
- **Description**: Add drift detection tests for all comparison dimensions missing coverage (PRD §10): (1) index attribute differences (uniqueness, method, partial conditions), (2) FK constraint drift, (3) unique constraint drift, (4) function attribute differences (body, args, return type, security, volatility), (5) role membership drift, (6) grant drift (table-level, column-level, sequence, function), (7) seed drift. If detectDrift doesn't compare these attributes, add the logic.
- **Produces**: Tests in `drift.test.ts`, possibly updated `src/drift/index.ts`

## Milestone 13: Coverage Gaps — Public API Surface

### T-034: PRD-listed API exports
- **Status**: TODO
- **Depends**: T-019
- **Description**: Verify and add all PRD §13 exports that are missing or differently named: `runAll`, `runPre`, `runMigrate`, `runPost`, `runValidate`, `runBaseline` (pipeline convenience functions), `parseTableFile`, `parseFunctionFile`, `parseEnumFile`, `parseViewFile`, `parseRoleFile` (file-path-based parsers that read+parse), `generateSqlFile(plan, output)` (write SQL to file), `formatMigrationSql(operations)` (format ops as SQL string). Add re-exports or wrapper functions as needed in `src/index.ts`. Add tests in `index.test.ts` verifying all exports exist. Also verify all type exports (TableSchema, ColumnDef, etc.) are importable.
- **Produces**: Updated `src/index.ts`, tests in `index.test.ts`
