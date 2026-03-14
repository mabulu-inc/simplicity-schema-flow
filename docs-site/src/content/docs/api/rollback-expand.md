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
} from '@mabulu-inc/simplicity-schema';

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
  runBackfill,
  runContract,
  getExpandStatus,
} from '@mabulu-inc/simplicity-schema';

await withClient(connectionString, async (client) => {
  await ensureExpandStateTable(client);

  // Check status
  const status = await getExpandStatus(client);
  // status: ExpandState[]

  // Run backfill
  const backfillResult = await runBackfill({
    connectionString,
    table: 'users',
    column: 'email_lower',
    batchSize: 1000,
    logger,
  });

  // Complete contract
  const contractResult = await runContract({
    connectionString,
    table: 'users',
    column: 'email',
    allowDestructive: true,
    logger,
  });
});
```

### Types

```typescript
interface ExpandState {
  table: string;
  newColumn: string;
  oldColumn: string;
  status: string;
}

interface BackfillOptions {
  connectionString: string;
  table: string;
  column: string;
  batchSize?: number;
  logger: Logger;
}

interface BackfillResult {
  rowsUpdated: number;
}

interface ContractOptions {
  connectionString: string;
  table: string;
  column: string;
  allowDestructive: boolean;
  logger: Logger;
}

interface ContractResult {
  success: boolean;
}
```
