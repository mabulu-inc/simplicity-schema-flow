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
  # Table-level unique constraints are declared under `indexes:` with
  # `as_constraint: true` — also the only place `deferrable:` is legal
  # (Postgres requires a constraint, not a bare unique index, for deferral).
  - columns: [email, tenant_id]
    name: uq_users_email_tenant
    unique: true
    as_constraint: true
    nulls_not_distinct: true

checks:
  - name: email_not_empty
    expression: 'length(email) > 0'

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

mixins:
  - timestamps

comment: 'Core user accounts table'
```

## Table-level keys

Every key a table file accepts. `table` and `columns` are required; the rest are
optional. Each has its own section below or its own page.

| Key                     | Type    | Description                                                                                                |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `table`                 | string  | Table name (required)                                                                                      |
| `columns`               | list    | Column definitions — see [Columns](#columns) (required)                                                    |
| `primary_key`           | list    | Composite primary key columns (alternative to column-level `primary_key`)                                  |
| `primary_key_name`      | string  | Custom primary-key constraint name                                                                         |
| `indexes`               | list    | Indexes, including table-level unique constraints (`as_constraint`)                                        |
| `checks`                | list    | Named check constraints                                                                                    |
| `foreign_keys`          | list    | Composite (multi-column) foreign keys — see [Composite foreign keys](#composite-foreign-keys)              |
| `exclusion_constraints` | list    | Exclusion constraints                                                                                      |
| `triggers`              | list    | Triggers                                                                                                   |
| `rls`                   | boolean | Enable row-level security                                                                                  |
| `force_rls`             | boolean | Force RLS for the table owner too                                                                          |
| `policies`              | list    | RLS policies                                                                                               |
| `grants`                | list    | Privilege grants                                                                                           |
| `prechecks`             | list    | Pre-apply assertions that must hold before the migration runs                                              |
| `seeds`                 | list    | Insert-only seed rows — see [Seeds](/simplicity-schema-flow/schema/seeds/)                                 |
| `mixins`                | list    | Reusable column/constraint sets — see [Mixins](/simplicity-schema-flow/schema/mixins/)                     |
| `partition_by`          | object  | Declarative partitioning — see [Partitioning](/simplicity-schema-flow/schema/partitioning/)                |
| `partitions`            | object  | pg_partman rolling-partition maintenance                                                                   |
| `bootstrap`             | boolean | Apply this table in the bootstrap transaction — see [Bootstrap](/simplicity-schema-flow/schema/bootstrap/) |
| `comment`               | string  | Table comment (alias: `description`)                                                                       |

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
| `using`       | string  | --      | Cast expression for a `type` change (see below) |
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

### Changing a column's type

When a column's `type` changes, schema-flow emits
`ALTER COLUMN … TYPE … USING <expr>`. By default the `USING` expression is
`"<col>"::<newtype>` — an explicit cast that handles the common non-auto-castable
pairs PostgreSQL rejects without one (`text` → `jsonb`, `text` → `integer`,
`text` → an enum, …) while staying a no-op for binary-coercible changes like
`varchar` → `text`.

For casts that need custom logic, set `using:` to your own SQL expression. It is
substituted verbatim into the `USING` clause:

```yaml
- name: format
  type: jsonb
  using: "NULLIF(format, '')::jsonb" # treat empty strings as NULL
```

`using:` is only applied when the type actually changes; it is ignored otherwise.

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

Changing a foreign key's referential actions (`on_delete`/`on_update`), target,
or deferrability is reconciled in place: PostgreSQL has no `ALTER` for these, so
schema-flow drops and re-adds the constraint in the same run. (A change re-adds
immediately and isn't treated as destructive; removing a foreign key entirely is
gated behind `--allow-destructive`.)

### Composite foreign keys

A foreign key that spans **two or more columns** is declared in a table-level
`foreign_keys:` block, using a local→referenced column `map` (so the two column
lists can't fall out of alignment):

```yaml
foreign_keys:
  - references: tenant_roles # table name, or { table, schema } for cross-schema
    map: # localColumn: referencedColumn
      tenant_id: t_id
      role_id: r_id
    on_delete: RESTRICT # optional — same actions as column-level references
    on_update: CASCADE # optional
    name: fk_user_roles_tenant_role # optional, auto-generated if omitted
    deferrable: false # optional
    initially_deferred: false # optional
```

The referenced columns must form a primary key or unique constraint on the
target table. Single-column foreign keys belong on the column as `references:`
(above) — a single-entry `map:` is rejected with a pointer to that form.
Composite keys are introspected, diffed, reconciled, and `generate`-round-tripped
just like single-column ones.

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

See [expand/contract migrations](/simplicity-schema-flow/safety/expand-contract/) for details.

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
On a [partitioned parent](/simplicity-schema-flow/schema/partitioning/) a plain
`CREATE INDEX` is emitted instead, since Postgres forbids `CONCURRENTLY` there.

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

### Expression keys

An index key can be an arbitrary SQL expression instead of a plain column —
use the object form `{ expression: … }`. Postgres wraps the expression in
parentheses (`CREATE INDEX … ((lower(email))))`) so it can be used to satisfy
queries that filter or order by that expression:

```yaml
indexes:
  - name: idx_users_lower_email
    columns:
      - expression: lower(email)
```

Expression keys can be mixed with plain columns in the same index. The diff
normalizes each expression (whitespace and case) before comparing, so the form
Postgres re-renders on introspection doesn't churn against your YAML.

### GiST interval / validity indexes

Tables that model entity history as half-open validity intervals —
`[valid_from, valid_to)`, with `valid_to IS NULL` meaning "current" — resolve
point-in-time reads by interval containment (_"which interval contains instant
`T`?"_). The read-optimal shape is a **GiST index over a range**, keyed
alongside a scalar tenant column so the scan stays tenant-selective under RLS.
Sharing a GiST index between a scalar (`bigint tenant_id`) and a range requires
the [`btree_gist`](/simplicity-schema-flow/schema/extensions/) extension.

Materialize the range as a `STORED` [generated column](#generated-columns) and
key a `gist` index on `(tenant_id, state_range)`:

```yaml
# schema/extensions.yaml
extensions:
  - btree_gist
```

```yaml
# schema/tables/entity_state.yaml
table: entity_state
columns:
  - name: tenant_id
    type: bigint
    nullable: false
  - name: valid_from
    type: timestamptz
    nullable: false
  - name: valid_to
    type: timestamptz
  - name: state_range
    type: tstzrange
    generated: tstzrange(valid_from, valid_to)
indexes:
  - name: idx_entity_state_range
    method: gist
    columns: [tenant_id, state_range]
```

Point-in-time reads then use the range containment operator — `O(log n)`,
exactly one row per entity per instant:

```sql
SELECT * FROM entity_state
WHERE tenant_id = $1 AND state_range @> $2::timestamptz;
```

Prefer not to add a column? Key the GiST index on an
[expression](#expression-keys) instead — `expression: tstzrange(valid_from,
valid_to)`. Either form re-applies as a clean no-op.

### Reconciling a same-named constraint

When a declared index's name matches an object already in the database whose
definition differs, schema-flow drops the existing object and builds the
declared one. The common case is migrating a plain `UNIQUE` constraint to a
**partial** unique index — declaring `unique: true` with a `where:` predicate
(for example `where: 'deleted_at IS NULL'`, so a name frees up after a
soft-delete) under the same name as an existing `UNIQUE (col)` constraint.

The drop is [destructive](/simplicity-schema-flow/safety/destructive-protection/)
and requires `--allow-destructive`. Without the flag the change is reported as
blocked rather than left silently unapplied.

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

Declare reference/lookup rows that schema-flow keeps present on every apply:

```yaml
seeds:
  - id: '00000000-0000-0000-0000-000000000001'
    email: 'admin@example.com'
    name: 'Admin'
    created_at: !sql now() # SQL expression
```

Seeds are insert-only. See [Seeds](/simplicity-schema-flow/schema/seeds/) for match-key resolution, SQL-expression values, and the serial/identity sequence caveat.

## Bootstrap phase

Mark a table `bootstrap: true` to apply and seed it in a transaction that **commits before the main apply transaction** — for rows the rest of the migration depends on:

```yaml
table: users
bootstrap: true
columns:
  - { name: user_id, type: serial, primary_key: true }
  - { name: name, type: varchar(100), nullable: false }
seeds:
  - { name: app-init }
```

See [Bootstrap tables & sessions](/simplicity-schema-flow/schema/bootstrap/) for the apply ordering, the no-FK-to-non-bootstrap rule, the trigger-vs-function gotcha, and `bootstrapSession`.

## Description alias

`description` is an alias for `comment` on any field that supports it. Either works; `comment` takes precedence.

## Partitioned tables

A table can declare `partition_by` to become a partitioned parent, with optional
pg_partman-driven rolling partitions. Foreign keys and indexes declared on the
parent propagate to every partition.

See [Partitioned tables](/simplicity-schema-flow/schema/partitioning/) for details.

## Mixins

```yaml
mixins:
  - timestamps
  - soft_delete
```

See [Mixins](/simplicity-schema-flow/schema/mixins/) for details.
