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

### Configuration (`set`) and pinning `search_path`

`set` emits one `SET <key> = <value>` clause per entry on the function, pinning a
configuration parameter for the duration of every call. The dominant use is
hardening `SECURITY DEFINER` functions.

A `SECURITY DEFINER` function runs with the **owner's** privileges but, by
default, inherits the **caller's** `search_path`. A caller who can place an
object (a table, an operator, a function such as `now()`) in a schema that
resolves earlier than the intended one can make an unqualified name inside the
function resolve to _their_ object — and it then executes with elevated
privileges. Pinning `search_path` as a function attribute closes this hole,
because the pinned path wins over anything the caller's session sets.

**Recommendation: pin `search_path` on every `SECURITY DEFINER` function.**

```yaml
name: reconcile_service_user_role
language: plpgsql
security: definer
set:
  search_path: pg_catalog, public # only these schemas resolve, in this order
body: |
  ...
```

To force every name to be fully schema-qualified — the strictest posture —
pin an empty path:

```yaml
set:
  search_path: '' # empty: no schema resolves implicitly
```

Both forms round-trip cleanly: after the first apply the function reports zero
pending operations and is never redundantly replaced. `search_path` is emitted
as a bare schema list (or a quoted empty string); every other GUC value is
single-quoted, so unit-bearing values such as `statement_timeout: '5s'` are
valid.

## Behavior

Functions are created and updated with `CREATE OR REPLACE FUNCTION`. When a property changes — body, arguments, security, volatility, cost, `SET` config, and so on — the function is replaced in place.

### Type normalization

Declared types are compared against Postgres's canonical type names, so aliases never cause spurious churn. `timestamptz`, `int8`, `varchar`, and `bool` compare equal to `timestamp with time zone`, `bigint`, `character varying`, and `boolean`. Normalization covers the return type, every `TABLE(...)` column, and each argument type — including array (`int8[]`) and `SETOF` forms. A function declared with aliases reaches zero pending operations after its first apply, and never re-emits a no-op `CREATE OR REPLACE`.

### Return-type changes

Postgres cannot change a function's return type — or the names and types of its `OUT`/`TABLE` columns — through `CREATE OR REPLACE`. When the declared return type changes, schema-flow drops and recreates the function:

- The drop is `DROP FUNCTION … CASCADE` and is [destructive](/simplicity-schema-flow/safety/destructive-protection/) — it requires `--allow-destructive`. Without the flag the change is reported as blocked instead of attempting a replace that cannot succeed.
- The `CASCADE` also removes objects that depend on the function (RLS policies, views, generated columns). Before running it, schema-flow lists those dependents and warns about any **not declared in your schema** — an ad-hoc view or policy created outside it — so they aren't dropped silently.
- After the drop, a post-apply convergence pass re-plans against the database and recreates the declared policies and views the cascade removed, so a single `run` converges. Any operation still outstanding afterwards is surfaced as a warning.
