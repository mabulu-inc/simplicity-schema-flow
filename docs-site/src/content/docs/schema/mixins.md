---
title: Mixins
description: Reusable schema fragments that compose into table definitions.
---

File location: `schema/mixins/<name>.yaml`

## Defining a mixin

```yaml
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
indexes:
  - columns: [created_at]
triggers:
  - name: set_{table}_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: update_timestamp
    for_each: ROW
checks:
  - name: chk_{table}_dates
    expression: 'updated_at >= created_at'
rls: true
force_rls: true
policies:
  - name: '{table}_owner_policy'
    for: ALL
    to: app_user
    using: 'owner_id = current_user_id()'
grants:
  - to: app_readonly
    privileges: [SELECT]
```

## Using a mixin

Tables reference mixins by name:

```yaml
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
    primary_key: true
  # timestamps columns, indexes, triggers, checks, policies, grants merged automatically
```

## What mixins can contribute

| Property    | Description                      |
| ----------- | -------------------------------- |
| `columns`   | Added before table's own columns |
| `indexes`   | Merged into table indexes        |
| `checks`    | Merged into table checks         |
| `triggers`  | Merged into table triggers       |
| `policies`  | Merged into table policies       |
| `grants`    | Merged into table grants         |
| `rls`       | Enables RLS on consuming table   |
| `force_rls` | Forces RLS on consuming table    |

## `{table}` placeholder

The `{table}` placeholder in any mixin string value is replaced with the consuming table's name. This ensures unique constraint/trigger/policy names across tables.

In the mixin:

```yaml
triggers:
  - name: set_{table}_updated_at
```

Applied to table `orders`, becomes:

```yaml
triggers:
  - name: set_orders_updated_at
```

## Merge rules

- **Columns**: Mixin columns come first. If a table defines a column with the same name as a mixin column, the table's definition wins.
- **Multiple mixins**: Applied in order. Later mixins can override earlier ones.
- **All other properties**: Concatenated (indexes, checks, triggers, policies, grants).

## Parameters

A sharable mixin often needs to reference app-specific things — the FK target for an audit column, or the GUC an audit trigger reads. Rather than hard-coding them, a mixin declares **params** with defaults; `{{name}}` placeholders are interpolated into the mixin's columns/refs/indexes/policies **and into the function bodies shipped in the same package**. This is what lets a generic package like `@smplcty/schema-std` ship `audit` without coupling to any one app's identity model.

```yaml
# @smplcty/schema-std: schema/mixins/audit.yaml
mixin: audit
params:
  user_table: { default: users }
  user_pk: { default: user_id }
  actor_guc: { default: app.actor_id }
columns:
  - name: created_by
    type: bigint
    nullable: false
    references: { table: '{{user_table}}', column: '{{user_pk}}' }
```

```yaml
# @smplcty/schema-std: schema/functions/audit_stamp.yaml — body uses the same params
name: audit_stamp
language: plpgsql
returns: text
body: |
  BEGIN
    RETURN current_setting('{{actor_guc}}', true);
  END;
```

The consuming app supplies values through [`imports[].params`](/simplicity-schema-flow/schema/imports/). Because every param has a default, the common case (`users` / `user_id` / `app.actor_id`) needs no params at all:

```yaml
# consumer config — override only what differs from the defaults
imports:
  - package: '@smplcty/schema-std'
    params: { user_table: accounts, user_pk: account_id }
```

- **Defaults** apply when no override is given — keeping the common case param-free.
- **`imports[].params`** override defaults per package.
- A param value that resolves to nothing (no default, no override) but is still referenced is an **error** naming the placeholder.
- Supplying an **import param the package never declares** is an error naming it.

`{{param}}` placeholders are distinct from the [`{table}` placeholder](#table-placeholder) above — params are resolved once per package; `{table}` is resolved per consuming table.
