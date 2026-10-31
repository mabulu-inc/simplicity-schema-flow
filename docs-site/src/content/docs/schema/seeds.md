---
title: Seeds
description: YAML reference for seeding reference/lookup data idempotently.
---

`seeds:` declares rows that schema-flow keeps present in a table on every apply. It's for reference and lookup data — enum-like status tables, a service user, default settings — not for bulk fixtures. By default seeds are **insert-only** and idempotent: a row is created if its key isn't already present and otherwise left untouched, so re-running a migration converges to zero operations and never overwrites existing data. A table can opt into [authoritative seeds](#authoritative-seeds), where the YAML also updates existing rows.

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

## Insert-only by default

By default seeds only **insert**. A seed row whose key already exists is left exactly as it is in the database; schema-flow never updates it to match the YAML. This keeps seeds safe for data an application edits after install (a settings row changed through an admin page, a renamed status, a soft-deleted builtin): re-applying a migration won't clobber those changes or resurrect a removed row.

An edit to an existing seed row therefore doesn't reach a database that already has the row. That is never silent: `plan` and `run` warn once per seeded value the database holds differently, naming the table, key and column:

```text
warn Seed not applied: load_event_types[code=cancelled].name is Load Cancelled in the database, Load Canceled in the YAML. Seeds only insert missing rows; set seeds_authoritative: true on load_event_types to apply seed edits.
```

`drift` reports the same values, one item per key and column. If the database value is the one you want, update the YAML to match and the warning stops. If the YAML is right, make the table authoritative.

## Authoritative seeds

Set `seeds_authoritative: true` on a table whose YAML owns its seeded rows, typically a reference table such as event types or device types. Every apply then also brings an existing row's **seeded columns** to the YAML values:

```yaml
table: load_event_types
seeds_authoritative: true
columns:
  - { name: load_event_type_id, type: serial, primary_key: true }
  - { name: code, type: text, unique: true }
  - { name: name, type: text }
  - { name: description, type: text }
seeds:
  - { code: cancelled, name: Load Canceled, description: The load was canceled before pickup. }
```

- Only the columns a seed row lists are written. Columns the YAML doesn't seed keep whatever the database holds.
- A row whose seeded values already match is not touched, so its update triggers don't fire and the plan has no seed operation once everything matches.
- Rows removed from the YAML are not deleted.
- The table needs a [match key](#match-key-resolution): every seed row must include the primary key or a unique key. Without one there is no way to find the row to update, and the plan fails.

Updates and inserts run from the same recordset in the seed transaction, updates first.

### Audited tables need an actor

A seed update fires the table's update triggers. An audit trigger that stamps `updated_by` from an actor setting, such as [`@smplcty/schema-std`](https://www.npmjs.com/package/@smplcty/schema-std)'s `audit_stamp`, finds no actor during a migration. In lenient mode it stamps NULL, and on an existing database `updated_by` is already `NOT NULL`, so the update fails. schema-flow knows nothing about your users, so supply an actor for the seed transaction yourself: a [`perTxSqlPath`](/simplicity-schema-flow/getting-started/configuration/) hook that looks up your migration user, for example

```sql
SELECT set_config('app.actor_id', (SELECT user_id::text FROM users WHERE name = 'app-init'), true);
```

or a fixed id in [`bootstrapSession`](/simplicity-schema-flow/schema/bootstrap/#bootstrapsession). The hook runs after the session settings, so it wins. Without an actor, the apply fails with an error naming the table and column, and says to set one.

On a fresh database the hook can't find a migration user seeded in the same transaction, but a fresh database has no rows to update; the lenient setting plus a back-fill covers its inserts (see [Bootstrap](/simplicity-schema-flow/schema/bootstrap/)).

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
