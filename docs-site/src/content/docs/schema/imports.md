---
title: Imports & extend
description: Consume schema shipped by an npm package by reference, and extend imported tables without redeclaring them.
---

`imports` lets you consume schema **shipped by an installed package** instead of
copying its YAML into your own `schema/` directory. The installed dependency
version controls the schema — bump the dependency to get schema changes; no
copy, no drift. `extend:` then lets each app add its own columns, indexes, and
policies to a shared table without owning its definition.

## `imports` — load schema from packages

List package imports in your config file:

```yaml
# schema-flow.config.yaml
imports:
  - '@smplcty/auth'
  - '@smplcty/schema-std'

default:
  pgSchema: public
```

For each entry, schema-flow loads that package's
`node_modules/<pkg>/schema/{tables,enums,functions,views,roles,mixins,pre,post}`
as **additional sources**, merged with your local `./schema`.

- **Precedence:** imported sources load first (in listed order), then the local
  schema. So a local definition can build on imported ones.
- **Cross-source references work:** a local table can have a foreign key to an
  imported table, a local table can list an imported mixin in `mixins:`, and
  imported functions are available to local triggers.
- **Apply ordering** respects cross-source dependencies — schema-flow creates
  every table first, then adds foreign keys, so an imported `users` is in place
  before a local table that references it.

### Version pinning and `pnpm dlx`

Imports are resolved by walking up from your schema directory to find
`node_modules/<pkg>/schema`. Because your schema directory lives inside your
project, this always resolves from **your project's `node_modules`** — even
when you run `pnpm dlx @smplcty/schema-flow run`, the imported schema comes from
your installed, version-pinned dependency, not the dlx sandbox where
schema-flow itself was fetched.

A missing package, or a package that ships no `schema/` directory, fails with a
clear error naming the package.

### Parameterized imports

An import entry can be an object with `params` to supply values for a package's
[parameterized mixins](/simplicity-schema-flow/schema/mixins/#parameters) — e.g.
the FK target an `audit` mixin uses, or the GUC its trigger reads. Defaults
declared on the mixin cover the common case, so `params` is only needed to
override them:

```yaml
imports:
  - package: '@smplcty/schema-std'
    params: { user_table: accounts, user_pk: account_id, actor_guc: app.actor_id }
  - '@smplcty/auth' # bare string when no overrides are needed
```

Supplying a param the package doesn't declare is an error.

### Drift and lint

Imported objects are part of your desired state. `drift` and `lint` compare the
live database against the **merged** (imports + local) schema, so imported
tables are never reported as unmanaged or as drift.

### Conflicts

Declaring a table locally that an import already declares (without using
`extend:`) is an error that names both sources:

```
Table "users" is declared in two sources: @smplcty/auth:tables/users.yaml and
tables/users.yaml. To add columns to an imported table, use an "extend:" file
instead of re-declaring it.
```

## `extend:` — add to a table without redeclaring it

An `extend:` file augments an existing table — imported or local — without
owning its full definition. This is what lets each app add its own columns to a
shared `users`/`sessions`:

```yaml
# schema/tables/users.ext.yaml
extend: users
columns:
  - { name: display_name, type: text }
mixins: [soft_delete]
indexes:
  - { columns: [display_name] }
```

`extend:` merges `columns`, `indexes`, `checks`, `triggers`, `policies`,
`grants`, `mixins`, `seeds`, `seeds_on_conflict`, `rls`, and `force_rls` into
the named table.

- **Multiple `extend:` files for one table are allowed** — they merge in source
  order (imports first, then local).
- **Re-declaring an existing column is an error.** Column type changes go
  through a [pre-script](/simplicity-schema-flow/schema/scripts/), not `extend:`.
- **Targeting a table that doesn't exist** in any source is an error.

## Example: sharing a canonical identity schema

`@smplcty/auth` ships the canonical `users`/`sessions` tables. Two apps consume
it by reference and each adds its own columns:

```yaml
# schema-flow.config.yaml
imports:
  - '@smplcty/auth'
```

```yaml
# schema/tables/users.ext.yaml — this app's extra columns
extend: users
columns:
  - { name: marketing_opt_in, type: boolean, nullable: false, default: 'false' }
```

```yaml
# schema/tables/orders.yaml — this app's own table, FK to the imported users
table: orders
columns:
  - name: id
    type: bigint
    primary_key: true
  - name: user_id
    type: bigint
    references: { table: users, column: user_id }
```

Bumping the `@smplcty/auth` dependency picks up any changes to the canonical
`users`/`sessions` schema — no copy-paste, no drift.
