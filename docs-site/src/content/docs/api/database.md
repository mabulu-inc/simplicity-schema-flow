---
title: Database utilities
description: Connection pool, transactions, and low-level database APIs.
---

## Connection management

```typescript
import { withClient, withTransaction, closePool, testConnection } from '@mabulu-inc/simplicity-schema';

// Run a function with a pooled client (auto-release)
await withClient(connectionString, async (client) => {
  const result = await client.query('SELECT 1');
});

// Run within a transaction (auto-commit on success, auto-rollback on error)
await withTransaction(connectionString, async (client) => {
  await client.query('INSERT INTO users (email) VALUES ($1)', ['a@b.com']);
  await client.query('INSERT INTO audit_log (action) VALUES ($1)', ['create_user']);
});

// Verify database connectivity
const ok = await testConnection(connectionString);

// Shut down all connection pools (call on process exit)
await closePool();
```

## Executor

```typescript
import {
  execute,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  detectInvalidIndexes,
  reindexInvalid,
} from '@mabulu-inc/simplicity-schema';

// Execute a migration plan
const result = await execute({
  connectionString,
  operations: plan.operations,
  pgSchema: 'public',
  dryRun: false,
  lockTimeout: 5000,
  statementTimeout: 30000,
  logger,
});

// Manual lock management
await withClient(connectionString, async (client) => {
  await acquireAdvisoryLock(client);
  try {
    // ... do work
  } finally {
    await releaseAdvisoryLock(client);
  }
});

// Detect and fix invalid indexes (from failed CONCURRENTLY)
await withClient(connectionString, async (client) => {
  const invalid = await detectInvalidIndexes(client, 'public');
  // invalid: InvalidIndex[]

  if (invalid.length > 0) {
    await reindexInvalid(client, 'public', logger);
  }
});
```
