---
title: Pre/post scripts
description: SQL scripts that run before or after schema migration.
---

## `--per-tx-sql` (per-transaction prelude)

A SQL file passed via `--per-tx-sql <path>` (or `perTxSqlPath` in `schema-flow.config.yaml`). The file is read once at executor startup and injected as the first statement after `BEGIN` in **every transaction the executor opens** — each pre-script, the main migrate+seeds transaction, each post-script, and each tighten transaction.

The intended use case is per-transaction session state that audit triggers or RLS policies depend on. PostgreSQL isolates session state across connections, and schema-flow uses a fresh client per phase, so a value set in (say) a pre-script is gone by the time seeds run. `--per-tx-sql` closes that gap.

```sql
-- scripts/set-audit-actor.sql
SET LOCAL "app.user_id" = 'schema-flow:ci';
```

```bash
npx @smplcty/schema-flow run --per-tx-sql ./scripts/set-audit-actor.sql
```

Now every `INSERT` / `UPDATE` that schema-flow performs — seeds, pre-scripts, post-scripts, tighten — fires audit triggers with `current_setting('app.user_id')` populated, in the same transaction as the data change.

Skipped silently under `--dry-run` (logged only). Not hash-tracked — it is a session-level prelude, not a migration unit.

## Pre-scripts

File location: `schema/pre/<name>.sql`

Run **before** schema migration, in alphabetical order. Use for data cleanup, temporary table setup, or anything that needs to happen before DDL.

```sql
-- schema/pre/001_cleanup.sql
DELETE FROM temp_data WHERE created_at < now() - interval '30 days';
```

### Schema changes from pre-scripts

After pre-scripts run, schema-flow re-introspects the database and re-plans the apply phase against the post-pre-script state. This means a pre-script can perform schema changes the declarative planner can't express — most commonly, column or table renames — and the corresponding YAML change won't collide with a stale `add_column` op.

```sql
-- schema/pre/202604281000-rename-tenant-to-org.sql
ALTER TABLE IF EXISTS widgets RENAME COLUMN tenant_id TO org_id;
```

```yaml
# tables/widgets.yaml — column is now `org_id`
table: widgets
columns:
  - name: widget_id
    type: serial
    primary_key: true
  - name: org_id
    type: integer
    nullable: false
```

## Post-scripts

File location: `schema/post/<name>.sql`

Run **after** schema migration, in alphabetical order. Use for view refreshes, data backfills, or cache warming.

```sql
-- schema/post/001_refresh_views.sql
REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats;
```

## Creating templates

```bash
npx @smplcty/schema-flow new pre --name cleanup
npx @smplcty/schema-flow new post --name refresh-views
```

Creates timestamped template files like `schema/pre/20240115120000_cleanup.sql`.

## File tracking

All files (YAML and SQL) are tracked by SHA-256 hash. A file is re-run only when its content changes. There is no distinction between one-shot and repeatable scripts -- everything is hash-tracked uniformly.

## Execution phases

| Phase        | When                                                     |
| ------------ | -------------------------------------------------------- |
| Pre-scripts  | Phase 1 (after internal schema setup, before extensions) |
| Post-scripts | Phase 16 (after seeds, last phase)                       |
