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
member_of: [app_group]
comment: 'Read-only application role'
```

## Fields

| Field         | Type     | Default  | Description                          |
| ------------- | -------- | -------- | ------------------------------------ |
| `role`        | string   | required | Role name                            |
| `login`       | boolean  | `false`  | Can login                            |
| `superuser`   | boolean  | `false`  | Superuser privileges                 |
| `createdb`    | boolean  | `false`  | Can create databases                 |
| `createrole`  | boolean  | `false`  | Can create roles                     |
| `inherit`     | boolean  | `true`   | Inherits privileges of granted roles |
| `bypassrls`   | boolean  | `false`  | Bypasses row-level security          |
| `replication` | boolean  | `false`  | Can initiate replication             |
| `member_of`   | string[] | `[]`     | Roles this role is a member of       |
| `comment`     | string   | --       | Description                          |

## Behavior

- New roles are created with `CREATE ROLE`
- Changed attributes are applied with `ALTER ROLE`

## Role membership

`member_of` declares the roles this role is a member of. Each entry becomes a
`GRANT <parent> TO <this role>`, so the role inherits everything granted to its
parents. This is the way to avoid duplicating per-table grants across roles —
declare the grants once on `app_user`, then make `app_admin` a member of it:

```yaml
role: app_admin
login: true
member_of:
  - app_user
```

> `in:` is an older alias for `member_of:` and still works; `member_of:` is the
> preferred spelling. If both are present, `member_of:` wins.

### Apply ordering and cycles

Roles are applied in a topological order derived from `member_of`, so a parent
is always created before any role that is a member of it — you don't have to
order the YAML files or pre-create parents. A circular `member_of` graph is
rejected at `plan` time, naming the cycle, rather than failing mid-`apply`.

(Parents that aren't declared in your schema impose no ordering — they're
expected to already exist in the database.)

### Removing a membership

`member_of` is reconciled to exactly what you declare. Removing an entry (or
setting `member_of: []`) emits the inverse `REVOKE <parent> FROM <this role>`.
Because a revoke removes a privilege, it is a destructive operation and only
runs with `--allow-destructive`; otherwise it's reported as blocked.

Omitting the `member_of` field entirely leaves the role's existing memberships
untouched — same rule the attribute diff uses for unset fields.
