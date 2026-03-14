---
title: Pre/post scripts
description: SQL scripts that run before or after schema migration.
---

## Pre-scripts

File location: `schema/pre/<name>.sql`

Run **before** schema migration, in alphabetical order. Use for data cleanup, temporary table setup, or anything that needs to happen before DDL.

```sql
-- schema/pre/001_cleanup.sql
DELETE FROM temp_data WHERE created_at < now() - interval '30 days';
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
simplicity-schema new pre --name cleanup
simplicity-schema new post --name refresh-views
```

Creates timestamped template files like `schema/pre/20240115120000_cleanup.sql`.

## File tracking

All files (YAML and SQL) are tracked by SHA-256 hash. A file is re-run only when its content changes. There is no distinction between one-shot and repeatable scripts -- everything is hash-tracked uniformly.

## Execution phases

| Phase        | When                                                     |
| ------------ | -------------------------------------------------------- |
| Pre-scripts  | Phase 1 (after internal schema setup, before extensions) |
| Post-scripts | Phase 16 (after seeds, last phase)                       |
