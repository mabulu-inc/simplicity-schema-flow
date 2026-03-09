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
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add planner tests verifying that removing an enum value is blocked by default (listed in PRD §8.1 destructive operations) and allowed with `--allow-destructive`. If the planner doesn't implement this, add the logic.
- **Produces**: Tests in `planner.test.ts`

## Milestone 9: Coverage Gaps — Grants, Memberships & Operations

### T-025: Grant/revoke for sequences and functions
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add planner tests (and implement if missing) for `grant_sequence`, `revoke_sequence`, `grant_function`, `revoke_function` operations (PRD §7.3). Function grants defined in function YAML (PRD §4.3) should produce `grant_function` operations. Sequence grants should be auto-generated for tables with serial/identity columns. Add executor integration tests verifying the SQL executes correctly.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-026: Role group memberships (grant_membership)
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add planner test verifying that when a role has `in: [group_name]`, the planner produces `grant_membership` operations (PRD §4.6, §7.3). Add executor integration test verifying `GRANT group TO role` executes correctly. Also test that role attributes (superuser, createdb, createrole, inherit, bypassrls, replication, connection_limit) produce correct ALTER ROLE SQL.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-027: Materialized view grants, comments, and refresh
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add tests for: (1) grants on materialized views produce `grant_table` operations, (2) comments on materialized views produce `set_comment` operations, (3) `refresh_materialized_view` operation is produced when a materialized view's query changes (PRD §4.5, §7.2 phase 10, §7.3). Add parser, planner, and executor tests.
- **Produces**: Tests in `parser.test.ts`, `planner.test.ts`, `executor.test.ts`

### T-028: Extension schema_grants SQL generation
- **Status**: DONE
- **Depends**: T-009
- **Description**: Add planner and executor tests verifying that `schema_grants` in extensions YAML (PRD §4.7) produces correct GRANT USAGE ON SCHEMA SQL.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

## Milestone 10: Coverage Gaps — CLI Commands

### T-029: Baseline command
- **Status**: DONE
- **Depends**: T-011
- **Description**: Implement and test the `baseline` command (PRD §6.1). This command marks the current DB state as baseline by creating history entries for all current schema files without running migrations. Add CLI arg parsing test and pipeline integration test.
- **Produces**: Updated `src/cli/args.ts`, `src/cli/pipeline.ts`, tests in `cli.test.ts`

### T-030: Missing CLI command parsing
- **Status**: DONE
- **Depends**: T-011
- **Description**: Add CLI argument parsing tests for all commands missing coverage: `drift`, `lint`, `generate` (with `--output-dir`, `--seeds`), `sql` (with `--output`), `erd` (with `--output`), `new pre --name`, `new post --name`, `new mixin --name`, `down`, `contract`, `expand-status`, `docs`. Add `--apply` flag parsing for drift. Implement any commands not yet wired in the CLI.
- **Produces**: Tests in `cli.test.ts`, updated `src/cli/args.ts`

## Milestone 11: Coverage Gaps — Precheck Execution & Snapshots

### T-031: Precheck execution and abort
- **Status**: DONE
- **Depends**: T-010
- **Description**: Add integration tests verifying that prechecks defined in table YAML (PRD §4.1, §11.6) are actually executed during migration, and that migration aborts with the provided message when a precheck query returns a falsy value. Test both passing and failing prechecks. If the executor doesn't implement precheck execution, add the logic.
- **Produces**: Tests in `executor.test.ts`

### T-032: Auto snapshot capture during migration
- **Status**: DONE
- **Depends**: T-014
- **Description**: Add integration test verifying that the migration pipeline (`runAll`/`runMigrate`) automatically saves a snapshot before executing operations (PRD §11.2). After running a migration, verify a snapshot exists in `_simplicity.snapshots`. Also test that `runDown` after a migration successfully rolls back using the auto-captured snapshot.
- **Produces**: Tests in `executor.test.ts` or `rollback.test.ts`

## Milestone 12: Coverage Gaps — Drift Detection

### T-033: Drift detection completeness
- **Status**: DONE
- **Depends**: T-012
- **Description**: Add drift detection tests for all comparison dimensions missing coverage (PRD §10): (1) index attribute differences (uniqueness, method, partial conditions), (2) FK constraint drift, (3) unique constraint drift, (4) function attribute differences (body, args, return type, security, volatility), (5) role membership drift, (6) grant drift (table-level, column-level, sequence, function), (7) seed drift. If detectDrift doesn't compare these attributes, add the logic.
- **Produces**: Tests in `drift.test.ts`, possibly updated `src/drift/index.ts`

## Milestone 13: Coverage Gaps — Public API Surface

### T-034: PRD-listed API exports
- **Status**: DONE
- **Depends**: T-019
- **Description**: Verify and add all PRD §13 exports that are missing or differently named: `runAll`, `runPre`, `runMigrate`, `runPost`, `runValidate`, `runBaseline` (pipeline convenience functions), `parseTableFile`, `parseFunctionFile`, `parseEnumFile`, `parseViewFile`, `parseRoleFile` (file-path-based parsers that read+parse), `generateSqlFile(plan, output)` (write SQL to file), `formatMigrationSql(operations)` (format ops as SQL string). Add re-exports or wrapper functions as needed in `src/index.ts`. Add tests in `index.test.ts` verifying all exports exist. Also verify all type exports (TableSchema, ColumnDef, etc.) are importable.
- **Produces**: Updated `src/index.ts`, tests in `index.test.ts`

## Milestone 14: Coverage Gaps — Column & Table Features

### T-035: Generated columns
- **Status**: DONE
- **Depends**: T-009, T-008
- **Description**: Add end-to-end tests for generated columns (PRD §4.1 `generated: "price * quantity"`). Planner must produce `CREATE TABLE` SQL with `GENERATED ALWAYS AS (expr) STORED`. Introspection must detect generated columns and their expressions. Drift detection must report when a generated expression differs or is missing. Add planner, executor integration, introspect, and drift tests. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`, `drift.test.ts`

### T-036: Column-level grants
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add end-to-end tests for column-level grants (PRD §4.1 `grants: { columns: [id, email, name] }`). Planner must produce `grant_column` operations generating `GRANT SELECT(col1, col2) ON table TO role`. Introspection must read column-level privileges. Drift detection must report column grant differences. Add planner, executor integration, and drift tests. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `drift.test.ts`

### T-037: Composite primary keys
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add tests for table-level composite primary keys (PRD §4.1 `primary_key: [col1, col2]`). Planner must generate `PRIMARY KEY (col1, col2)` in CREATE TABLE SQL. Introspection must detect composite PKs. Drift detection must report when composite PK structure differs. Add planner, executor integration, introspect, and drift tests. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`, `drift.test.ts`

### T-038: Seed upsert execution
- **Status**: TODO
- **Depends**: T-010
- **Description**: Add executor integration tests for seed upsert (PRD §7.2 phase 15). Planner must generate `add_seed` operations that produce `INSERT ... ON CONFLICT (primary_key) DO UPDATE SET ...` SQL. Test both initial insert and update-on-conflict scenarios. Verify seed data exists in the table after execution. Implement any missing logic.
- **Produces**: Tests in `executor.test.ts`

## Milestone 15: Coverage Gaps — FK, Index, Function & Trigger Options

### T-039: Foreign key options in SQL generation
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add planner and executor tests verifying FK options from PRD §4.1: `on_delete` (CASCADE, SET NULL, SET DEFAULT, RESTRICT, NO ACTION), `on_update`, `deferrable`, `initially_deferred`. Planner must produce SQL with `ON DELETE CASCADE`, `DEFERRABLE INITIALLY DEFERRED`, etc. Introspection must read these options. Drift must detect when FK options differ. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`, `drift.test.ts`

### T-040: Index options in SQL generation
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner and executor tests verifying index options from PRD §4.1: `method` (gin, gist, hash, brin), `where` (partial index), `include` (covering index), `opclass` (e.g., text_pattern_ops). Planner must produce SQL like `CREATE INDEX ... USING gin`, `WHERE condition`, `INCLUDE (col)`, `col text_pattern_ops`. Add executor integration tests verifying indexes are created with correct options. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-041: Function options in SQL generation
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add planner and executor tests for function options from PRD §4.3: `security` (definer/invoker), `volatility` (stable/immutable/volatile), `parallel` (safe/restricted/unsafe), `strict`, `leakproof`, `cost`, `rows`, `set` (configuration parameters). Planner must produce SQL with `SECURITY DEFINER`, `IMMUTABLE`, `PARALLEL SAFE`, `STRICT`, `LEAKPROOF`, `COST 200`, `ROWS 10`, `SET search_path = public`. Introspection must read these attributes. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`

### T-042: Trigger for_each and when clause
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner tests verifying trigger `for_each` (ROW vs STATEMENT) and `when` clause (PRD §4.1) produce correct SQL: `FOR EACH ROW`, `FOR EACH STATEMENT`, `WHEN (condition)`. Add drift tests verifying differences in for_each or when clause are detected. Add executor integration test. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `drift.test.ts`

## Milestone 16: Coverage Gaps — Role, Grant & Policy Options

### T-043: Role attributes in SQL generation
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add planner and executor tests for all role attributes from PRD §4.6: `login`, `superuser`, `createdb`, `createrole`, `inherit`, `bypassrls`, `replication`, `connection_limit`. Planner must produce `CREATE ROLE ... LOGIN CREATEDB CONNECTION LIMIT 10` etc. Introspection must read all attributes (currently only reads `login`). Drift must detect attribute differences. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`, `drift.test.ts`

### T-044: Grant with_grant_option
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner and executor tests for `with_grant_option: true` on grants (PRD §4.1). Planner must produce `GRANT ... WITH GRANT OPTION` SQL. Introspection must detect whether a grant has WITH GRANT OPTION. Drift must report differences. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `drift.test.ts`

### T-045: Policy permissive flag
- **Status**: TODO
- **Depends**: T-009, T-008
- **Description**: Add planner and executor tests for the `permissive` flag on RLS policies (PRD §4.1). Planner must produce `CREATE POLICY ... AS PERMISSIVE` or `AS RESTRICTIVE`. Introspection must read the permissive/restrictive flag. Drift must detect when the flag differs. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `introspect.test.ts`, `drift.test.ts`

### T-046: View grants
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner and executor tests for grants on views (PRD §4.4). Planner must produce `grant_table` operations for views with `grants` field. Executor must execute `GRANT SELECT ON view TO role`. Add drift test for view grant differences. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`, `drift.test.ts`

## Milestone 17: Coverage Gaps — CLI & Safety Features

### T-047: drift --apply execution
- **Status**: TODO
- **Depends**: T-012, T-010
- **Description**: Add integration test for `drift --apply` (PRD §6, §10). When drift is detected, `--apply` should generate fix operations and execute them. Test that after `drift --apply`, re-running drift shows no differences. Test that destructive fixes require `--allow-destructive`. Implement the apply logic in the drift pipeline if missing.
- **Produces**: Tests in `drift.test.ts` or `cli.test.ts`, possibly updated `src/drift/index.ts`

### T-048: Extension drop requires --allow-destructive
- **Status**: TODO
- **Depends**: T-009
- **Description**: Add planner test verifying that `drop_extension` is blocked by default and requires `--allow-destructive` (PRD §8.1). If the planner doesn't block extension drops, add the logic. Also test `disable_rls` and `drop_trigger` blocking since they're listed in PRD §8.1.
- **Produces**: Tests in `planner.test.ts`

### T-049: Intermediate state recovery
- **Status**: TODO
- **Depends**: T-010, T-021
- **Description**: Add tests for intermediate state recovery (PRD §8.4). Test that re-running migration after interruption picks up where it left off (file tracker skips already-applied files). Test detection and cleanup of invalid indexes left by failed CONCURRENTLY operations. Implement any missing logic.
- **Produces**: Tests in `executor.test.ts`

### T-050: Expand/contract YAML-driven in normal run
- **Status**: TODO
- **Depends**: T-015, T-009
- **Description**: Add integration test verifying that the `expand` field on a column in YAML (PRD §4.1, §11.3) triggers expand operations during a normal `simplicity-schema run` (not just via explicit expand commands). The planner should detect `expand: { from, transform }` and produce expand_column, create_dual_write_trigger, and backfill_column operations as part of the standard migration plan. Implement any missing logic.
- **Produces**: Tests in `planner.test.ts`, `executor.test.ts`

### T-051: --env flag E2E
- **Status**: TODO
- **Depends**: T-011, T-001
- **Description**: Add E2E test verifying that `--env staging` CLI flag selects the correct environment block from `simplicity-schema.config.yaml` and merges it with defaults. Test that environment-specific connectionString, lockTimeout, and statementTimeout override the default values. Implement any missing config merging logic.
- **Produces**: Tests in `cli.test.ts` or `config.test.ts`
