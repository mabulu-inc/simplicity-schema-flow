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
options:
  security_invoker: true
  check_option: cascaded
triggers:
  - name: active_users_instead_insert
    timing: INSTEAD OF
    events: [INSERT]
    function: redirect_active_users_insert
    for_each: ROW
grants:
  - to: app_readonly
    privileges: [SELECT]
comment: 'Users who have not been soft-deleted'
```

### Fields

| Field      | Type     | Required | Description                     |
| ---------- | -------- | -------- | ------------------------------- |
| `name`     | string   | yes      | View name                       |
| `query`    | string   | yes      | SQL SELECT query                |
| `options`  | object   | no       | View options (`WITH` clause)    |
| `triggers` | object[] | no       | INSTEAD OF triggers on the view |
| `grants`   | object[] | no       | Access grants                   |
| `comment`  | string   | no       | Description                     |

Views are created with `CREATE OR REPLACE VIEW`. When the query changes, the view is replaced.

### View options

The `options` field maps to the `WITH (...)` clause on the view. Supported keys:

| Key                | Type                  | Description                                                                                                               |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `security_barrier` | boolean               | Prevents leaking rows through user-defined functions in `WHERE` clauses. Useful for security-defining views.              |
| `security_invoker` | boolean               | Runs the view query with the permissions of the _calling_ user, not the view owner (PostgreSQL 15+).                      |
| `check_option`     | `local` \| `cascaded` | Rejects `INSERT`/`UPDATE` through the view if the resulting row would not be visible. `cascaded` checks nested views too. |

```yaml
options:
  security_barrier: true
  security_invoker: true
  check_option: cascaded
```

### View triggers

Regular views support `INSTEAD OF` triggers, which intercept `INSERT`, `UPDATE`, or `DELETE` operations on the view and redirect them to the underlying tables.

Each trigger entry uses the same format as [table triggers](/simplicity-schema-flow/schema/tables/#triggers), but the `timing` field must be `INSTEAD OF`.

```yaml
triggers:
  - name: active_users_instead_insert
    timing: INSTEAD OF
    events: [INSERT]
    function: redirect_active_users_insert
    for_each: ROW
  - name: active_users_instead_update
    timing: INSTEAD OF
    events: [UPDATE]
    function: redirect_active_users_update
    for_each: ROW
```

| Field      | Type     | Required | Description                                     |
| ---------- | -------- | -------- | ----------------------------------------------- |
| `name`     | string   | yes      | Trigger name                                    |
| `timing`   | string   | yes      | Must be `INSTEAD OF` for view triggers          |
| `events`   | string[] | yes      | `INSERT`, `UPDATE`, `DELETE` (one or more)      |
| `function` | string   | yes      | Trigger function to execute                     |
| `for_each` | string   | no       | `ROW` (default) or `STATEMENT`                  |
| `when`     | string   | no       | SQL condition (not supported with `INSTEAD OF`) |
| `comment`  | string   | no       | Description                                     |

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
- Index format is the same as [table indexes](/simplicity-schema-flow/schema/tables/#indexes)
