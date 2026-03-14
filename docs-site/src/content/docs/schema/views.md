---
title: Views
description: YAML reference for regular and materialized view definitions.
---

File location: `schema/views/<name>.yaml`

## Regular views

```yaml
name: active_users
query: |
  SELECT id, email, name
  FROM users
  WHERE deleted_at IS NULL
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: 'Users who have not been soft-deleted'
```

### Fields

| Field     | Type     | Required | Description      |
| --------- | -------- | -------- | ---------------- |
| `name`    | string   | yes      | View name        |
| `query`   | string   | yes      | SQL SELECT query |
| `grants`  | object[] | no       | Access grants    |
| `comment` | string   | no       | Description      |

Views are created with `CREATE OR REPLACE VIEW`. When the query changes, the view is replaced.

## Materialized views

```yaml
name: user_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM orders
  GROUP BY user_id
indexes:
  - columns: [user_id]
    unique: true
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: 'Aggregated user order statistics'
```

### Additional fields

| Field          | Type     | Required | Description                      |
| -------------- | -------- | -------- | -------------------------------- |
| `materialized` | `true`   | yes      | Must be `true`                   |
| `indexes`      | object[] | no       | Indexes on the materialized view |

### Behavior

- When a materialized view's query changes, the tool drops and recreates it, then refreshes the data
- Indexes, grants, and comments are applied after creation
- Index format is the same as [table indexes](/simplicity-schema/schema/tables/#indexes)
