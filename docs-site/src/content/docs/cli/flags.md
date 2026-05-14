---
title: Global flags
description: Flags available on all CLI commands.
---

All commands accept these flags:

| Flag                        | Description                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `--connection-string <url>` | PostgreSQL connection string                                                                  |
| `--db <url>`                | Alias for `--connection-string`                                                               |
| `--dir <path>`              | Root schema directory (default: `./schema`)                                                   |
| `--schema <name>`           | Target PostgreSQL schema (default: `public`)                                                  |
| `--env <name>`              | Config file environment to use                                                                |
| `--allow-destructive`       | Allow drops and destructive changes                                                           |
| `--dry-run`                 | Plan only, don't execute                                                                      |
| `--skip-checks`             | Skip pre-migration checks                                                                     |
| `--lock-timeout <ms>`       | Lock acquisition timeout (default: `5000`)                                                    |
| `--statement-timeout <ms>`  | Statement execution timeout (default: `30000`)                                                |
| `--max-retries <n>`         | Max retries on transient errors (default: `3`)                                                |
| `--per-tx-sql <path>`       | SQL injected at the start of every executor transaction (e.g. `SET LOCAL` for audit triggers) |
| `--verbose`                 | Verbose output                                                                                |
| `--quiet`                   | Suppress non-error output                                                                     |
| `--json`                    | Output in JSON format                                                                         |
| `--version`                 | Show version                                                                                  |
| `--help`                    | Show help                                                                                     |

## Examples

```bash
# Use a specific database
npx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb

# Production with longer timeouts
npx @smplcty/schema-flow run --env production --lock-timeout 3000 --statement-timeout 60000

# Allow dropping columns/tables
npx @smplcty/schema-flow run --allow-destructive

# Preview changes in JSON format
npx @smplcty/schema-flow plan --json

# Quiet mode for CI
npx @smplcty/schema-flow run --quiet

# Set an actor for audit triggers across every transaction (pre-scripts, seeds, post-scripts, tighten)
npx @smplcty/schema-flow run --per-tx-sql ./scripts/set-audit-actor.sql
```
