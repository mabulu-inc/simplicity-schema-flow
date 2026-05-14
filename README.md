# @smplcty/schema-flow

Declarative PostgreSQL schema management. Define your database in YAML, diff against live state, generate and execute minimal SQL to converge.

## Setup

Install or run directly with `npx`:

```bash
npx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```

Or with pnpm:

```bash
pnpm dlx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```

## How it works

1. You describe tables, enums, functions, views, roles, and extensions in YAML files under `schema/`
2. The tool introspects your live PostgreSQL database
3. It diffs desired state (YAML) vs actual state (DB) and produces a migration plan
4. It executes the plan with safety rails: advisory locking, `NOT VALID` constraints, `CONCURRENTLY` indexes, transactional DDL

No migration files to manage. No up/down scripts. Just declare the end state.

**Idempotent pipeline** — Every generated DDL statement is safe to re-run. Running the pipeline twice with no schema changes produces no errors and no side-effects.

## Quick start

```bash
# Initialize project structure
npx @smplcty/schema-flow init --dir ./schema

# Define a table
cat > schema/tables/users.yaml << 'EOF'
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
  - name: name
    type: text
    nullable: false
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
indexes:
  - columns: [email]
    unique: true
EOF

# Preview what will happen
npx @smplcty/schema-flow plan --db postgresql://user:pass@localhost:5432/mydb

# Run the migration
npx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```

## Directory layout

```
schema/
├── extensions.yaml          # PostgreSQL extensions
├── tables/                  # One YAML per table
│   ├── users.yaml
│   └── orders.yaml
├── enums/                   # One YAML per enum type
│   └── order_status.yaml
├── functions/               # One YAML per function
│   └── update_timestamp.yaml
├── views/                   # Regular and materialized views
│   ├── active_users.yaml
│   └── user_stats.yaml
├── roles/                   # Database roles
│   └── app_readonly.yaml
├── mixins/                  # Reusable schema fragments
│   └── timestamps.yaml
├── pre/                     # SQL scripts run before migration
│   └── 001_cleanup.sql
└── post/                    # SQL scripts run after migration
    └── 001_refresh_views.sql
```

## CLI commands

### Migration

| Command                                | Description                             |
| -------------------------------------- | --------------------------------------- |
| `npx @smplcty/schema-flow run`         | Full migration (pre -> migrate -> post) |
| `npx @smplcty/schema-flow run pre`     | Pre-scripts only                        |
| `npx @smplcty/schema-flow run migrate` | Schema migration only                   |
| `npx @smplcty/schema-flow run post`    | Post-scripts only                       |
| `npx @smplcty/schema-flow plan`        | Dry-run: show plan without executing    |
| `npx @smplcty/schema-flow validate`    | Execute in rolled-back transaction      |
| `npx @smplcty/schema-flow baseline`    | Mark current DB as baseline             |

### Analysis

| Command                                  | Description                       |
| ---------------------------------------- | --------------------------------- |
| `npx @smplcty/schema-flow drift`         | Compare YAML to live DB           |
| `npx @smplcty/schema-flow drift --apply` | Fix detected drift                |
| `npx @smplcty/schema-flow lint`          | Static analysis of migration plan |
| `npx @smplcty/schema-flow status`        | Applied files and pending changes |

### Generation

| Command                                                | Description                        |
| ------------------------------------------------------ | ---------------------------------- |
| `npx @smplcty/schema-flow generate`                    | Generate YAML from existing DB     |
| `npx @smplcty/schema-flow sql --output migration.sql`  | Export plan as SQL file            |
| `npx @smplcty/schema-flow erd --output schema.mmd`     | Generate Mermaid ER diagram        |
| `npx @smplcty/schema-flow init`                        | Create project directory structure |
| `npx @smplcty/schema-flow new pre --name cleanup`      | Create pre-script template         |
| `npx @smplcty/schema-flow new post --name refresh`     | Create post-script template        |
| `npx @smplcty/schema-flow new mixin --name timestamps` | Create mixin template              |

### Rollback & expand/contract

| Command                                  | Description                                                   |
| ---------------------------------------- | ------------------------------------------------------------- |
| `npx @smplcty/schema-flow down`          | Rollback to previous snapshot                                 |
| `npx @smplcty/schema-flow backfill`      | Drain pending expand-column backfills (resumable, foreground) |
| `npx @smplcty/schema-flow contract`      | Complete expand/contract migration                            |
| `npx @smplcty/schema-flow expand-status` | Show in-progress expand migrations + rows remaining           |

### Global flags

```
--connection-string, --db   PostgreSQL connection string
--dir                       Schema directory (default: ./schema)
--schema                    Target PG schema (default: public)
--env                       Config file environment
--allow-destructive         Allow drops and destructive changes
--dry-run                   Plan only
--skip-checks               Skip pre-migration checks
--lock-timeout              Lock timeout in ms (default: 5000)
--statement-timeout         Statement timeout in ms (default: 30000)
--max-retries               Retries on transient errors (default: 3)
--verbose                   Verbose output
--quiet                     Suppress non-error output
--json                      JSON output
```

## Configuration

Config is resolved in priority order: CLI flags > config file > env vars > defaults.

### Environment variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
# or
SCHEMA_FLOW_DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
```

### Config file

Optional `schema-flow.config.yaml` at project root:

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

Select with `--env production`.

## TypeScript API

```typescript
import { resolveConfig, runAll, buildPlan, detectDrift, lintPlan, createLogger } from '@smplcty/schema-flow';

const config = resolveConfig({ connectionString: process.env.DATABASE_URL });
const logger = createLogger({ verbose: true });

// Run full migration
const result = await runAll(config, logger);

// Or just plan
const plan = await buildPlan(config, logger);
console.log(plan.operations);
```

### Testing helpers

```typescript
import { useTestProject, writeSchema } from '@smplcty/schema-flow/testing';

const project = await useTestProject(process.env.DATABASE_URL);

writeSchema(project.dir, {
  'tables/users.yaml': `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
`,
});

const result = await project.migrate();
// assert against result...

await project.cleanup(); // drops isolated test database
```

## Zero-downtime column rename

Rename a column without locking the table, dropping writes, or coordinating a stop-the-world deploy. The `expand` keyword with an identity transform is the canonical pattern.

```yaml
# schema/tables/users.yaml
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: middle_name # the old column — keep it for now
    type: text
  - name: middle_name_v2 # the new column
    type: text
    expand:
      from: middle_name
      transform: middle_name # identity → rename, not transform
```

What schema-flow does on the next `run`:

1. Adds the new column (`middle_name_v2`).
2. Installs a guarded dual-write trigger so that any write to `middle_name` mirrors into `middle_name_v2`.
3. Records state in `_smplcty_schema_flow.expand_state`. No row scan, no lock contention.

Operator sequence:

```bash
# Day 1 — ship the additive migration. Fast, regardless of table size.
schema-flow run

# Drain the backfill out-of-band. Idempotent and resumable; safe to background.
nohup schema-flow backfill > backfill.log 2>&1 &
disown

# Check progress whenever.
schema-flow expand-status
#   public.users.middle_name → middle_name_v2: expanded — 1,234 row(s) remaining

# Deploy the app reading + writing the new column. Old code that still writes
# the old column stays in sync via the trigger.

# Once the app is fully cut over and backfill has completed, contract.
# By default, `contract` drops every expanded column whose backfill is
# complete; columns that still have divergent rows are skipped.
# Use `--table` / `--column` to target a single migration during a careful
# rollout, or `--force --i-understand-data-loss` to bypass the gate.
schema-flow contract --allow-destructive

# Cleanup: remove the `expand:` block (and the old column entry) from YAML.
# The next `run` is a no-op.
```

The same invariant — `new IS DISTINCT FROM transform(old)` — gates the trigger, the backfill loop, and the contract check. It is null-safe by construction: identity renames of nullable columns work without infinite-looping or stranding rows.

> Need a non-identity migration (e.g. `lower(email)`, `price_cents → price_dollars`)? Same flow. Optionally set `reverse:` for bidirectional dual-write during the transition.

## Documentation

Full documentation at **[mabulu-inc.github.io/simplicity-schema-flow](https://mabulu-inc.github.io/simplicity-schema-flow/)**:

- **[Schema reference](https://mabulu-inc.github.io/simplicity-schema-flow/schema/tables/)** -- Complete YAML format for every object type
- **[Safety & zero-downtime](https://mabulu-inc.github.io/simplicity-schema-flow/safety/destructive-protection/)** -- Destructive protection, locking, zero-downtime patterns
- **[TypeScript API](https://mabulu-inc.github.io/simplicity-schema-flow/api/overview/)** -- Full programmatic API reference
- **[Architecture](https://mabulu-inc.github.io/simplicity-schema-flow/architecture/pipeline/)** -- Pipeline stages, execution phases, internal schema

## Requirements

- Node.js 20+
- PostgreSQL 14+

## License

See [LICENSE](./LICENSE).
