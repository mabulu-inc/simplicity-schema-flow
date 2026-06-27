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

schema-flow applies the declarative diff as **one transaction per table**, not
one transaction for the whole migration. This is what makes it safe to run
against a live database: a single transaction spanning the whole diff would
acquire `ACCESS EXCLUSIVE` on every table it touches and hold all of those locks
until the final commit — queuing behind any active write and freezing every
table behind it for the duration. Per-table groups hold each table's lock only
for that table's handful of statements, then commit and release.

- The DDL diff is split into transaction groups: a new group starts whenever the
  table changes, so each group's lock footprint is a **single table**. Naturally
  atomic same-table pairs stay together — e.g. `DROP CONSTRAINT fk` immediately
  followed by `ADD CONSTRAINT fk … NOT VALID` land in one group.
- Each group runs with `lock_timeout` set (`--lock-timeout`, default `5000`ms) so
  a blocked group **aborts cleanly instead of queuing** and freezing the table
  behind it. An aborted group is retried with exponential backoff
  (`--max-retries`, default `3`); under live traffic each brief lock slips
  through a micro-gap within a few attempts. Exhausting the retries fails the run
  with the contended table named.
- **Seeds** run in their own atomic transaction after the DDL groups — they are
  insert-only and take row locks, not the table-level locks that make DDL the
  contention problem.
- Phase 7 (indexes) runs outside any transaction because `CREATE INDEX
CONCURRENTLY` cannot run inside one.
- Per-column `NOT NULL` tightening runs after post-scripts, each column in its
  own transaction.
- Ops belonging to a [bootstrap table](/simplicity-schema-flow/schema/tables/#bootstrap-phase) (`bootstrap: true`) are split into a separate transaction that commits **before** the main apply, so per-tx hooks opening later transactions can resolve the rows seeded there. The bootstrap tx additionally sets `smplcty.bootstrap = 'true'` plus any `bootstrapSession` GUCs
- `--per-tx-sql <path>` (if set) is injected as the first statement after `BEGIN` in every executor transaction — pre-scripts, the bootstrap tx, each per-table group, the seed tx, post-scripts, and tighten — so `SET LOCAL` values are visible to everything that runs in the same tx
- `validate` is the exception: it applies the **entire** diff in one transaction and rolls it back, because all-or-nothing apply-then-discard is exactly what validation checks.

### Failure recovery: re-run to converge

Because each table commits independently, an interrupted migration leaves a
**partially-applied schema** — earlier tables committed, the rest not yet
applied. This is by design, and it is a strength: schema-flow is declarative and
every statement is guarded (`IF [NOT] EXISTS`, `NOT VALID`, idempotent
reconciles), so a partial apply is always a **valid intermediate schema**, never
a corrupt one. Re-running recomputes the diff from live state, skips what already
landed, and applies only what's left. Recovery is a re-run, not manual surgery —
which is precisely why per-table commits are safe here when they would not be for
an imperative migration tool.

## Post-apply convergence

When an apply performs a wide `CASCADE` drop (e.g. a function return-type
change), it can remove declared policies or views the plan — built from a
pre-drop snapshot — didn't know to recreate. After such an apply, schema-flow
re-plans against the live database and recreates those declared objects, then
re-plans once more and warns about anything still outstanding. This makes a
single `run` converge rather than exit successfully while leaving the schema
short of the declared state.

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

`create_function`, `drop_function`

A return-type change is applied as `drop_function` (`CASCADE`) followed by
`create_function`, since `CREATE OR REPLACE` cannot alter a function's return
type. The drop is destructive and sorts ahead of the recreate.

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
