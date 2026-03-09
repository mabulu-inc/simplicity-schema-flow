# Task List

## Milestone 1: Reverse-Engineer schema-flow

### T-001: Architecture overview
- **Status**: TODO
- **Depends**: (none)
- **Description**: Map schema-flow's high-level architecture — modules, data flow, execution phases. Document the pipeline: YAML → parse → plan → execute.
- **Source**: `../schema-flow/src/index.ts`, all module directories
- **Produces**: `docs/specs/architecture.md`

### T-002: YAML schema types and parser
- **Status**: TODO
- **Depends**: T-001
- **Description**: Document all YAML schema types (TableSchema, FunctionSchema, FunctionArg, EnumSchema, ViewSchema, etc.) and how the parser validates/transforms them. Include the full type hierarchy.
- **Source**: `../schema-flow/src/schema/types.ts`, `../schema-flow/src/schema/parser.ts`
- **Produces**: `docs/specs/schema-types.md`

### T-003: Config and database core
- **Status**: TODO
- **Depends**: T-001
- **Description**: Document the config system (resolveConfig, SchemaFlowConfig), connection pool management (closePool, withClient, withTransaction), file discovery, and the file tracker.
- **Source**: `../schema-flow/src/core/`
- **Produces**: `docs/specs/core.md`

### T-004: Database introspection
- **Status**: TODO
- **Depends**: T-001
- **Description**: Document how schema-flow reads current DB state — introspectTable, getExistingFunctions, getExistingEnums, etc. Map every pg_catalog query and what data structures they produce.
- **Source**: `../schema-flow/src/introspect/index.ts`
- **Produces**: `docs/specs/introspect.md`

### T-005: Planner / diff engine
- **Status**: TODO
- **Depends**: T-002, T-004
- **Description**: Document the planner — how it diffs YAML schemas against introspected DB state to produce Operations. Cover table creation, column add/drop/alter, index management, FK handling, enum values, function grants, RLS policies, triggers, ZDM patterns.
- **Source**: `../schema-flow/src/planner/index.ts`
- **Produces**: `docs/specs/planner.md`

### T-006: Executor and migration phases
- **Status**: TODO
- **Depends**: T-005
- **Description**: Document the executor — how it runs operations in transactions, the phase ordering (pre-scripts → enums → functions → tables → triggers/policies/grants → post-scripts), advisory locking, dry-run mode, validate mode.
- **Source**: `../schema-flow/src/executor/index.ts`
- **Produces**: `docs/specs/executor.md`

### T-007: Drift detection
- **Status**: TODO
- **Depends**: T-004, T-005
- **Description**: Document drift detection — how it compares YAML to DB for tables, columns, indexes, functions, enums, views, roles, grants, seeds. Document the DriftReport format.
- **Source**: `../schema-flow/src/drift/`
- **Produces**: `docs/specs/drift.md`

### T-008: Scaffold, rollback, and secondary features
- **Status**: TODO
- **Depends**: T-001
- **Description**: Document scaffold (DB → YAML generation), rollback/snapshot system, expand/contract (ZDM column migrations), SQL file generation, ERD generation, lint rules.
- **Source**: `../schema-flow/src/scaffold/`, `../schema-flow/src/rollback/`, `../schema-flow/src/expand/`, `../schema-flow/src/sql/`, `../schema-flow/src/erd/`, `../schema-flow/src/lint/`
- **Produces**: `docs/specs/secondary-features.md`

### T-009: CLI and public API
- **Status**: TODO
- **Depends**: T-006, T-008
- **Description**: Document the CLI commands and the public API surface exported from index.ts. Map every exported function/type and its purpose.
- **Source**: `../schema-flow/src/cli/index.ts`, `../schema-flow/src/index.ts`
- **Produces**: `docs/specs/cli-and-api.md`

### T-010: Test patterns and test infrastructure
- **Status**: TODO
- **Depends**: T-006
- **Description**: Document the test infrastructure — useTestProject helper, writeSchema, migrate/drift helpers, how tests create isolated PG schemas, the testing module exports. Catalog test coverage by feature.
- **Source**: `../schema-flow/src/testing/index.ts`, `../schema-flow/test/`, `../schema-flow/examples/`
- **Produces**: `docs/specs/test-infrastructure.md`
