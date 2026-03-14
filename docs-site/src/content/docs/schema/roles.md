---
title: Roles
description: YAML reference for PostgreSQL role definitions.
---

File location: `schema/roles/<name>.yaml`

## Example

```yaml
role: app_readonly
login: false
superuser: false
createdb: false
createrole: false
inherit: true
bypassrls: false
replication: false
connection_limit: -1
in: [app_group]
comment: 'Read-only application role'
```

## Fields

| Field              | Type     | Default  | Description                          |
| ------------------ | -------- | -------- | ------------------------------------ |
| `role`             | string   | required | Role name                            |
| `login`            | boolean  | `false`  | Can login                            |
| `superuser`        | boolean  | `false`  | Superuser privileges                 |
| `createdb`         | boolean  | `false`  | Can create databases                 |
| `createrole`       | boolean  | `false`  | Can create roles                     |
| `inherit`          | boolean  | `true`   | Inherits privileges of granted roles |
| `bypassrls`        | boolean  | `false`  | Bypasses row-level security          |
| `replication`      | boolean  | `false`  | Can initiate replication             |
| `connection_limit` | number   | `-1`     | Max connections (`-1` = unlimited)   |
| `in`               | string[] | `[]`     | Group role memberships               |
| `comment`          | string   | --       | Description                          |

## Behavior

- New roles are created with `CREATE ROLE`
- Changed attributes are applied with `ALTER ROLE`
- Group memberships (`in`) are managed with `GRANT role TO role`
