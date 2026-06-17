---
title: Seeds
description: YAML reference for seeding reference/lookup data idempotently.
---

`seeds:` declares rows that schema-flow keeps present in a table on every apply. It's for reference and lookup data — enum-like status tables, a service user, default settings — not for bulk fixtures. Seeds are **insert-only** and idempotent: a row is created if its key isn't already present and otherwise left untouched, so re-running a migration converges to zero operations and never overwrites existing data.

## Example

```yaml
table: users
columns:
  - { name: id, type: uuid, primary_key: true }
  - { name: email, type: text, unique: true }
  - { name: name, type: text }
  - { name: created_at, type: timestamptz }
seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    email: 'admin@example.com'
    name: 'Admin'
    created_at: !sql now() # SQL expression
```

Each entry is a `SeedRow` — a map of column name to value. You only list the columns you want to control; columns the YAML omits keep their database defaults and are never consulted when matching.

## SQL expressions in values

Use the `!sql` YAML tag (or a `{ __sql: '…' }` map) when a value must be evaluated by Postgres rather than supplied as a literal:

```yaml
seeds:
  - key: default_delay_reasons
    value: !sql |-
      '["Customer not ready","Late truck arrival","Equipment failure"]'::jsonb
  - id: 1
    created_at: !sql now()
```

The expression is spliced into the insert verbatim and runs with the column's type. Seeds whose stored value already equals the expression's result — including `jsonb`, `numeric`, and array values that Postgres re-formats on storage — are detected as unchanged and produce no operation in the plan.

## Match-key resolution

To re-apply seeds idempotently, schema-flow needs a way to identify which existing row a seed row corresponds to. The match key is resolved per table, in this order:

1. **Primary key**, if every PK column is present in every seed row — the declared canonical identity wins outright.
2. **The best covered unique key.** Every unique key (column-level `unique: true` or a table-level `indexes:` entry with `unique: true`) whose columns are all present in every seed row is a candidate, ranked by:
   1. **full before partial** — a **partial** unique index (one with a `where:` clause) is used, matching on its columns with the predicate **ignored**, but it only enforces uniqueness over a subset of rows, so it's a weaker table-wide identity and loses to any full unique key;
   2. then **fewest columns** — since every candidate is unique, the narrowest key is the most fundamental and avoids the case where a wider key's INSERT would trip a narrower unique constraint;
   3. then **declaration order**, as a deterministic tiebreaker.

   A plain unique index is enough; it does **not** need `as_constraint: true`, because de-dup is done with `WHERE NOT EXISTS` rather than `ON CONFLICT`. Because a partial index's predicate is ignored, its existence check spans the whole table — so a soft-deleted builtin still counts as present and is never re-inserted as a second live row. Expression-keyed unique indexes are skipped, since their keys can't be matched against literal seed values.

3. **No match key.** Rows are inserted only when no existing row in the table already has the same values for every seed-provided column (null-safe via `IS NOT DISTINCT FROM`). Table columns the YAML didn't mention are never consulted.

A column only counts as "present" when it appears in **every** seed row — a key column missing from some rows can't identify them.

There is no implicit "treat `id` as the key" behaviour — if your PK is `code` and your seed only supplies `id`, the planner falls through to (2) or (3).

This is what lets you seed by a natural key and omit a serial/identity primary key entirely: drop `id` from the seed rows and, as long as the controlled columns cover a unique key, schema-flow matches on that key instead. (See [Seeds and serial/identity sequences](#seeds-and-serialidentity-sequences) for why omitting the serial id is also the safer choice.)

```yaml
table: units
columns:
  - { name: id, type: serial, primary_key: true }
  - { name: code, type: text, unique: true } # the natural key
  - { name: name, type: text }
seeds:
  - { code: lb, name: Pounds } # no id — matched on `code`
  - { code: kg, name: Kilograms }
```

## Insert-only — existing rows are never overwritten

Seeds only ever **insert**. A seed row whose key already exists is left exactly as it is in the database; schema-flow never updates it to match the YAML. This keeps seeds safe for reference data an application may edit after install (renaming a status, soft-deleting a builtin) — re-applying a migration won't clobber those changes or resurrect a removed row.

If you need to change a value that's already been seeded, do it with a migration pre/post-script, not by editing the seed.

## Seeds and serial/identity sequences

Seeding an explicit value into a `serial`/identity primary key **does not advance the backing sequence**. The seed writes the row, but the sequence's next value is unchanged — so a later bare `INSERT` (one that lets the sequence assign the id) can collide with a seeded id and fail with a unique-violation.

If you seed explicit ids into a sequence-backed column, either:

- keep seeded ids in a reserved low range and let the application use ids above it, or
- bump the sequence past your seeded ids in a post-script, e.g.
  `SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));`

This only applies when you supply the key explicitly. Seeds that match on a non-serial key (a `text` code, a `uuid`) are unaffected.

## How unchanged seeds are detected

Before planning, schema-flow loads the YAML seeds into a temporary table and `EXCEPT`-compares them against the real table over the seed-declared columns, using the actual column types. If every seed row already has a typed-equal match, the seed operation is dropped from the plan. Because the comparison is done over the real types, formatting-only differences (jsonb spacing, numeric scale, array text) never produce a phantom operation.

## See also

- [Bootstrap phase](/simplicity-schema-flow/schema/bootstrap/) — seeding rows that the rest of the migration depends on, in a transaction that commits first.
- [Tables](/simplicity-schema-flow/schema/tables/) — the full table YAML reference.
