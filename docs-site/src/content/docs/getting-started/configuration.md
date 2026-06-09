---
title: Configuration
description: Config resolution, config file, and environment variables.
---

## Resolution order

Configuration is resolved in priority order (highest first):

1. **CLI flags** -- `--connection-string`, `--dir`, `--schema`, etc.
2. **Config file** -- `schema-flow.config.yaml`
3. **Environment variables** -- `SCHEMA_FLOW_DATABASE_URL`, then `DATABASE_URL`
4. **Convention defaults** -- `./schema` directory, `public` schema

## Config file

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

- `${VAR}` syntax interpolates environment variables
- `--env production` selects an environment
- `default` section applies to all environments; environment-specific values override

## All options

| Option             | CLI flag                      | Default      | Description                                                 |
| ------------------ | ----------------------------- | ------------ | ----------------------------------------------------------- |
| `connectionString` | `--connection-string`, `--db` | env vars     | PostgreSQL connection string                                |
| `baseDir`          | `--dir`                       | `./schema`   | Root schema directory                                       |
| `pgSchema`         | `--schema`                    | `public`     | Target PostgreSQL schema                                    |
| `dryRun`           | `--dry-run`                   | `false`      | Plan only, don't execute                                    |
| `allowDestructive` | `--allow-destructive`         | `false`      | Allow drops and destructive changes                         |
| `skipChecks`       | `--skip-checks`               | `false`      | Skip pre-migration checks                                   |
| `lockTimeout`      | `--lock-timeout`              | `5000` (ms)  | Lock acquisition timeout                                    |
| `statementTimeout` | `--statement-timeout`         | `30000` (ms) | Statement execution timeout                                 |
| `maxRetries`       | `--max-retries`               | `3`          | Max retries on transient errors                             |
| `perTxSqlPath`     | `--per-tx-sql`                | unset        | SQL injected at the start of every executor transaction     |
| `bootstrapSession` | --                            | unset        | GUCs set (as `SET LOCAL`) during the bootstrap transaction  |
| `imports`          | --                            | unset        | Packages whose `schema/` is merged in — see below           |
| `historyTable`     | --                            | `history`    | Migration tracking table (in `_smplcty_schema_flow` schema) |
| `verbose`          | `--verbose`                   | `false`      | Verbose output                                              |
| `quiet`            | `--quiet`                     | `false`      | Suppress non-error output                                   |
| `json`             | `--json`                      | `false`      | JSON output                                                 |

## Bootstrap session settings

`bootstrapSession` is a config-file-only map of session settings applied (as `SET LOCAL`) for the duration of the [bootstrap transaction](/simplicity-schema-flow/schema/tables/#bootstrap-phase), alongside the built-in `smplcty.bootstrap = 'true'`. Point it at a GUC your own triggers already check so bootstrap seeds behave the way you need without touching the trigger:

```yaml
default:
  bootstrapSession:
    app.audit_lenient: true
```

## Imports

`imports` is a top-level config key (sibling to `default`/`environments`) listing packages whose `schema/` directories are merged with your local schema. See [Imports & extend](/simplicity-schema-flow/schema/imports/) for the full reference.

```yaml
imports:
  - '@smplcty/auth'
  - '@smplcty/schema-std'

default:
  pgSchema: public
```
