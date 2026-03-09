# simplicity-schema — Product Requirements Document

## 1. Overview

`@mabulu-inc/simplicity-schema` is a **declarative PostgreSQL schema management tool**. Users define their desired database state in YAML files; the tool diffs that desired state against the live database and generates + executes the minimal SQL to converge.

### Design Principles

- **Declarative** — Describe _what_ the database should look like, not _how_ to get there
- **Safe by default** — Destructive operations blocked unless explicitly allowed; advisory locking prevents concurrent runs
- **Zero-downtime capable** — NOT VALID constraints, CONCURRENTLY indexes, expand/contract column migrations
- **Convention over configuration** — Works out of the box with a standard `schema/` directory layout
- **Clean internals** — Tool state lives in a dedicated `_simplicity` PostgreSQL schema, separate from user objects
- **Dual interface** — Full CLI for operators + TypeScript API for programmatic use

### Package Details

- **Package name**: `@mabulu-inc/simplicity-schema`
- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode)
- **Core dependencies**: `pg`, `yaml`, `glob`, `chalk`
- **Exports**: Main API (`./`) + Testing helpers (`./testing`)
- **Binary**: `simplicity-schema`

---

## 2. Internal Schema: `_simplicity`

simplicity-schema uses a dedicated PostgreSQL schema named **`_simplicity`** for its own internal bookkeeping. User-defined objects (tables, enums, functions, views, etc.) go into whatever schema the developer configures via `pgSchema` (default: `public`).

### What Lives in `_simplicity`

- **`_simplicity.history`** — File tracking table (applied migrations, hashes, timestamps)
- **`_simplicity.expand_state`** — Expand/contract migration state tracker
- **`_simplicity.snapshots`** — Rollback snapshots

The tool creates this schema automatically on first run: `CREATE SCHEMA IF NOT EXISTS _simplicity`.

### What Lives in the User's Target Schema

All objects defined in YAML are created in the configured `pgSchema` (default `public`):

- Tables, enums, functions, views, materialized views, triggers, policies, grants, comments, seeds

### Why Separate

- **No collisions** — The tool's internal tables never conflict with user-defined objects, even if the user has a table named `history` or `snapshots`
- **Clean uninstall** — `DROP SCHEMA _simplicity CASCADE` removes all tool state without touching user data
- **Clear ownership** — `_simplicity.*` is always tool-managed; everything in the user's schema is their declared state

---

## 3. Directory Layout

Users organize their schema definitions under a `schema/` directory:

```
schema/
├── extensions.yaml          PostgreSQL extensions to install
├── tables/                  One YAML file per table
│   ├── users.yaml
│   └── orders.yaml
├── enums/                   Enum type definitions
│   └── order_status.yaml
├── functions/               Stored functions / procedures
│   └── update_timestamp.yaml
├── views/                   Regular and materialized views
│   └── active_users.yaml
├── roles/                   Role and group definitions
│   └── app_readonly.yaml
├── mixins/                  Reusable schema fragments
│   └── timestamps.yaml
├── pre/                     SQL scripts that run before schema migration (alphabetical order)
│   └── ensure_extensions.sql
├── post/                    SQL scripts that run after schema migration (alphabetical order)
│   └── refresh_views.sql
```

- **One file per object** for tables, enums, functions, views, roles
- **All files are hash-tracked** — every file (YAML and SQL) is tracked by SHA-256 hash and only re-run when its content changes. There is no distinction between "one-shot" and "repeatable" scripts.
- **Extensions** are defined in a single `extensions.yaml` file

---

## 4. YAML Schema Specifications

### 4.1 Tables

```yaml
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
    unique: true
    comment: "User's primary email address"
  - name: name
    type: text
    nullable: false
  - name: role_id
    type: uuid
    references:
      table: roles
      column: id
      on_delete: SET NULL      # CASCADE | SET NULL | SET DEFAULT | RESTRICT | NO ACTION
      on_update: NO ACTION
      deferrable: false
      initially_deferred: false
  - name: metadata
    type: jsonb
    default: "'{}'::jsonb"
  - name: total
    type: numeric
    generated: "price * quantity"  # GENERATED ALWAYS AS (expr) STORED
  - name: old_email
    type: text
    expand:                    # Zero-downtime column migration
      from: email
      transform: "lower(email)"

primary_key: [id]             # Composite PK alternative to column-level

indexes:
  - columns: [email]
    unique: true
  - name: idx_users_metadata
    columns: [metadata]
    method: gin               # btree (default) | gin | gist | hash | brin
  - columns: [created_at]
    where: "deleted_at IS NULL"   # Partial index
  - columns: [name]
    include: [email]          # Covering index (INCLUDE)
    opclass: text_pattern_ops

checks:
  - name: email_not_empty
    expression: "length(email) > 0"
    comment: "Ensure email is not blank"

unique_constraints:
  - columns: [email, tenant_id]
    name: uq_users_email_tenant

triggers:
  - name: set_updated_at
    timing: BEFORE             # BEFORE | AFTER | INSTEAD OF
    events: [UPDATE]           # INSERT | UPDATE | DELETE | TRUNCATE
    function: update_timestamp
    for_each: ROW              # ROW | STATEMENT
    when: "OLD.* IS DISTINCT FROM NEW.*"

policies:
  - name: users_own_data
    for: SELECT                # SELECT | INSERT | UPDATE | DELETE | ALL
    to: app_user               # Role name
    using: "id = current_setting('app.user_id')::uuid"
    check: "id = current_setting('app.user_id')::uuid"
    permissive: true           # true (PERMISSIVE) | false (RESTRICTIVE)

grants:
  - to: app_readonly
    privileges: [SELECT]
    columns: [id, email, name]  # Column-level grants (optional)
    with_grant_option: false

prechecks:
  - name: ensure_no_orphans
    query: "SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)"
    message: "Orphaned orders exist — fix before migrating"

seeds:
  - id: "00000000-0000-0000-0000-000000000001"
    email: "admin@example.com"
    name: "Admin"

comment: "Core user accounts table"
```

#### Column Types

All PostgreSQL types are supported. Common ones:

| Type | Notes |
|------|-------|
| `uuid` | Recommended for PKs |
| `text` | Variable-length string |
| `varchar(N)` | Bounded string |
| `integer`, `bigint`, `smallint` | Integers |
| `numeric`, `decimal` | Exact numeric |
| `boolean` | true/false |
| `timestamptz` | Timestamp with timezone (preferred) |
| `timestamp` | Timestamp without timezone |
| `date`, `time`, `interval` | Date/time |
| `jsonb`, `json` | JSON data |
| `bytea` | Binary data |
| `text[]`, `integer[]` | Arrays |
| Custom enum names | User-defined enums |

#### Foreign Key Actions

| Action | Behavior |
|--------|----------|
| `CASCADE` | Delete/update child rows |
| `SET NULL` | Set FK column to NULL |
| `SET DEFAULT` | Set FK column to default |
| `RESTRICT` | Prevent if children exist (immediate) |
| `NO ACTION` | Prevent if children exist (deferred, default) |

### 4.2 Enums

```yaml
name: order_status
values:
  - pending
  - processing
  - shipped
  - delivered
  - cancelled
comment: "Order lifecycle states"
```

- Values are **append-only** — new values can be added but existing values cannot be removed or reordered (PostgreSQL limitation)
- Removing a value requires `--allow-destructive`

### 4.3 Functions

```yaml
name: update_timestamp
language: plpgsql              # plpgsql | sql | etc.
returns: trigger
args:
  - name: target_column
    type: text
    mode: IN                   # IN (default) | OUT | INOUT | VARIADIC
    default: "'updated_at'"
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
security: invoker              # invoker (default) | definer
volatility: volatile           # volatile (default) | stable | immutable
parallel: unsafe               # unsafe (default) | safe | restricted
strict: false                  # RETURNS NULL ON NULL INPUT
leakproof: false
cost: 100
rows: 0                        # Estimated rows for set-returning functions
set:                           # SET configuration parameters
  search_path: public
grants:
  - to: app_user
    privileges: [EXECUTE]
comment: "Auto-update timestamp trigger function"
```

### 4.4 Views

```yaml
name: active_users
query: |
  SELECT id, email, name
  FROM users
  WHERE deleted_at IS NULL
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: "Users who have not been soft-deleted"
```

### 4.5 Materialized Views

```yaml
name: user_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM orders
  GROUP BY user_id
indexes:
  - columns: [user_id]
    unique: true
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: "Aggregated user order statistics"
```

### 4.6 Roles

```yaml
role: app_readonly
login: false
superuser: false
createdb: false
createrole: false
inherit: true
bypassrls: false
replication: false
connection_limit: -1           # -1 = unlimited
in: [app_group]                # Group memberships
comment: "Read-only application role"
```

### 4.7 Extensions

```yaml
extensions:
  - pgcrypto
  - pg_trgm
  - uuid-ossp
schema_grants:                 # Optional: grant usage on extension schemas
  - to: app_user
    schemas: [public]
```

### 4.8 Mixins

Mixins define reusable fragments that can be composed into table definitions:

```yaml
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
triggers:
  - name: set_{table}_updated_at    # {table} is replaced with the consuming table name
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
```

Tables reference mixins:

```yaml
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
    primary_key: true
  # ... timestamps columns and triggers are merged in automatically
```

- The `{table}` placeholder in mixin field values is replaced with the consuming table's name
- Mixins can contribute: `columns`, `indexes`, `checks`, `triggers`, `rls` (enable), `policies`, `grants`

---

## 5. Configuration

### 5.1 Resolution Order

Configuration values are resolved in priority order (highest first):

1. **CLI flags** — `--connection-string`, `--dir`, `--schema`, etc.
2. **Config file** — `simplicity-schema.config.yaml`
3. **Environment variables** — `SIMPLICITY_SCHEMA_DATABASE_URL`, then `DATABASE_URL`
4. **Convention defaults** — Standard directory layout, `public` schema

### 5.2 Config File

Optional `simplicity-schema.config.yaml` at project root:

```yaml
default:
  connectionString: ${DATABASE_URL}
  pgSchema: public
  lockTimeout: 5000
  statementTimeout: 30000

environments:
  staging:
    connectionString: ${STAGING_DATABASE_URL}
  production:
    connectionString: ${PRODUCTION_DATABASE_URL}
    lockTimeout: 3000
    statementTimeout: 60000
```

- Environment variable interpolation via `${VAR}` syntax
- Select environment with `--env` flag
- `default` section applies to all environments; environment-specific values override

### 5.3 Configuration Options

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| `connectionString` | `--connection-string`, `--db` | env vars | PostgreSQL connection string |
| `baseDir` | `--dir` | `./schema` | Root schema directory |
| `pgSchema` | `--schema` | `public` | Target PostgreSQL schema for user-defined objects |
| `dryRun` | `--dry-run` | `false` | Plan only, don't execute |
| `allowDestructive` | `--allow-destructive` | `false` | Allow drops and destructive changes |
| `skipChecks` | `--skip-checks` | `false` | Skip pre-migration checks |
| `lockTimeout` | `--lock-timeout` | `5000` (ms) | Lock acquisition timeout |
| `statementTimeout` | `--statement-timeout` | `30000` (ms) | Statement execution timeout |
| `maxRetries` | `--max-retries` | `3` | Max retries on transient errors |
| `historyTable` | — | `history` | Migration tracking table name (always in `_simplicity` schema) |
| `verbose` | `--verbose` | `false` | Verbose output |
| `quiet` | `--quiet` | `false` | Suppress non-error output |
| `json` | `--json` | `false` | Output in JSON format |

---

## 6. CLI Commands

### 6.1 Core Migration

| Command | Description |
|---------|-------------|
| `simplicity-schema run` | Run full migration (pre → migrate → post) |
| `simplicity-schema run pre` | Run only pre-scripts |
| `simplicity-schema run migrate` | Run only schema migration phase |
| `simplicity-schema run post` | Run only post-scripts |
| `simplicity-schema plan` | Dry-run — show planned operations without executing |
| `simplicity-schema validate` | Execute plan in a rollback transaction to verify SQL validity |
| `simplicity-schema baseline` | Mark current DB state as baseline (create history entries without running migrations) |

### 6.2 Analysis

| Command | Description |
|---------|-------------|
| `simplicity-schema drift` | Compare YAML definitions to live DB; report differences |
| `simplicity-schema lint` | Static analysis of migration plan for dangerous patterns |
| `simplicity-schema status` | Show migration status (applied files, pending changes) |

### 6.3 Generation

| Command | Flags | Description |
|---------|-------|-------------|
| `simplicity-schema generate` | `--output-dir`, `--seeds` | Generate YAML from existing database |
| `simplicity-schema sql` | `--output` | Generate standalone `.sql` migration file from plan |
| `simplicity-schema erd` | `--output` | Generate Mermaid ER diagram from YAML |
| `simplicity-schema new pre` | `--name` | Create timestamped pre-script template |
| `simplicity-schema new post` | `--name` | Create timestamped post-script template |
| `simplicity-schema new mixin` | `--name` | Create mixin template |
| `simplicity-schema init` | — | Initialize a new schema project directory |

### 6.4 Rollback & Expand/Contract

| Command | Description |
|---------|-------------|
| `simplicity-schema down` | Rollback to previous migration snapshot |
| `simplicity-schema contract` | Complete contract phase of expand/contract migration |
| `simplicity-schema expand-status` | Show status of in-progress expand/contract migrations |

### 6.5 Utility

| Command | Description |
|---------|-------------|
| `simplicity-schema docs` | Open documentation |
| `simplicity-schema help` | Show help |
| `simplicity-schema --version` | Show version |

### 6.6 Global Flags

All commands accept: `--connection-string`, `--db`, `--dir`, `--schema`, `--env`, `--verbose`, `--quiet`, `--json`, `--lock-timeout`, `--statement-timeout`, `--max-retries`, `--allow-destructive`, `--skip-checks`

The `--apply` flag on `drift` will apply fixes for detected drift.

---

## 7. Migration Pipeline

### 7.1 Pipeline Stages

```
DISCOVER → PARSE → EXPAND → INTROSPECT → PLAN → EXECUTE
```

1. **Discover** — Glob for YAML files in each conventional subdirectory; glob for SQL files in pre/, post/
2. **Parse** — Read each YAML file into typed schema objects; validate required fields and apply defaults
3. **Expand** — Load mixin definitions; merge mixin columns, indexes, triggers, policies, grants into consuming table schemas; substitute `{table}` placeholders
4. **Introspect** — Query `pg_catalog` and `information_schema` filtered to the target `pgSchema` to read current DB state: tables, columns, data types, constraints, indexes, triggers, enums, functions, views, materialized views, roles, grants, comments
5. **Plan** — Diff desired (YAML) state vs. actual (DB) state; produce an ordered list of operations
6. **Execute** — Run operations in phased order within transactions

### 7.2 Execution Phases

Operations execute in strict dependency order:

| Phase | Object Type | Notes |
|-------|-------------|-------|
| 0 | Internal schema | `CREATE SCHEMA IF NOT EXISTS _simplicity` (tool bookkeeping) |
| 1 | Pre-scripts | SQL scripts in `pre/`, alphabetical order |
| 2 | Extensions | `CREATE EXTENSION IF NOT EXISTS` |
| 3 | Enums | `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE` |
| 4 | Roles | `CREATE ROLE`, `ALTER ROLE`, `GRANT` membership |
| 5 | Functions | `CREATE OR REPLACE FUNCTION` |
| 6 | Tables | `CREATE TABLE`, `ALTER TABLE` (columns, checks, unique constraints) — **without FKs** |
| 7 | Indexes | Created outside transaction using `CONCURRENTLY` where possible |
| 8 | Foreign keys | Added as `NOT VALID`, then validated in separate step |
| 9 | Views | `CREATE OR REPLACE VIEW` |
| 10 | Materialized views | `CREATE MATERIALIZED VIEW`, `REFRESH` |
| 11 | Triggers | `CREATE TRIGGER` |
| 12 | RLS policies | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `CREATE POLICY` |
| 13 | Grants | `GRANT`/`REVOKE` on tables, columns, sequences, functions |
| 14 | Comments | `COMMENT ON` for all object types |
| 15 | Seeds | `INSERT ... ON CONFLICT` (upsert) |
| 16 | Post-scripts | SQL scripts in `post/`, alphabetical order |

### 7.3 Operation Types

The planner produces typed `Operation` objects:

**Tables & Columns:**
`create_table`, `drop_table`, `add_column`, `alter_column`, `drop_column`

**Indexes:**
`add_index`, `add_unique_index`, `drop_index`

**Constraints:**
`add_check`, `add_check_not_valid`, `add_foreign_key`, `add_foreign_key_not_valid`, `validate_constraint`, `drop_foreign_key`

**Enums:**
`create_enum`, `add_enum_value`

**Functions:**
`create_function`

**Triggers:**
`create_trigger`, `drop_trigger`

**RLS:**
`enable_rls`, `disable_rls`, `create_policy`, `drop_policy`

**Views:**
`create_view`, `drop_view`, `create_materialized_view`, `drop_materialized_view`, `refresh_materialized_view`

**Extensions:**
`create_extension`, `drop_extension`

**Roles & Grants:**
`create_role`, `alter_role`, `grant_membership`, `grant_table`, `grant_column`, `revoke_table`, `revoke_column`, `grant_sequence`, `revoke_sequence`, `grant_function`, `revoke_function`

**Expand/Contract:**
`expand_column`, `create_dual_write_trigger`, `backfill_column`, `contract_column`, `drop_dual_write_trigger`

**Schema:**
`create_schema`

**Other:**
`set_comment`, `add_seed`, `run_precheck`

---

## 8. Safety & Zero-Downtime

### 8.1 Destructive Operation Protection

The following operations are **blocked by default** and require `--allow-destructive`:

- `drop_table`, `drop_column`, `drop_index`, `drop_foreign_key`
- `drop_view`, `drop_materialized_view`, `drop_extension`
- `disable_rls`, `drop_policy`, `drop_trigger`
- Column type narrowing (e.g., `text` → `varchar(50)`)
- Enum value removal

### 8.2 Concurrency Safety

- **Advisory locking** — Acquire a PostgreSQL advisory lock before running migrations; prevents concurrent migration processes
- **Transactional execution** — DDL runs within transactions; automatic rollback on any error
- **Lock timeout** — Configurable (default 5s); prevents blocking other queries while waiting for locks
- **Statement timeout** — Configurable (default 30s); prevents long-running statements from holding locks
- **Retry on transient errors** — Automatic retry (up to 3x with exponential backoff) on:
  - Lock timeout (`55P03`)
  - Statement timeout / query cancellation (`57014`)
  - Serialization failure (`40001`)
  - Deadlock detected (`40P01`)

### 8.3 Zero-Downtime Patterns

**Foreign keys:**
- Added as `NOT VALID` (no full table scan at creation time)
- Validated in a separate step (`VALIDATE CONSTRAINT`)

**Safe NOT NULL:**
1. Add `CHECK (column IS NOT NULL) NOT VALID`
2. `VALIDATE CONSTRAINT` (scans table without holding ACCESS EXCLUSIVE lock)
3. `ALTER COLUMN SET NOT NULL` (instant — PostgreSQL trusts the validated check)
4. Drop the redundant check constraint

**Safe unique constraints:**
1. `CREATE UNIQUE INDEX CONCURRENTLY` (non-blocking)
2. `ALTER TABLE ADD CONSTRAINT ... USING INDEX` (instant)

**Indexes:**
- Created using `CONCURRENTLY` outside of a transaction where possible

**Expand/Contract column migrations:**
1. Add new column
2. Create dual-write trigger (copies data from old column to new on write)
3. Backfill existing rows
4. Application switches to reading new column
5. Contract: drop old column and trigger (requires `--allow-destructive`)

### 8.4 Intermediate State Recovery

If a migration is interrupted:
- Re-running picks up where it left off (file tracker knows which files were applied)
- Transactional phases either fully commit or fully roll back
- CONCURRENTLY operations that fail leave invalid indexes that can be detected and retried

---

## 9. Lint Rules

Static analysis applied to migration plans before execution:

| Rule | Severity | Description |
|------|----------|-------------|
| `set-not-null-direct` | Warning | Direct `SET NOT NULL` without the safe CHECK pattern |
| `add-column-with-default` | Warning | Adding a column with a volatile default (may lock table on older PG) |
| `drop-column` | Warning | Dropping a column (data loss) |
| `drop-table` | Warning | Dropping a table (data loss) |
| `type-narrowing` | Warning | Narrowing a column type (potential data loss) |
| `missing-fk-index` | Info | Foreign key column without an index (slow joins/cascades) |
| `rename-detection` | Info | Detected possible rename (drop + add with same type) |
| `type-change` | Warning | Changing column type (may require table rewrite) |

---

## 10. Drift Detection

The `drift` command performs a **read-only** comparison of YAML definitions against the live database.

### Drift Report Structure

```typescript
interface DriftReport {
  items: DriftItem[];
  summary: { total: number; byType: Record<string, number> };
}

interface DriftItem {
  type: 'table' | 'column' | 'index' | 'constraint' | 'enum' | 'function' |
        'view' | 'materialized_view' | 'role' | 'grant' | 'trigger' |
        'policy' | 'comment' | 'seed';
  object: string;          // e.g., "users.email"
  status: 'missing_in_db' | 'missing_in_yaml' | 'different';
  expected?: string;       // YAML value
  actual?: string;         // DB value
  detail?: string;         // Human-readable description
}
```

### What's Compared

- Tables: existence, columns, column types/defaults/nullability
- Indexes: existence, columns, uniqueness, method, partial conditions
- Constraints: checks, foreign keys, unique constraints
- Enums: existence, values (order matters)
- Functions: existence, body, args, return type, security/volatility
- Views/Materialized views: existence, query
- Roles: existence, attributes, memberships
- Grants: table-level, column-level, sequence, function
- Triggers, RLS policies, comments, seeds

---

## 11. Secondary Features

### 11.1 Scaffold / Generate

`simplicity-schema generate` introspects an existing database and produces YAML files:

- Generates one YAML file per table, enum, function, view, role
- `--seeds` flag: also generates seed data from existing rows
- `--output-dir` flag: target directory (defaults to `./schema`)
- Useful for bootstrapping simplicity-schema on an existing project

`simplicity-schema init` creates the standard directory structure.

`simplicity-schema new pre|post|mixin --name <name>` creates timestamped templates.

### 11.2 Rollback

- Before each migration run, a `MigrationSnapshot` is captured
- `simplicity-schema down` computes reverse operations from the snapshot and applies them
- Reverse operations: drop added tables/columns, re-add dropped tables/columns, revert altered columns
- Snapshots are stored in the history tracking table

### 11.3 Expand/Contract

Zero-downtime column migrations for type changes, renames, or transforms:

1. **Expand** — Define `expand` on a column in YAML:
   ```yaml
   - name: email_lower
     type: text
     expand:
       from: email
       transform: "lower(email)"
   ```
2. `simplicity-schema run` creates the new column and dual-write trigger
3. Backfill runs to populate existing rows
4. Application switches to using new column
5. `simplicity-schema contract` drops old column and trigger

State tracked via `ExpandTracker` in the history table. `expand-status` shows in-progress migrations.

### 11.4 SQL Generation

`simplicity-schema sql --output migration.sql` renders the migration plan as a standalone SQL file:

- Proper transaction grouping (transactional DDL wrapped in `BEGIN/COMMIT`)
- CONCURRENTLY operations outside transactions
- Comments indicating phase and operation type
- Suitable for review, manual execution, or audit

### 11.5 ERD Generation

`simplicity-schema erd --output schema.mmd` generates a Mermaid ER diagram:

- Tables with column names and types
- Foreign key relationships as edges
- Suitable for embedding in documentation

### 11.6 Pre-migration Checks

Tables can define `prechecks` — SQL queries that must pass before migration proceeds:

```yaml
prechecks:
  - name: no_orphaned_rows
    query: "SELECT count(*) = 0 FROM child WHERE parent_id NOT IN (SELECT id FROM parent)"
    message: "Orphaned rows exist — clean up before migration"
```

If any precheck query returns a falsy value, migration aborts with the provided message.

---

## 12. File Tracking

### History Table: `_simplicity.history`

The history table lives in the `_simplicity` internal schema, separate from user objects.

| Column | Type | Description |
|--------|------|-------------|
| `file_path` | `text` (PK) | Relative path to the schema file |
| `file_hash` | `text` | SHA-256 hash of file contents |
| `phase` | `text` | `pre` / `schema` / `post` |
| `applied_at` | `timestamptz` | When the file was last applied |

### Tracking Rules

All files — YAML and SQL — are tracked by SHA-256 hash. A file is re-run only when its content changes. There is no one-shot vs. repeatable distinction; everything is hash-tracked uniformly.

---

## 13. Public API

The package exports all core functionality for programmatic use from `@mabulu-inc/simplicity-schema`:

### Core

| Export | Description |
|--------|-------------|
| `resolveConfig(opts?)` | Resolve configuration from all sources |
| `withClient(connStr, fn, opts?)` | Execute function with a pooled PG client |
| `withTransaction(connStr, fn, opts?)` | Execute function within a transaction |
| `closePool()` | Shut down the connection pool |
| `testConnection(connStr)` | Verify database connectivity |

### Pipeline

| Export | Description |
|--------|-------------|
| `discoverSchemaFiles(config)` | Find all YAML/SQL files |
| `parseTableFile(path)` | Parse a table YAML file |
| `parseFunctionFile(path)` | Parse a function YAML file |
| `parseEnumFile(path)` | Parse an enum YAML file |
| `parseViewFile(path)` | Parse a view YAML file |
| `parseRoleFile(path)` | Parse a role YAML file |
| `buildPlan(config)` | Run discover → parse → introspect → plan |
| `runAll(config)` | Run full migration |
| `runPre(config)` | Run pre-scripts only |
| `runMigrate(config)` | Run schema migration only |
| `runPost(config)` | Run post-scripts only |
| `runValidate(config)` | Validate plan in rollback transaction |
| `runBaseline(config)` | Record current state as baseline |

### Introspection

| Export | Description |
|--------|-------------|
| `introspectTable(client, table, schema)` | Read table structure from DB |
| `getExistingTables(client, schema)` | List all tables |
| `getExistingEnums(client, schema)` | List all enum types and values |
| `getExistingFunctions(client, schema)` | List all functions |
| `getExistingViews(client, schema)` | List all views |

### Analysis

| Export | Description |
|--------|-------------|
| `detectDrift(config)` | Compare YAML to DB; return DriftReport |
| `lintPlan(plan)` | Run lint rules on a migration plan |

### Rollback & Expand

| Export | Description |
|--------|-------------|
| `computeRollback(snapshot)` | Generate reverse operations |
| `runDown(config)` | Execute rollback |
| `planExpandColumn(config, table, column)` | Plan an expand/contract migration |
| `runBackfill(config, table, column)` | Backfill expanded column |
| `runContract(config, table, column)` | Complete contract phase |

### Generation

| Export | Description |
|--------|-------------|
| `generateFromDb(config)` | Generate YAML from existing DB |
| `generateSqlFile(plan, output)` | Render plan as .sql file |
| `formatMigrationSql(operations)` | Format operations as SQL string |
| `scaffoldInit(dir)` | Create project directory structure |
| `scaffoldPre(dir, name)` | Create pre-script template |
| `scaffoldPost(dir, name)` | Create post-script template |

### Testing (`@mabulu-inc/simplicity-schema/testing`)

| Export | Description |
|--------|-------------|
| `useTestProject(t)` | Create isolated PG schema for a test |
| `writeSchema(dir, files)` | Write YAML files to a temp directory |

### Types

All schema types are exported: `TableSchema`, `ColumnDef`, `IndexDef`, `CheckDef`, `UniqueConstraintDef`, `TriggerDef`, `PolicyDef`, `MixinSchema`, `FunctionSchema`, `FunctionArg`, `EnumSchema`, `ExtensionsSchema`, `ViewSchema`, `MaterializedViewSchema`, `RoleSchema`, `GrantDef`, `FunctionGrantDef`, `PrecheckDef`, `Operation`, `DriftReport`, `DriftItem`, `SimplicitySchemaConfig`

---

## 14. Testing Requirements

- **Real PostgreSQL only** — Never mock the database; all tests run against real PG instances
- **Docker-based** — PostgreSQL runs in a Docker container managed by `docker-compose.yml` in the project root. Never assume a locally-installed PostgreSQL server.
- **Connection** — Tests use the `DATABASE_URL` environment variable. The project provides a `.env.example` with the default; developers copy it to `.env`. The default is `postgresql://postgres:postgres@localhost:54329/postgres` (port 54329 to avoid conflicts with other local Postgres instances).
- **Isolation** — Each test creates its own PostgreSQL schema via `useTestProject`; schemas are cleaned up after tests
- **Pattern** — Tests write YAML to temp directories, run the pipeline, then query PG to verify results
- **Framework** — Vitest
- **Coverage** — Every feature (migration, drift, lint, rollback, expand, scaffold, ERD, SQL generation) must have integration tests

---

## 15. Non-Goals

- Support for databases other than PostgreSQL
- GUI or web interface
- Multi-database orchestration
- Automatic migration scheduling / cron
- Backward compatibility with `@mabulu-inc/schema-flow` configuration or history tables
