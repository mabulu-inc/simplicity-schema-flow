---
title: Destructive protection
description: How schema-flow prevents accidental data loss.
---

## Blocked operations

These operations are **blocked by default** and require `--allow-destructive`:

- `drop_table` -- dropping entire tables
- `drop_column` -- dropping columns
- `drop_index` -- dropping indexes
- `drop_foreign_key` -- dropping foreign key constraints
- `drop_check` -- dropping check constraints
- `drop_unique_constraint` -- dropping unique constraints
- `drop_exclusion_constraint` -- dropping exclusion constraints
- `replace_primary_key` / `drop_primary_key` -- changing a primary key's columns, or removing it
- `drop_function` -- dropping a function to recreate it with a changed return type
- `drop_view` -- dropping views
- `drop_materialized_view` -- dropping materialized views
- `drop_extension` -- dropping extensions
- `disable_rls` -- disabling row-level security
- `drop_policy` -- dropping RLS policies
- `drop_trigger` -- dropping triggers
- A column type change whose cast can change values without an error, unless
  the column sets `using:`: time-zone-dependent (`timestamptz` -> `date`),
  rounding (`numeric` -> `integer`) or truncating (`text` -> `varchar(50)`).
  See [Changing a column's type](/simplicity-schema-flow/schema/tables/#changing-a-columns-type).
- Enum value removal (`remove_enum_value`)

## Behavior

When a blocked operation is encountered:

1. It is reported as "blocked" in the plan output
2. The rest of the migration proceeds normally
3. No data is lost

Changing an existing index, unique constraint or exclusion constraint drops and
re-creates it. When the drop is blocked, the re-create is blocked with it: both
appear as blocked, and neither is reported as applied.

```bash
# See what would be blocked
npx @smplcty/schema-flow plan

# Allow destructive operations
npx @smplcty/schema-flow run --allow-destructive
```

## Cascading drops and convergence

Some declared changes can only be applied by dropping an object that other
objects depend on. The drop is gated like any other destructive operation, and
schema-flow takes two extra precautions around it:

- **Dependents are surfaced first.** Before a `DROP … CASCADE` runs, schema-flow
  lists what the cascade will remove and warns about anything **not declared in
  your schema**, so an ad-hoc view or policy isn't dropped silently.
- **The apply re-plans afterwards.** A cascade can drop declared objects the
  original plan — built from a pre-drop snapshot — didn't know to recreate.
  After such an apply, schema-flow re-plans against the live database, recreates
  the declared policies and views the cascade removed, and warns if anything is
  still pending. A single `run` converges instead of leaving silent drift.

The two cases that use this today:

- A **function return-type change** (`integer` → `bigint`, a changed
  `TABLE(...)`/`OUT` signature) — `CREATE OR REPLACE` can't alter a return type,
  so the function is dropped (`CASCADE`, taking dependent policies/views) and
  recreated. See [Functions](/simplicity-schema-flow/schema/functions/#return-type-changes).
- A declared **partial unique index** whose name matches an existing plain
  `UNIQUE` constraint — the constraint is dropped and the partial index built in
  its place. See [Tables → Indexes](/simplicity-schema-flow/schema/tables/#reconciling-a-same-named-constraint).

## Objects schema-flow doesn't own

schema-flow treats anything in its target schema that the YAML doesn't
declare as stale, and drops it once `--allow-destructive` is passed. That's
wrong when something else, such as your application, also creates objects.
How to keep them depends on what they are.

**Standalone objects** (tables, views, materialized views, functions): create
them in a Postgres schema schema-flow doesn't target. Each run manages only
its own schema (`--schema` / `pgSchema`), so objects elsewhere are never
touched.

**Objects attached to a managed table** (indexes, unique, check and
exclusion constraints, triggers, RLS policies) have to live with their table.
Mark them with a comment that starts with `schema-flow:unmanaged`:

```sql
CREATE INDEX CONCURRENTLY tenant298_cf_fiscal_quarters
  ON opportunities (tenant_id, ((custom_fields ->> 'Fiscal_Quarters__c')))
  WHERE tenant_id = 298;
COMMENT ON INDEX tenant298_cf_fiscal_quarters IS 'schema-flow:unmanaged — tenant filter';
```

A marked object:

- is never dropped, even with `--allow-destructive`
- is counted in `plan` and `run` output (`Unmanaged (left alone): N objects`),
  and named with `--verbose`
- isn't reported by `drift`, and isn't written into the YAML by `generate`

If the YAML declares an object with the same name, the YAML wins and
schema-flow manages it whatever the comment says. An object without the
marker is still treated as stale, so code that creates these objects should
set the comment in the same step.

## Advisory locking

Before running migrations, schema-flow acquires a PostgreSQL advisory lock. This prevents concurrent migration processes from conflicting. The lock is released after migration completes or on error.

## Transactional execution

DDL runs within transactions. If any statement fails, the entire transaction rolls back. No partial migrations.

## Timeouts

| Setting           | Default | Purpose                                                       |
| ----------------- | ------- | ------------------------------------------------------------- |
| Lock timeout      | 5000ms  | Prevents blocking other queries while waiting for table locks |
| Statement timeout | 30000ms | Prevents long-running DDL from holding locks indefinitely     |

## Automatic retry

Transient errors are retried up to 3 times with exponential backoff:

| Error code | Meaning                                |
| ---------- | -------------------------------------- |
| `55P03`    | Lock timeout                           |
| `57014`    | Statement timeout / query cancellation |
| `40001`    | Serialization failure                  |
| `40P01`    | Deadlock detected                      |

## Interrupted migrations

If a migration is interrupted:

- Re-running picks up where it left off (file hash tracking)
- Transactional phases either fully commit or fully roll back
- Failed `CONCURRENTLY` operations leave invalid indexes that can be detected and retried
