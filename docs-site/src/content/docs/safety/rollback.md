---
title: Rollback
description: Snapshot-based rollback for migrations.
---

## How it works

Before each migration run, simplicity-schema captures a `MigrationSnapshot` in `_simplicity.snapshots`. This records the operations that were applied.

`simplicity-schema down` computes reverse operations from the latest snapshot and executes them.

## Usage

```bash
# Rollback the last migration
simplicity-schema down --db postgresql://user:pass@localhost:5432/mydb
```

## Reversible operations

| Forward operation           | Reverse                  |
| --------------------------- | ------------------------ |
| `create_table`              | `DROP TABLE`             |
| `add_column`                | `DROP COLUMN`            |
| `add_index`                 | `DROP INDEX`             |
| `add_foreign_key`           | `DROP CONSTRAINT`        |
| `add_foreign_key_not_valid` | `DROP CONSTRAINT`        |
| `add_check`                 | `DROP CONSTRAINT`        |
| `add_check_not_valid`       | `DROP CONSTRAINT`        |
| `add_unique_constraint`     | `DROP CONSTRAINT`        |
| `create_enum`               | `DROP TYPE`              |
| `create_function`           | `DROP FUNCTION`          |
| `create_trigger`            | `DROP TRIGGER`           |
| `drop_trigger`              | `CREATE TRIGGER`         |
| `create_policy`             | `DROP POLICY`            |
| `drop_policy`               | `CREATE POLICY`          |
| `create_view`               | `DROP VIEW`              |
| `create_materialized_view`  | `DROP MATERIALIZED VIEW` |
| `enable_rls`                | `DISABLE RLS`            |
| `create_extension`          | `DROP EXTENSION`         |
| `create_role`               | `DROP ROLE`              |
| `grant_*`                   | `REVOKE`                 |

## Irreversible operations

These are skipped during rollback (no data loss from rollback itself):

- `alter_column` -- column type/default changes cannot be safely reversed
- `add_enum_value` -- PostgreSQL cannot remove enum values in a transaction

## Programmatic API

```typescript
import {
  ensureSnapshotsTable,
  saveSnapshot,
  getLatestSnapshot,
  listSnapshots,
  deleteSnapshot,
  computeRollback,
  runDown,
} from '@mabulu-inc/simplicity-schema';
```
