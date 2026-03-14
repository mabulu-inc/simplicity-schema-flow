---
title: Extensions
description: YAML reference for PostgreSQL extension definitions.
---

File location: `schema/extensions.yaml` (single file)

## Example

```yaml
extensions:
  - pgcrypto
  - pg_trgm
  - uuid-ossp
schema_grants:
  - to: app_user
    schemas: [public]
```

## Fields

| Field           | Type     | Required | Description                |
| --------------- | -------- | -------- | -------------------------- |
| `extensions`    | string[] | yes      | Extension names to install |
| `schema_grants` | object[] | no       | Grant `USAGE` on schemas   |

## Schema grants

```yaml
schema_grants:
  - to: app_user # role name
    schemas: [public] # schemas to grant USAGE on
```

## Behavior

- Extensions are installed with `CREATE EXTENSION IF NOT EXISTS`
- Removing an extension from the list requires `--allow-destructive`
- Extensions are installed in phase 2 (before enums and tables)
