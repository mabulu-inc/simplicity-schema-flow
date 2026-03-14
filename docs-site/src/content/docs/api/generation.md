---
title: Generation
description: Generating YAML, SQL, and ERD diagrams programmatically.
---

## Generate YAML from database

```typescript
import { generateFromDb } from '@mabulu-inc/simplicity-schema';

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
import { generateSql, generateSqlFile, formatMigrationSql } from '@mabulu-inc/simplicity-schema';

// Get SQL as string
const sql = generateSql(plan);

// Write to file
await generateSqlFile(plan, 'migration.sql');

// Format operations as SQL
const formatted = formatMigrationSql(operations);
```

Output includes:

- Transaction grouping (`BEGIN`/`COMMIT`)
- `CONCURRENTLY` operations outside transactions
- Phase and operation type comments
- Blocked operations as comments

## Generate ERD

```typescript
import { generateErd } from '@mabulu-inc/simplicity-schema';

const mermaid = generateErd(tables);
// Returns Mermaid ER diagram string
```

Output includes:

- Tables with column names, types, PK/FK markers, and comments
- Foreign key relationships with correct cardinality
- Composite primary key support

## Scaffold

```typescript
import { scaffoldInit, scaffoldPre, scaffoldPost, scaffoldMixin } from '@mabulu-inc/simplicity-schema';

// Create project directory structure
scaffoldInit('./schema');

// Create timestamped templates
scaffoldPre('./schema', 'cleanup');
scaffoldPost('./schema', 'refresh-views');
scaffoldMixin('./schema', 'timestamps');
```
