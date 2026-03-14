---
title: Pipeline
description: Running migrations, planning, and validation programmatically.
---

## Running migrations

```typescript
import {
  runAll,
  runPre,
  runMigrate,
  runPost,
  runValidate,
  runBaseline,
  runPipeline,
} from '@mabulu-inc/simplicity-schema';

// Full pipeline: pre -> migrate -> post
const result = await runAll(config, logger);

// Individual phases
await runPre(config, logger);
await runMigrate(config, logger);
await runPost(config, logger);

// Validate: runs in a rolled-back transaction
await runValidate(config, logger);

// Baseline: record current files without running migrations
await runBaseline(config, logger);
```

### `runPipeline` with options

```typescript
const result = await runPipeline(config, logger, {
  phaseFilter: 'migrate', // 'pre' | 'migrate' | 'post'
  validateOnly: true, // execute in rolled-back transaction
});
```

### ExecuteResult

```typescript
interface ExecuteResult {
  success: boolean;
  operationsExecuted: number;
  errors: string[];
}
```

### BaselineResult

```typescript
interface BaselineResult {
  filesRecorded: number;
}
```

## Planning

```typescript
import { buildPlan } from '@mabulu-inc/simplicity-schema';

const plan = buildPlan(desired, actual, {
  allowDestructive: false,
  pgSchema: 'public',
});

console.log(`${plan.operations.length} operations`);
console.log(`${plan.blocked.length} blocked (destructive)`);
```

### Operation

```typescript
interface Operation {
  type: OperationType;
  objectName: string;
  sql: string;
  phase: number;
  concurrent?: boolean;
}
```

## File discovery and parsing

```typescript
import { discoverSchemaFiles, parseSchemaFile } from '@mabulu-inc/simplicity-schema';
import { readFile } from 'node:fs/promises';

const discovered = await discoverSchemaFiles('./schema');

for (const file of discovered.schema) {
  const content = await readFile(file.absolutePath, 'utf-8');
  const parsed = parseSchemaFile(content);
  // parsed.kind: 'table' | 'enum' | 'function' | 'view' | ...
  // parsed.schema: the typed schema object
}
```

### Individual parsers

```typescript
import {
  parseTable,
  parseEnum,
  parseFunction,
  parseView,
  parseRole,
  parseExtensions,
  parseMixin,
  parseTableFile,
  parseFunctionFile,
  parseEnumFile,
  parseViewFile,
  parseRoleFile,
} from '@mabulu-inc/simplicity-schema';
```

## Mixins

```typescript
import { loadMixins, applyMixins } from '@mabulu-inc/simplicity-schema';

const registry = loadMixins(mixinSchemas);
const expandedTable = applyMixins(tableSchema, registry);
```

## Status

```typescript
import { getStatus } from '@mabulu-inc/simplicity-schema';

const status = await getStatus(config, logger);
console.log(`Applied: ${status.appliedFiles}, Pending: ${status.pendingChanges}`);

// status.history: { filePath, phase, appliedAt }[]
```
