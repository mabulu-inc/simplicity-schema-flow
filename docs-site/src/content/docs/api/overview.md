---
title: API overview
description: TypeScript API entry points and configuration.
---

Import from `@mabulu-inc/simplicity-schema` for the main API, or `@mabulu-inc/simplicity-schema/testing` for test helpers.

## Configuration

```typescript
import { resolveConfig, createLogger } from '@mabulu-inc/simplicity-schema';

const config = resolveConfig({
  connectionString: process.env.DATABASE_URL,
  baseDir: './schema',
  pgSchema: 'public',
});

const logger = createLogger({ verbose: true, quiet: false, json: false });
```

All `resolveConfig` fields are optional. Without `connectionString`, it reads `SIMPLICITY_SCHEMA_DATABASE_URL` then `DATABASE_URL` from the environment.

### SimplicitySchemaConfig

| Field              | Type    | Default      | Description                  |
| ------------------ | ------- | ------------ | ---------------------------- |
| `connectionString` | string  | env vars     | PostgreSQL connection string |
| `baseDir`          | string  | `'./schema'` | Root schema directory        |
| `pgSchema`         | string  | `'public'`   | Target PostgreSQL schema     |
| `dryRun`           | boolean | `false`      | Plan only                    |
| `allowDestructive` | boolean | `false`      | Allow destructive operations |
| `skipChecks`       | boolean | `false`      | Skip pre-migration checks    |
| `lockTimeout`      | number  | `5000`       | Lock timeout (ms)            |
| `statementTimeout` | number  | `30000`      | Statement timeout (ms)       |
| `maxRetries`       | number  | `3`          | Retries on transient errors  |
| `historyTable`     | string  | `'history'`  | History table name           |
| `verbose`          | boolean | `false`      | Verbose output               |
| `quiet`            | boolean | `false`      | Suppress non-error output    |
| `json`             | boolean | `false`      | JSON output                  |

## Quick example

```typescript
import { resolveConfig, runAll, createLogger } from '@mabulu-inc/simplicity-schema';

const config = resolveConfig({ connectionString: process.env.DATABASE_URL });
const logger = createLogger({ verbose: true });

const result = await runAll(config, logger);
console.log(`Executed ${result.operationsExecuted} operations`);
```
