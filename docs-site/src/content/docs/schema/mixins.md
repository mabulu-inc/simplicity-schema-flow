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

```yaml
# In the mixin:
triggers:
  - name: set_{table}_updated_at

# Applied to table "orders", becomes:
triggers:
  - name: set_orders_updated_at
```

## Merge rules

- **Columns**: Mixin columns come first. If a table defines a column with the same name as a mixin column, the table's definition wins.
- **Multiple mixins**: Applied in order. Later mixins can override earlier ones.
- **All other properties**: Concatenated (indexes, checks, triggers, policies, grants).
