---
title: Commands
description: All CLI commands and their usage.
---

:::note
All examples use `npx`. You can also use `pnpm dlx @smplcty/schema-flow` instead.
:::

## Migration

### `schema-flow run`

Run full migration pipeline: pre-scripts, schema migration, post-scripts.

```bash
npx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```

### `schema-flow run pre`

Run only pre-scripts (SQL files in `schema/pre/`).

### `schema-flow run migrate`

Run only the schema migration phase (YAML diffing and DDL execution).

### `schema-flow run post`

Run only post-scripts (SQL files in `schema/post/`).

### `schema-flow plan`

Dry-run. Shows planned operations without executing. Equivalent to `run --dry-run`.

```bash
npx @smplcty/schema-flow plan --db postgresql://user:pass@localhost:5432/mydb
```

### `schema-flow validate`

Execute the migration plan inside a transaction that is always rolled back. Verifies SQL validity without making changes.

### `schema-flow baseline`

Mark the current database state as baseline. Records all current schema files in the history table without running any migrations. Use when adopting schema-flow on an existing database.

```bash
npx @smplcty/schema-flow baseline --db postgresql://user:pass@localhost:5432/mydb
```

## Analysis

### `schema-flow drift`

Compare YAML definitions to the live database. Reports differences without making changes.

```bash
npx @smplcty/schema-flow drift --db postgresql://user:pass@localhost:5432/mydb
```

### `schema-flow drift --apply`

Detect drift and generate + execute a migration plan to fix all differences. Destructive fixes require `--allow-destructive`.

### `schema-flow lint`

Static analysis of the migration plan. Warns about dangerous patterns like direct `SET NOT NULL`, dropping columns, type narrowing, missing FK indexes.

### `schema-flow status`

Show migration status: number of applied files, pending changes, and history.

## Generation

### `schema-flow generate`

Introspect an existing database and generate YAML files.

```bash
npx @smplcty/schema-flow generate --db postgresql://user:pass@localhost:5432/mydb --output-dir ./schema
npx @smplcty/schema-flow generate --db postgresql://... --seeds users,roles  # include seed data
```

### `schema-flow sql`

Generate a standalone `.sql` migration file from the current plan.

```bash
npx @smplcty/schema-flow sql --output migration.sql --db postgresql://user:pass@localhost:5432/mydb
```

Output includes transaction grouping, `CONCURRENTLY` operations outside transactions, phase comments, and blocked operations as comments.

### `schema-flow erd`

Generate a Mermaid ER diagram from YAML definitions.

```bash
npx @smplcty/schema-flow erd --output schema.mmd
```

### `schema-flow init`

Create the standard project directory structure.

```bash
npx @smplcty/schema-flow init --dir ./schema
```

### `schema-flow new pre|post|mixin`

Create timestamped templates.

```bash
npx @smplcty/schema-flow new pre --name cleanup
npx @smplcty/schema-flow new post --name refresh-views
npx @smplcty/schema-flow new mixin --name timestamps
```

### `schema-flow docs`

Print the YAML format reference to stdout.

## Rollback & expand/contract

### `schema-flow down`

Rollback to the previous migration snapshot. See [rollback](/schema-flow/safety/rollback/).

### `schema-flow backfill`

Drain pending expand-column backfills out-of-band. Idempotent and resumable; safe to kill and restart, safe to background via `nohup` / systemd / k8s. Foreground; sequential by default.

```bash
npx @smplcty/schema-flow backfill                       # drain all pending
npx @smplcty/schema-flow backfill --table users         # one table only
npx @smplcty/schema-flow backfill --column users.email_lower
npx @smplcty/schema-flow backfill --concurrency 4       # opt-in parallelism
```

| Flag                 | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `--table <name>`     | Only backfill columns belonging to this table         |
| `--column <tbl.col>` | Only backfill this specific column                    |
| `--concurrency N`    | Backfills to run in parallel (default: 1, sequential) |

### `schema-flow contract`

Complete the contract phase of an expand/contract migration. Drops the old column and dual-write trigger. Requires `--allow-destructive`.

**Refuses by default** unless every row satisfies `new_col IS NOT DISTINCT FROM transform(old_col)` — i.e. backfill is complete. The error reports the row count remaining.

| Flag                       | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `--force`                  | Drop the old column even if rows still diverge        |
| `--i-understand-data-loss` | Required alongside `--force` (data-loss confirmation) |

### `schema-flow expand-status`

Show status of in-progress expand/contract migrations, including per-state rows remaining for expanded columns.

## Utility

### `schema-flow help`

Show help text.

### `schema-flow --version`

Show version number.
