---
title: Commands
description: All CLI commands and their usage.
---

:::note
All examples use `npx`. You can also use `pnpm dlx @mabulu-inc/simplicity-schema` instead.
:::

## Migration

### `simplicity-schema run`

Run full migration pipeline: pre-scripts, schema migration, post-scripts.

```bash
npx @mabulu-inc/simplicity-schema run --db postgresql://user:pass@localhost:5432/mydb
```

### `simplicity-schema run pre`

Run only pre-scripts (SQL files in `schema/pre/`).

### `simplicity-schema run migrate`

Run only the schema migration phase (YAML diffing and DDL execution).

### `simplicity-schema run post`

Run only post-scripts (SQL files in `schema/post/`).

### `simplicity-schema plan`

Dry-run. Shows planned operations without executing. Equivalent to `run --dry-run`.

```bash
npx @mabulu-inc/simplicity-schema plan --db postgresql://user:pass@localhost:5432/mydb
```

### `simplicity-schema validate`

Execute the migration plan inside a transaction that is always rolled back. Verifies SQL validity without making changes.

### `simplicity-schema baseline`

Mark the current database state as baseline. Records all current schema files in the history table without running any migrations. Use when adopting simplicity-schema on an existing database.

```bash
npx @mabulu-inc/simplicity-schema baseline --db postgresql://user:pass@localhost:5432/mydb
```

## Analysis

### `simplicity-schema drift`

Compare YAML definitions to the live database. Reports differences without making changes.

```bash
npx @mabulu-inc/simplicity-schema drift --db postgresql://user:pass@localhost:5432/mydb
```

### `simplicity-schema drift --apply`

Detect drift and generate + execute a migration plan to fix all differences. Destructive fixes require `--allow-destructive`.

### `simplicity-schema lint`

Static analysis of the migration plan. Warns about dangerous patterns like direct `SET NOT NULL`, dropping columns, type narrowing, missing FK indexes.

### `simplicity-schema status`

Show migration status: number of applied files, pending changes, and history.

## Generation

### `simplicity-schema generate`

Introspect an existing database and generate YAML files.

```bash
npx @mabulu-inc/simplicity-schema generate --db postgresql://user:pass@localhost:5432/mydb --output-dir ./schema
npx @mabulu-inc/simplicity-schema generate --db postgresql://... --seeds users,roles  # include seed data
```

### `simplicity-schema sql`

Generate a standalone `.sql` migration file from the current plan.

```bash
npx @mabulu-inc/simplicity-schema sql --output migration.sql --db postgresql://user:pass@localhost:5432/mydb
```

Output includes transaction grouping, `CONCURRENTLY` operations outside transactions, phase comments, and blocked operations as comments.

### `simplicity-schema erd`

Generate a Mermaid ER diagram from YAML definitions.

```bash
npx @mabulu-inc/simplicity-schema erd --output schema.mmd
```

### `simplicity-schema init`

Create the standard project directory structure.

```bash
npx @mabulu-inc/simplicity-schema init --dir ./schema
```

### `simplicity-schema new pre|post|mixin`

Create timestamped templates.

```bash
npx @mabulu-inc/simplicity-schema new pre --name cleanup
npx @mabulu-inc/simplicity-schema new post --name refresh-views
npx @mabulu-inc/simplicity-schema new mixin --name timestamps
```

### `simplicity-schema docs`

Print the YAML format reference to stdout.

## Rollback & expand/contract

### `simplicity-schema down`

Rollback to the previous migration snapshot. See [rollback](/simplicity-schema/safety/rollback/).

### `simplicity-schema contract`

Complete the contract phase of an expand/contract migration. Drops old columns and dual-write triggers. Requires `--allow-destructive`.

### `simplicity-schema expand-status`

Show status of in-progress expand/contract migrations.

## Utility

### `simplicity-schema help`

Show help text.

### `simplicity-schema --version`

Show version number.
