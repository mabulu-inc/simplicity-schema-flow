---
title: Rollback & expand
description: Rollback and expand/contract APIs.
---

## Rollback

```typescript
import {
  ensureSnapshotsTable,
  saveSnapshot,
  getLatestSnapshot,
  listSnapshots,
  deleteSnapshot,
  computeRollback,
  runDown,
} from '@smplcty/schema-flow';

// Execute rollback
const result = await runDown(config, logger);

// Manual snapshot management
await withClient(connectionString, async (client) => {
  await ensureSnapshotsTable(client);

  const snapshots = await listSnapshots(client);
  const latest = await getLatestSnapshot(client);

  if (latest) {
    const reverseOps = computeRollback(latest);
    // reverseOps: Operation[]
  }

  await deleteSnapshot(client, snapshotId);
});
```

### Types

```typescript
interface MigrationSnapshot {
  id: string;
  operations: Operation[];
  createdAt: Date;
}

interface RollbackResult {
  success: boolean;
  operationsExecuted: number;
  errors: string[];
}
```

## Expand/contract

```typescript
import {
  ensureExpandStateTable,
  planExpandColumn,
  recordExpandState,
  runBackfill,
  runBackfillAll,
  checkBackfillComplete,
  runContract,
  getExpandStatus,
} from '@smplcty/schema-flow';

// Drain all pending backfills (the equivalent of `schema-flow backfill`).
const result = await runBackfillAll({
  connectionString,
  pgSchema: 'public',
  table: 'users', // optional filter
  column: 'users.email_lower', // optional filter
  concurrency: 1, // default
  logger,
});
// result: { processed, totalRowsUpdated, perState }

// Backfill a single column.
const backfillResult = await runBackfill({
  connectionString,
  tableName: 'users',
  newColumn: 'email_lower',
  transform: 'lower(email)',
  pgSchema: 'public',
  batchSize: 1000,
  logger,
});

// Verify the contract gate manually.
await withClient(connectionString, async (client) => {
  const states = await getExpandStatus(client);
  for (const state of states.filter((s) => s.status === 'expanded')) {
    const remaining = await checkBackfillComplete(client, state);
    console.log(`${state.table_name}.${state.new_column}: ${remaining} row(s) remaining`);
  }
});

// Complete the contract phase.
const contractResult = await runContract({
  connectionString,
  tableName: 'users',
  newColumn: 'email_lower',
  pgSchema: 'public',
  force: false, // pass true to bypass the divergence-count gate (DATA LOSS RISK)
  logger,
});
```

### Types

```typescript
interface ExpandState {
  id: number;
  table_name: string; // qualified "schema.table"
  new_column: string;
  old_column: string;
  transform: string;
  trigger_name: string;
  status: 'expanded' | 'contracted';
  created_at: Date;
}

interface BackfillOptions {
  connectionString: string;
  tableName: string;
  newColumn: string;
  transform: string;
  pgSchema?: string;
  batchSize?: number;
  logger?: Logger;
}

interface BackfillResult {
  rowsUpdated: number;
}

interface BackfillAllOptions {
  connectionString: string;
  pgSchema?: string;
  table?: string;
  column?: string; // "table.column"
  concurrency?: number;
  batchSize?: number;
  logger?: Logger;
}

interface BackfillAllResult {
  processed: number;
  totalRowsUpdated: number;
  perState: { table: string; column: string; rowsUpdated: number }[];
}

interface ContractOptions {
  connectionString: string;
  tableName: string;
  newColumn: string;
  pgSchema?: string;
  force?: boolean;
  logger?: Logger;
}

interface ContractResult {
  dropped: boolean;
  oldColumn: string;
  triggerDropped: boolean;
  forced: boolean;
  rowsDiverged: number;
}
```

## Invariant

The same predicate governs the trigger, the backfill loop, and the contract gate:

```
new_col IS DISTINCT FROM (transform_expression)
```

It is null-safe: identity renames of nullable columns work without infinite-looping, and the contract gate correctly accepts rows where both columns are `NULL`.
