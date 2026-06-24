---
title: Extensions
description: YAML reference for PostgreSQL extension definitions.
---

File location: `schema/extensions.yaml` (single file)

## Example

```yaml
extensions:
  - pgcrypto
  - pg_trgm
  - uuid-ossp
  - name: pg_partman # object form pins the install schema
    schema: partman
schema_grants:
  - to: app_user
    schemas: [public]
```

## Fields

| Field                   | Type               | Required | Description                                               |
| ----------------------- | ------------------ | -------- | --------------------------------------------------------- |
| `extensions`            | (string\|object)[] | yes      | Extensions to install — a bare name or `{ name, schema }` |
| `schema_grants`         | object[]           | no       | Grant `USAGE` on schemas                                  |
| `partition_maintenance` | object             | no       | Database-global pg_cron schedule for pg_partman           |

## Pinning an install schema

Each entry is either a bare extension name or a `{ name, schema }` object. The
object form emits `CREATE EXTENSION IF NOT EXISTS "name" SCHEMA "schema"` — useful
for extensions that conventionally live in a dedicated schema (e.g. `pg_partman`
in `partman`):

```yaml
extensions:
  - name: pg_partman
    schema: partman
```

The schema is applied at install time; an already-installed extension is left
where it is (`IF NOT EXISTS`).

## Partition maintenance

`partition_maintenance` declares the database-global pg_cron schedule that drives
pg_partman's rolling-partition maintenance. It belongs here (not per table)
because one `run_maintenance_proc()` call services every partitioned parent:

```yaml
extensions:
  - name: pg_partman
    schema: partman
  - pg_cron
partition_maintenance:
  schedule: '@daily' # any cron expression; defaults to @daily
```

A single pg_cron job is emitted, and only when `pg_cron` is declared. See
[Partitioned tables](/simplicity-schema-flow/schema/partitioning/) for the full
partitioning workflow.

## Schema grants

```yaml
schema_grants:
  - to: app_user # role name
    schemas: [public] # schemas to grant USAGE on
```

## Behavior

- Extensions are installed with `CREATE EXTENSION IF NOT EXISTS`
- Removing an extension from the list requires `--allow-destructive`
- Extensions are installed in phase 2 (before enums and tables)
