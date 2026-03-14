---
title: Introspection
description: Reading current database state programmatically.
---

## Functions

```typescript
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
  withClient,
} from '@mabulu-inc/simplicity-schema';

await withClient(connectionString, async (client) => {
  // List object names
  const tables = await getExistingTables(client, 'public'); // string[]
  const enums = await getExistingEnums(client, 'public'); // EnumSchema[]
  const functions = await getExistingFunctions(client, 'public'); // FunctionSchema[]
  const views = await getExistingViews(client, 'public'); // ViewSchema[]
  const matViews = await getExistingMaterializedViews(client, 'public'); // MaterializedViewSchema[]
  const roles = await getExistingRoles(client); // RoleSchema[]

  // Full table introspection
  const tableSchema = await introspectTable(client, 'users', 'public');
  // Returns: TableSchema with columns, indexes, constraints, triggers, policies, grants, comments
});
```

## What's introspected

`introspectTable` reads from `pg_catalog` and `information_schema`:

- Column names, types, defaults, nullability, generated expressions
- Primary key (columns and constraint name)
- Indexes (columns, uniqueness, method, WHERE, INCLUDE, opclass)
- Check constraints (name, expression)
- Foreign keys (columns, referenced table/column, ON DELETE/UPDATE, deferrable)
- Unique constraints
- Triggers (name, timing, events, function, for_each, when)
- RLS status and policies
- Grants (table-level, column-level)
- Comments on all objects
