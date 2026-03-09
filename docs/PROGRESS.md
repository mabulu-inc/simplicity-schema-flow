# Progress Log

## Current State

<!-- Updated by each Ralph Loop iteration. Read this FIRST. -->

Last completed task: T-008 (Database introspection)
Next eligible task: T-009 (Planner / diff engine)

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
