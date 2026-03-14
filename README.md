# @mabulu-inc/simplicity-schema

Declarative PostgreSQL schema management. Define your database in YAML, diff against live state, generate and execute minimal SQL to converge.

```
npm install @mabulu-inc/simplicity-schema
```

## How it works

1. You describe tables, enums, functions, views, roles, and extensions in YAML files under `schema/`
2. The tool introspects your live PostgreSQL database
3. It diffs desired state (YAML) vs actual state (DB) and produces a migration plan
4. It executes the plan with safety rails: advisory locking, `NOT VALID` constraints, `CONCURRENTLY` indexes, transactional DDL

No migration files to manage. No up/down scripts. Just declare the end state.

## Quick start

```bash
# Initialize project structure
simplicity-schema init --dir ./schema

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
simplicity-schema plan --db postgresql://user:pass@localhost:5432/mydb

# Run the migration
simplicity-schema run --db postgresql://user:pass@localhost:5432/mydb
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

| Command                         | Description                             |
| ------------------------------- | --------------------------------------- |
| `simplicity-schema run`         | Full migration (pre -> migrate -> post) |
| `simplicity-schema run pre`     | Pre-scripts only                        |
| `simplicity-schema run migrate` | Schema migration only                   |
| `simplicity-schema run post`    | Post-scripts only                       |
| `simplicity-schema plan`        | Dry-run: show plan without executing    |
| `simplicity-schema validate`    | Execute in rolled-back transaction      |
| `simplicity-schema baseline`    | Mark current DB as baseline             |

### Analysis

| Command                           | Description                       |
| --------------------------------- | --------------------------------- |
| `simplicity-schema drift`         | Compare YAML to live DB           |
| `simplicity-schema drift --apply` | Fix detected drift                |
| `simplicity-schema lint`          | Static analysis of migration plan |
| `simplicity-schema status`        | Applied files and pending changes |

### Generation

| Command                                         | Description                        |
| ----------------------------------------------- | ---------------------------------- |
| `simplicity-schema generate`                    | Generate YAML from existing DB     |
| `simplicity-schema sql --output migration.sql`  | Export plan as SQL file            |
| `simplicity-schema erd --output schema.mmd`     | Generate Mermaid ER diagram        |
| `simplicity-schema init`                        | Create project directory structure |
| `simplicity-schema new pre --name cleanup`      | Create pre-script template         |
| `simplicity-schema new post --name refresh`     | Create post-script template        |
| `simplicity-schema new mixin --name timestamps` | Create mixin template              |

### Rollback & expand/contract

| Command                           | Description                        |
| --------------------------------- | ---------------------------------- |
| `simplicity-schema down`          | Rollback to previous snapshot      |
| `simplicity-schema contract`      | Complete expand/contract migration |
| `simplicity-schema expand-status` | Show in-progress expand migrations |

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
SIMPLICITY_SCHEMA_DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
```

### Config file

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

Select with `--env production`.

## TypeScript API

```typescript
import { resolveConfig, runAll, buildPlan, detectDrift, lintPlan, createLogger } from '@mabulu-inc/simplicity-schema';

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
import { useTestProject, writeSchema } from '@mabulu-inc/simplicity-schema/testing';

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

## Documentation

Full documentation at **[mabulu-inc.github.io/simplicity-schema](https://mabulu-inc.github.io/simplicity-schema/)**:

- **[Schema reference](https://mabulu-inc.github.io/simplicity-schema/schema/tables/)** -- Complete YAML format for every object type
- **[Safety & zero-downtime](https://mabulu-inc.github.io/simplicity-schema/safety/destructive-protection/)** -- Destructive protection, locking, zero-downtime patterns
- **[TypeScript API](https://mabulu-inc.github.io/simplicity-schema/api/overview/)** -- Full programmatic API reference
- **[Architecture](https://mabulu-inc.github.io/simplicity-schema/architecture/pipeline/)** -- Pipeline stages, execution phases, internal schema

## Requirements

- Node.js 20+
- PostgreSQL 14+

## License

See [LICENSE](./LICENSE).
