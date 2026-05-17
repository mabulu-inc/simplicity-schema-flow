---
title: Tables
description: Complete YAML reference for table definitions.
---

File location: `schema/tables/<name>.yaml`. One file per table.

## Full example

```yaml
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
    unique: true
    unique_name: uq_users_email
    check: 'length(email) > 0'
    comment: "User's primary email"
  - name: role_id
    type: uuid
    references:
      table: roles
      column: id
      name: fk_users_role
      schema: public
      on_delete: SET NULL
      on_update: NO ACTION
      deferrable: false
      initially_deferred: false
  - name: metadata
    type: jsonb
    default: "'{}'::jsonb"
  - name: total
    type: numeric
    generated: 'price * quantity'
  - name: email_lower
    type: text
    expand:
      from: email
      transform: 'lower(email)'
      reverse: 'email'
      batch_size: 5000

primary_key: [id]
primary_key_name: pk_users

indexes:
  - columns: [email]
    unique: true
    comment: 'Ensure email uniqueness'
  - name: idx_users_metadata
    columns: [metadata]
    method: gin
  - columns: [created_at]
    where: 'deleted_at IS NULL'
  - columns: [name]
    include: [email]
    opclass: text_pattern_ops

checks:
  - name: email_not_empty
    expression: 'length(email) > 0'

# Table-level unique constraints are declared under `indexes:` with
# `as_constraint: true`. That's also the only place `deferrable:` is legal
# (Postgres requires a constraint, not a bare unique index, for deferral).
indexes:
  - columns: [email, tenant_id]
    name: uq_users_email_tenant
    unique: true
    as_constraint: true
    nulls_not_distinct: true

triggers:
  - name: set_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
    when: 'OLD.* IS DISTINCT FROM NEW.*'

rls: true
force_rls: true

policies:
  - name: users_own_data
    for: SELECT
    to: app_user
    using: "id = current_setting('app.user_id')::uuid"
    check: "id = current_setting('app.user_id')::uuid"
    permissive: true

grants:
  - to: app_readonly
    privileges: [SELECT]
    columns: [id, email, name]
    with_grant_option: false

prechecks:
  - name: ensure_no_orphans
    query: 'SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)'
    message: 'Orphaned orders exist — fix before migrating'

seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    email: 'admin@example.com'
    name: 'Admin'
    created_at: !sql now()
seeds_on_conflict: 'DO NOTHING'

mixins:
  - timestamps

comment: 'Core user accounts table'
```

## Columns

### Required fields

| Field  | Type   | Description         |
| ------ | ------ | ------------------- |
| `name` | string | Column name         |
| `type` | string | Any PostgreSQL type |

### Optional fields

| Field         | Type    | Default | Description                                     |
| ------------- | ------- | ------- | ----------------------------------------------- |
| `nullable`    | boolean | `true`  | Allow NULL values                               |
| `primary_key` | boolean | `false` | Part of primary key                             |
| `unique`      | boolean | `false` | Add unique constraint                           |
| `unique_name` | string  | auto    | Custom unique constraint name                   |
| `default`     | string  | --      | Default value expression                        |
| `check`       | string  | --      | Column-level check (sugar for `checks` section) |
| `comment`     | string  | --      | Column comment                                  |
| `references`  | object  | --      | Foreign key reference                           |
| `generated`   | string  | --      | `GENERATED ALWAYS AS (expr) STORED`             |
| `expand`      | object  | --      | Zero-downtime column migration                  |

### Column types

All PostgreSQL types are supported:

| Type                            | Notes                               |
| ------------------------------- | ----------------------------------- |
| `uuid`                          | Recommended for PKs                 |
| `text`                          | Variable-length string              |
| `varchar(N)`                    | Bounded string                      |
| `integer`, `bigint`, `smallint` | Integers                            |
| `serial`, `bigserial`           | Auto-increment                      |
| `numeric`, `decimal`            | Exact numeric                       |
| `boolean`                       | true/false                          |
| `timestamptz`                   | Timestamp with timezone (preferred) |
| `timestamp`                     | Without timezone                    |
| `date`, `time`, `interval`      | Date/time                           |
| `jsonb`, `json`                 | JSON data                           |
| `bytea`                         | Binary data                         |
| `inet`, `cidr`, `macaddr`       | Network types                       |
| `text[]`, `integer[]`           | Arrays                              |
| Custom enum names               | User-defined enums                  |

### Foreign key references

```yaml
references:
  table: roles # required
  column: id # required
  name: fk_users_role # optional, auto-generated if omitted
  schema: public # optional, for cross-schema FKs
  on_delete: SET NULL # CASCADE | SET NULL | SET DEFAULT | RESTRICT | NO ACTION
  on_update: NO ACTION
  deferrable: false
  initially_deferred: false
```

### Column-level check sugar

```yaml
- name: age
  type: integer
  check: 'age >= 0'
```

Equivalent to a check constraint named `chk_<table>_<column>`.

### Generated columns

```yaml
- name: total
  type: numeric
  generated: 'price * quantity'
```

Creates `GENERATED ALWAYS AS (price * quantity) STORED`.

### Expand (zero-downtime column migration)

```yaml
- name: email_lower
  type: text
  expand:
    from: email # source column
    transform: 'lower(email)' # SQL transform expression
    reverse: 'email' # optional: dual-write new->old
    batch_size: 5000 # optional: backfill batch size (default: 1000)
```

See [expand/contract migrations](/schema-flow/safety/expand-contract/) for details.

## Primary key

Column-level:

```yaml
columns:
  - name: id
    type: uuid
    primary_key: true
```

Composite:

```yaml
primary_key: [tenant_id, id]
primary_key_name: pk_my_table # optional
```

## Indexes

```yaml
indexes:
  - columns: [email] # required
    name: idx_users_email # optional, auto-generated
    unique: true # default: false
    method: gin # btree (default) | gin | gist | hash | brin
    where: 'deleted_at IS NULL' # partial index
    include: [name] # covering index (INCLUDE)
    opclass: text_pattern_ops # operator class
    nulls_not_distinct: true # unique only; treat NULLs as equal (PG 15+)
    as_constraint: true # unique only; also wrap in a pg_constraint row
    deferrable: initially_deferred # requires as_constraint; or initially_immediate
    comment: 'description'
```

Indexes are created using `CONCURRENTLY` outside of a transaction where possible.

### `as_constraint` (table-level unique constraints)

Set `as_constraint: true` on a unique index to also wrap it in a
`pg_constraint` row. The planner emits the safe two-step pattern —
`CREATE UNIQUE INDEX CONCURRENTLY` followed by `ALTER TABLE ADD CONSTRAINT
… USING INDEX`. You want this whenever you need:

- **FK-target canonicality** — `REFERENCES table(col)` resolves cleanly
  to a named constraint
- **Catalog visibility** — the constraint appears in `pg_constraint`,
  which some ORMs and downstream tooling rely on for introspection
- **Deferred constraint checking** — `deferrable:` is only legal with
  `as_constraint: true`. Postgres won't let you defer a bare unique index.

PG restricts constraint-backed indexes to bare columns, default ordering
(`ASC NULLS LAST`), btree, no partial `where:`, no `opclass`. The parser
rejects any of those at load time so you don't get a Postgres error mid-apply.

### `deferrable`

Defers the unique-check from per-statement to commit-time. Two modes:

- `initially_immediate` — deferrable but checked immediately by default; a
  transaction can opt in with `SET CONSTRAINTS … DEFERRED`
- `initially_deferred` — checked at commit by default; a transaction can
  re-enable immediate checking with `SET CONSTRAINTS … IMMEDIATE`

Useful for swapping unique values within a single transaction
(`UPDATE positions SET rank = …` where the intermediate state would
otherwise violate uniqueness) or for circular FK inserts.

### Column ordering (ASC/DESC, NULLS FIRST/LAST)

By default each indexed column uses Postgres's defaults — `ASC` order, `NULLS LAST` for `ASC` and `NULLS FIRST` for `DESC`. To override, use the object form for the column entry:

```yaml
indexes:
  - name: idx_events_tenant_created_desc
    columns:
      - column: tenant_id # plain key, all defaults
      - column: created_at
        order: DESC # ASC (default) | DESC
        nulls: LAST # FIRST | LAST; defaults to LAST for ASC, FIRST for DESC
```

Useful when an index is meant to satisfy a specific `ORDER BY` (Postgres can use a non-default-ordered index to skip an external sort). Writing the default modifiers explicitly is a no-op; the diff resolves both sides to the same canonical (order, nulls) pair before comparing, so an explicit `ASC NULLS LAST` doesn't churn against an introspected bare column.

## Check constraints

```yaml
checks:
  - name: email_not_empty # required
    expression: 'length(email) > 0' # required
    comment: 'description'
```

## Unique constraints

Declared under [`indexes:`](#indexes) with `unique: true` and
`as_constraint: true`. See the [`as_constraint` section](#as_constraint-table-level-unique-constraints)
above for the trade-off between a bare unique index and a
constraint-backed one.

```yaml
indexes:
  - columns: [email, tenant_id] # required
    name: uq_users_email_tenant # optional
    unique: true # required for constraints
    as_constraint: true # wrap in pg_constraint
    nulls_not_distinct: true # optional — treat NULLs as equal (PostgreSQL 15+)
    comment: 'description'
```

Created safely: `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT ... USING INDEX`.

Set `nulls_not_distinct: true` to treat NULL values as equal within the unique constraint. By default, PostgreSQL considers each NULL distinct, allowing multiple rows with NULL in unique columns. With this option, only one NULL per unique group is permitted. Requires PostgreSQL 15 or later.

:::note[Migration from `unique_constraints:` (0.7.x → 0.8.0)]
The separate `unique_constraints:` section was removed in 0.8.0. Rename
the section to `indexes:` and add `unique: true` + `as_constraint: true`
to each entry. The parser throws a hard error with this exact instruction
if it sees the old section name.
:::

## Exclusion constraints

```yaml
exclusion_constraints:
  - name: bookings_no_overlap # optional
    using: gist # default: gist
    elements: # required
      - column: room_id
        operator: '='
      - column: during
        operator: '&&'
    where: status <> 'cancelled' # optional partial predicate
    comment: 'description'
```

Generates `ALTER TABLE … ADD CONSTRAINT … EXCLUDE USING <method> (col WITH op, …) [WHERE (…)]`.

- The default index method is `gist`. Multi-element non-spatial cases (e.g. `room_id WITH =, during WITH &&`) require `btree_gist` listed in `extensions.yaml`.
- Operator tokens pass through verbatim — same string-pass-through model as `check.expression`.
- Unlike CHECK and FK, EXCLUDE constraints don't support `NOT VALID`. Adding one against a populated table validates immediately and fails on conflicting rows; deduplicate first if applying against existing data.

## Triggers

```yaml
triggers:
  - name: set_updated_at # required
    timing: BEFORE # BEFORE | AFTER | INSTEAD OF
    events: [UPDATE] # INSERT | UPDATE | DELETE | TRUNCATE
    function: update_timestamp # required: function name
    for_each: ROW # ROW | STATEMENT
    when: 'OLD.* IS DISTINCT FROM NEW.*' # optional
    comment: 'description'
```

## Row-level security

```yaml
rls: true # enable RLS
force_rls: true # force RLS on table owner

policies:
  - name: users_own_data # required
    for: SELECT # SELECT | INSERT | UPDATE | DELETE | ALL
    to: app_user # required: role name
    using: "id = current_setting('app.user_id')::uuid"
    check: "id = current_setting('app.user_id')::uuid"
    permissive: true # true (PERMISSIVE) | false (RESTRICTIVE)
    comment: 'description'
```

## Grants

```yaml
grants:
  - to: app_readonly # required: role name
    privileges: [SELECT] # required
    columns: [id, email, name] # optional: column-level grants
    with_grant_option: false
```

### Mixing column-level and table-level grants

A single role can have both a column-qualified grant on a subset of columns and a table-level grant on the rest. Use two blocks for the same role:

```yaml
grants:
  # Column-qualified grant — restricts SELECT/INSERT/UPDATE to these columns
  - to: app_user
    privileges: [SELECT, INSERT, UPDATE]
    columns: [id, email, name]
  # Table-level grant — applies to the whole table, no column qualifier
  - to: app_user
    privileges: [DELETE, INSERT, SELECT, UPDATE]
```

The table-level grant subsumes any overlapping column-level privileges for the same role, so a no-change re-run is a no-op — the planner emits no GRANT or REVOKE.

## Pre-migration checks

```yaml
prechecks:
  - name: ensure_no_orphans
    query: 'SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)'
    message: 'Orphaned orders exist — fix before migrating'
```

If any precheck returns a falsy value, migration aborts.

## Seeds

```yaml
seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    email: 'admin@example.com'
    name: 'Admin'
    created_at: !sql now() # SQL expression
seeds_on_conflict: 'DO NOTHING' # optional — see below
```

### Match-key resolution

To re-apply seeds idempotently, schema-flow needs a way to identify which existing row a seed row corresponds to. The match key is resolved per table, in this order:

1. **Primary key**, if every PK column is present in every seed row.
2. **The first unique constraint** whose columns are all present in every seed row — column-level `unique: true` first, then table-level `indexes:` entries with `as_constraint: true`.
3. **No match key.** UPDATE is skipped entirely, and rows are INSERTed only when no existing row in the table already has the same values for every seed-provided column (null-safe via `IS NOT DISTINCT FROM`). Table columns the YAML didn't mention are never consulted.

There is no implicit "treat `id` as the key" behaviour — if your PK is `code` and your seed only supplies `id`, the planner will fall through to (2) or (3).

### Conflict behaviour

- **Default (no `seeds_on_conflict`)** — upsert via the resolved match key: rows whose non-key columns differ are UPDATEd, rows that don't yet exist are INSERTed.
- **`seeds_on_conflict: 'DO NOTHING'`** — skips the UPDATE step even when a match key exists, so existing rows are never overwritten. New rows are still INSERTed.

Use the `!sql` YAML tag for SQL expressions in values. Seeds whose existing values already match the YAML are detected via an `EXCEPT` round-trip and produce no operation in the plan.

## Description alias

`description` is an alias for `comment` on any field that supports it. Either works; `comment` takes precedence.

## Mixins

```yaml
mixins:
  - timestamps
  - soft_delete
```

See [Mixins](/schema-flow/schema/mixins/) for details.
