---
title: Enums
description: YAML reference for enum type definitions.
---

File location: `schema/enums/<name>.yaml`

## Example

```yaml
name: order_status
values:
  - pending
  - processing
  - shipped
  - delivered
  - cancelled
comment: 'Order lifecycle states'
```

## Fields

| Field     | Type     | Required | Description          |
| --------- | -------- | -------- | -------------------- |
| `name`    | string   | yes      | Enum type name       |
| `values`  | string[] | yes      | Enum values in order |
| `comment` | string   | no       | Description          |

## Behavior

- **Adding values**: New values appended to the end are applied automatically with `ALTER TYPE ... ADD VALUE`
- **Removing values**: Requires `--allow-destructive` flag
- **Reordering**: Not supported (PostgreSQL limitation)

## Usage in tables

Reference enum types by name in column definitions:

```yaml
# schema/tables/orders.yaml
table: orders
columns:
  - name: status
    type: order_status
    nullable: false
    default: "'pending'"
```
