---
title: Destructive protection
description: How simplicity-schema prevents accidental data loss.
---

## Blocked operations

These operations are **blocked by default** and require `--allow-destructive`:

- `drop_table` -- dropping entire tables
- `drop_column` -- dropping columns
- `drop_index` -- dropping indexes
- `drop_foreign_key` -- dropping foreign key constraints
- `drop_check` -- dropping check constraints
- `drop_unique_constraint` -- dropping unique constraints
- `drop_view` -- dropping views
- `drop_materialized_view` -- dropping materialized views
- `drop_extension` -- dropping extensions
- `disable_rls` -- disabling row-level security
- `drop_policy` -- dropping RLS policies
- `drop_trigger` -- dropping triggers
- Column type narrowing (e.g., `text` -> `varchar(50)`)
- Enum value removal (`remove_enum_value`)

## Behavior

When a blocked operation is encountered:

1. It is reported as "blocked" in the plan output
2. The rest of the migration proceeds normally
3. No data is lost

```bash
# See what would be blocked
npx @mabulu-inc/simplicity-schema plan

# Allow destructive operations
npx @mabulu-inc/simplicity-schema run --allow-destructive
```

## Advisory locking

Before running migrations, simplicity-schema acquires a PostgreSQL advisory lock. This prevents concurrent migration processes from conflicting. The lock is released after migration completes or on error.

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
