---
title: Execution phases
description: The strict ordering of DDL operations during migration.
---

Operations execute in strict dependency order. This ensures PostgreSQL dependencies are satisfied (extensions before enums, enums before tables, tables before indexes, etc.).

| Phase | Object type        | Notes                                                                      |
| ----- | ------------------ | -------------------------------------------------------------------------- |
| 0     | Internal schema    | `CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow`                         |
| 0+    | Prechecks          | Pre-migration assertions (abort if falsy)                                  |
| 1     | Pre-scripts        | SQL in `pre/`, alphabetical order                                          |
| 2     | Extensions         | `CREATE EXTENSION IF NOT EXISTS`                                           |
| 3     | Enums              | `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE`                      |
| 4     | Roles              | `CREATE ROLE`, `ALTER ROLE`, `GRANT` membership                            |
| 5     | Functions          | `CREATE OR REPLACE FUNCTION`                                               |
| 6     | Tables             | `CREATE TABLE`, `ALTER TABLE` (columns, checks, unique) -- **without FKs** |
| 7     | Indexes            | Created outside transaction using `CONCURRENTLY`                           |
| 8     | Foreign keys       | Added as `NOT VALID`, then validated separately                            |
| 9     | Views              | `CREATE OR REPLACE VIEW`                                                   |
| 10    | Materialized views | `CREATE MATERIALIZED VIEW`, `REFRESH`                                      |
| 11    | Triggers           | `CREATE TRIGGER`                                                           |
| 12    | RLS policies       | `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`                               |
| 13    | Grants             | `GRANT`/`REVOKE` on tables, columns, sequences, functions, schemas         |
| 14    | Comments           | `COMMENT ON` for all object types                                          |
| 15    | Seeds              | `INSERT ... ON CONFLICT`                                                   |
| 16    | Post-scripts       | SQL in `post/`, alphabetical order                                         |

## Transaction boundaries

- Phases 0-6 and 8-16 run within a transaction (atomic commit or rollback)
- Phase 7 (indexes) runs outside the transaction because `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
- If any transactional phase fails, all changes in that transaction roll back
- `--per-tx-sql <path>` (if set) is injected as the first statement after `BEGIN` in every executor transaction — pre-scripts, the main migrate+seeds tx, post-scripts, and tighten — so `SET LOCAL` values are visible to everything that runs in the same tx

## Operation types

### Tables & columns

`create_table`, `drop_table`, `add_column`, `alter_column`, `drop_column`

### Indexes

`add_index`, `add_unique_index`, `drop_index`

### Constraints

`add_check`, `add_check_not_valid`, `drop_check`, `add_foreign_key`, `add_foreign_key_not_valid`, `validate_constraint`, `drop_foreign_key`, `add_unique_constraint`, `drop_unique_constraint`

### Enums

`create_enum`, `add_enum_value`, `remove_enum_value`

### Functions

`create_function`

### Triggers

`create_trigger`, `drop_trigger`

### RLS

`enable_rls`, `disable_rls`, `create_policy`, `drop_policy`

### Views

`create_view`, `drop_view`, `create_materialized_view`, `drop_materialized_view`, `refresh_materialized_view`

### Extensions

`create_extension`, `drop_extension`

### Roles & grants

`create_role`, `alter_role`, `grant_membership`, `grant_table`, `grant_column`, `revoke_table`, `revoke_column`, `grant_sequence`, `revoke_sequence`, `grant_function`, `revoke_function`, `grant_schema`

### Expand/contract

`expand_column`, `create_dual_write_trigger`, `backfill_column`, `contract_column`, `drop_dual_write_trigger`

### Schema

`create_schema`

### Other

`set_comment`, `add_seed`, `run_precheck`
