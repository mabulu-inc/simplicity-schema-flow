---
title: Pipeline
description: Running migrations, planning, and validation programmatically.
---

## Running migrations

```typescript
import { runAll, runPre, runMigrate, runPost, runValidate, runBaseline, runPipeline } from '@smplcty/schema-flow';

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
  executed: number;
  executedOperations: Operation[];
  dryRun: boolean;
  validated: boolean;
  preScriptsRun: number;
  postScriptsRun: number;
  /** Relative paths, in run order. */
  executedPreScripts: string[];
  executedPostScripts: string[];
  /** Why each of those scripts ran (or would run), keyed by relative path. */
  scriptChanges: Record<string, 'new' | 'changed'>;
  /** Scripts skipped because they were applied with the same content. */
  skippedScripts: number;
  skippedPreScripts: number;
  skippedPostScripts: number;
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
import { buildPlan } from '@smplcty/schema-flow';

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
import { discoverSchemaFiles, parseSchemaFile } from '@smplcty/schema-flow';
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
} from '@smplcty/schema-flow';
```

## Mixins

```typescript
import { loadMixins, applyMixins } from '@smplcty/schema-flow';

const registry = loadMixins(mixinSchemas);
const expandedTable = applyMixins(tableSchema, registry);
```

## Status

```typescript
import { getStatus } from '@smplcty/schema-flow';

const status = await getStatus(config, logger);
console.log(`Applied: ${status.appliedFiles}, Pending: ${status.pendingChanges}`);

// status.appliedByPhase: { pre, schema, post }
// status.pending: { filePath, phase, change: 'new' | 'changed' }[], in run order
// status.history: { filePath, phase, appliedAt }[]
```
