---
title: Pipeline stages
description: How simplicity-schema processes schema definitions into SQL.
---

## Overview

```
DISCOVER -> PARSE -> EXPAND -> INTROSPECT -> PLAN -> EXECUTE
```

### 1. Discover

Glob for YAML files in conventional subdirectories (`tables/`, `enums/`, `functions/`, `views/`, `roles/`, `mixins/`) and SQL files in `pre/`, `post/`.

Each file gets a SHA-256 hash for change detection.

### 2. Parse

Read each YAML file into typed TypeScript objects. Validate required fields and apply defaults.

The parser auto-detects file type by content:

- `table:` field -> TableSchema
- `name:` + `values:` -> EnumSchema
- `name:` + `body:` -> FunctionSchema
- `name:` + `query:` -> ViewSchema or MaterializedViewSchema
- `role:` -> RoleSchema
- `extensions:` -> ExtensionsSchema
- `mixin:` -> MixinSchema

### 3. Expand

Load mixin definitions and merge their contributions (columns, indexes, triggers, policies, grants, checks) into consuming table schemas. Substitute `{table}` placeholders with table names.

### 4. Introspect

Query `pg_catalog` and `information_schema` filtered to the target `pgSchema` to read current database state:

- Tables and columns (types, defaults, nullability, generated expressions)
- Indexes (columns, uniqueness, method, WHERE, INCLUDE, opclass)
- Constraints (checks, foreign keys, unique)
- Enums (values and order)
- Functions (body, args, return type, attributes)
- Views and materialized views (query)
- Roles (attributes, memberships)
- Grants, triggers, policies, comments

### 5. Plan

Diff desired (YAML) state vs actual (DB) state. Produce an ordered list of typed `Operation` objects, each with:

- `type`: the operation type (e.g., `create_table`, `add_column`)
- `objectName`: what it operates on
- `sql`: the SQL to execute
- `phase`: execution phase (determines order)
- `concurrent`: whether to run outside transaction

Destructive operations are separated into a `blocked` list unless `allowDestructive` is true.

### 6. Execute

Run operations in phased order within transactions. See [execution phases](/simplicity-schema/architecture/execution-phases/).
