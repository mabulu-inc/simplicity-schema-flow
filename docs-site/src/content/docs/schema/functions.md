---
title: Functions
description: YAML reference for PostgreSQL function definitions.
---

File location: `schema/functions/<name>.yaml`

## Example

```yaml
name: update_timestamp
language: plpgsql
returns: trigger
args:
  - name: target_column
    type: text
    mode: IN
    default: "'updated_at'"
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
security: invoker
volatility: volatile
parallel: unsafe
strict: false
leakproof: false
cost: 100
rows: 0
set:
  search_path: public
grants:
  - to: app_user
    privileges: [EXECUTE]
comment: 'Auto-update timestamp trigger function'
```

## Fields

### Required

| Field      | Type   | Description                                                              |
| ---------- | ------ | ------------------------------------------------------------------------ |
| `name`     | string | Function name                                                            |
| `language` | string | `plpgsql`, `sql`, etc.                                                   |
| `returns`  | string | Return type (`trigger`, `void`, `text`, `integer`, `SETOF record`, etc.) |
| `body`     | string | Function body                                                            |

### Optional

| Field        | Type     | Default    | Description                                  |
| ------------ | -------- | ---------- | -------------------------------------------- |
| `args`       | object[] | `[]`       | Function arguments                           |
| `security`   | string   | `invoker`  | `invoker` or `definer`                       |
| `volatility` | string   | `volatile` | `volatile`, `stable`, or `immutable`         |
| `parallel`   | string   | `unsafe`   | `unsafe`, `safe`, or `restricted`            |
| `strict`     | boolean  | `false`    | `RETURNS NULL ON NULL INPUT`                 |
| `leakproof`  | boolean  | `false`    | Leakproof flag                               |
| `cost`       | number   | --         | Estimated execution cost                     |
| `rows`       | number   | --         | Estimated rows for set-returning functions   |
| `set`        | object   | --         | Configuration parameters (`SET key = value`) |
| `grants`     | object[] | --         | Function-level grants                        |
| `comment`    | string   | --         | Description                                  |

### Arguments

```yaml
args:
  - name: user_id
    type: uuid
    mode: IN # IN (default) | OUT | INOUT | VARIADIC
    default: null # optional default value
```

### Grants

```yaml
grants:
  - to: app_user
    privileges: [EXECUTE]
```

## Behavior

Functions are created with `CREATE OR REPLACE FUNCTION`. When any property changes (body, args, return type, security, volatility, etc.), the function is replaced.
