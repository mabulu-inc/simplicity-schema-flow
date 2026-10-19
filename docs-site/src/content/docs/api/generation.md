---
title: Generation
description: Generating YAML, SQL, and ERD diagrams programmatically.
---

## Generate YAML from database

```typescript
import { generateFromDb } from '@smplcty/schema-flow';

const files = await generateFromDb({
  connectionString,
  pgSchema: 'public',
  outputDir: './schema',
  seeds: ['users', 'roles'], // optional: tables to include seed data for
});
// files: GeneratedFile[]
```

## Generate SQL from plan

```typescript
import { generateSql, generateSqlFile, formatMigrationSql } from '@smplcty/schema-flow';

// Get SQL as string
const sql = generateSql(plan);

// Write to file
await generateSqlFile(plan, 'migration.sql');

// Format operations as SQL
const formatted = formatMigrationSql(operations);
```

Output includes:

- Phase comments
- `CONCURRENTLY` operations after the rest, outside any transaction
- Blocked (destructive) operations as commented-out SQL at the end

Options (`GenerateSqlOptions`):

- `wrapInTransaction` (default `false`): wrap the statements in `BEGIN`/`COMMIT`
- `includeBlocked` (default `true`): append blocked operations; `false` leaves them out

## Generate ERD

```typescript
import { generateErd } from '@smplcty/schema-flow';

const mermaid = generateErd(tables);
// Returns Mermaid ER diagram string
```

Output includes:

- Tables with column names, types, PK/FK markers, and comments
- Foreign key relationships with correct cardinality
- Composite primary key support

## Scaffold

```typescript
import { scaffoldInit, scaffoldPre, scaffoldPost, scaffoldMixin } from '@smplcty/schema-flow';

// Create project directory structure
scaffoldInit('./schema');

// Create timestamped templates
scaffoldPre('./schema', 'cleanup');
scaffoldPost('./schema', 'refresh-views');
scaffoldMixin('./schema', 'timestamps');
```
