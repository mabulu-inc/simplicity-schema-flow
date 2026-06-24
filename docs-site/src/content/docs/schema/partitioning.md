---
title: Partitioned tables
description: Declare partitioned parents, foreign keys and indexes on them, and rolling pg_partman maintenance.
---

A table can be declared as a **partitioned parent** with `partition_by`. The
parent is first-class — its columns, primary key, indexes, foreign keys, RLS,
policies, grants, and comment are diffed and reconciled exactly like an ordinary
table. Child partitions are created out-of-band (by
[`pg_partman`](https://github.com/pgpartman/pg_partman)) and are deliberately
**ignored** during introspection, so a re-run never tries to drop them and the
parent converges to a clean no-op.

## `partition_by`

```yaml
table: kpi_daily_facts
partition_by:
  strategy: range # range | list | hash
  key: [as_of_date] # partition-key columns (must be declared columns)
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
primary_key: [id, as_of_date] # PG requires the PK to include the partition key
```

This emits `CREATE TABLE … PARTITION BY RANGE (as_of_date)`.

| Field      | Type     | Required | Description                                           |
| ---------- | -------- | -------- | ----------------------------------------------------- |
| `strategy` | string   | yes      | `range`, `list`, or `hash`                            |
| `key`      | string[] | yes      | Partition-key columns; each must be a declared column |

PostgreSQL requires the primary key (and every unique constraint) to include the
partition-key columns.

### Changing partitioning is rejected

PostgreSQL cannot turn an ordinary table into a partitioned one — or change the
strategy/key — in place. Adding, removing, or altering `partition_by` on an
existing table is rejected at plan time. Recreate the table in a
[pre-script](/simplicity-schema-flow/schema/scripts/) instead.

## Foreign keys and indexes on a partitioned parent

Declare `references:` and `indexes:` on a partitioned parent exactly as you would
on an ordinary table — they propagate to every partition automatically:

```yaml
table: kpi_daily_facts
partition_by:
  strategy: range
  key: [as_of_date]
columns:
  - name: id
    type: uuid
    nullable: false
  - name: as_of_date
    type: date
    nullable: false
  - name: tenant_id
    type: uuid
    references:
      table: tenants
      column: id
primary_key: [id, as_of_date]
indexes:
  - columns: [tenant_id]
```

schema-flow emits the **partition-safe DDL form** for these: an
immediately-validated `ADD CONSTRAINT … FOREIGN KEY` (not the `NOT VALID` +
`VALIDATE` split) and a plain `CREATE INDEX` (not `CREATE INDEX CONCURRENTLY`).
Both forms are the only ones PostgreSQL accepts on a partitioned parent, and both
cascade to all existing and future partitions. See
[Zero-downtime patterns](/simplicity-schema-flow/safety/zero-downtime/) for the
ordinary-table forms and why partitioned parents differ.

## Rolling-partition maintenance (`partitions:`)

Add a `partitions:` block to delegate the rolling window to pg_partman
declaratively — no companion cron script:

```yaml
table: kpi_daily_facts
partition_by:
  strategy: range
  key: [as_of_date] # pg_partman partitions on ONE control column
partitions:
  granularity: month # day | week | month | year → pg_partman interval
  window: [-24, 3] # [history, future] in granularity units:
  #   -24 → retention horizon (24 months kept)
  #    3  → premake 3 partitions ahead
  default: true # ensure a DEFAULT catch-all partition
  retention_keep_table: true # aged-out partitions are DETACHED (data-safe),
  #   not dropped. Set false to drop them.
columns: [...]
primary_key: [id, as_of_date]
```

| Field                  | Type      | Default  | Description                                                |
| ---------------------- | --------- | -------- | ---------------------------------------------------------- |
| `granularity`          | string    | required | `day`, `week`, `month`, or `year` → pg_partman interval    |
| `window`               | [int,int] | required | `[history, future]` in granularity units                   |
| `default`              | bool      | `false`  | Ensure a `DEFAULT` catch-all partition                     |
| `retention_keep_table` | bool      | `true`   | Aged-out partitions are detached (true) or dropped (false) |

On each `run`, schema-flow registers the parent with pg_partman (`create_parent`,
idempotent) and reconciles its `part_config` to the declared window/retention.
Re-running against an already-configured database is a clean no-op — the
maintenance steps are only emitted when the live window, retention, or schedule
actually differs.

**Requires `pg_partman` declared under `extensions:` with an explicit schema** so
its functions can be referenced:

```yaml
extensions:
  - name: pg_partman
    schema: partman
```

## Maintenance schedule

The maintenance **schedule is database-global** — pg_partman's
`run_maintenance_proc()` services every parent in one call, so it's declared once
(not per table) in `extensions.yaml` and emitted as a single pg_cron job, only
when `pg_cron` is declared:

```yaml
extensions:
  - name: pg_partman
    schema: partman
  - pg_cron
partition_maintenance:
  schedule: '@daily' # any cron expression; defaults to @daily
```

If `pg_cron` is omitted, schema-flow emits no schedule — wire
`run_maintenance_proc()` via the pg_partman background worker or another
scheduler instead.

`drift` reports partition-maintenance drift: it flags when a table's pg_partman
window/retention or the pg_cron schedule no longer matches the YAML, and
`drift --apply` corrects it.

## Operational prerequisites (infra, not schema-flow)

- `pg_cron` must be in the cluster's `shared_preload_libraries` (a parameter-group
  change requiring a reboot) before `CREATE EXTENSION pg_cron` succeeds. On
  Aurora/RDS it runs on the writer against the `cron.database_name` database
  (default `postgres`) — point that at your application database.
- pg_partman must be installed in the database `run_maintenance_proc()` runs in.

## Round-trip

`schema-flow generate` round-trips both `partition_by` and the `partitions:`
block back to YAML from an existing pg_partman-managed parent, so you can adopt an
already-partitioned database into schema-flow.
