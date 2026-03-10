import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { getPool } from '../../src/core/db.js';
import {
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  detectInvalidIndexes,
  reindexInvalid,
} from '../../src/executor/index.js';

describe('E2E: Concurrency and recovery', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // (1) Advisory lock — migration acquires lock, verify lock exists during execution
  it('acquires advisory lock during migration and blocks concurrent runs', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
`,
    });

    // Hold the advisory lock from a separate client
    const pool = getPool(DATABASE_URL);
    const holdClient = await pool.connect();
    try {
      const acquired = await acquireAdvisoryLock(holdClient);
      expect(acquired).toBe(true);

      // Now migration should fail because it cannot acquire the lock
      await expect(runMigration(ctx)).rejects.toThrow('Could not acquire advisory lock');
    } finally {
      await releaseAdvisoryLock(holdClient);
      holdClient.release();
    }
  });

  it('releases advisory lock after successful migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/posts.yaml': `
table: posts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: title
    type: text
`,
    });

    await runMigration(ctx);

    // After migration completes, we should be able to acquire the lock
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const acquired = await acquireAdvisoryLock(client);
      expect(acquired).toBe(true);
      await releaseAdvisoryLock(client);
    } finally {
      client.release();
    }
  });

  // (2) Transactional rollback — migration with invalid SQL rolls back all changes
  it('rolls back all changes when migration encounters invalid SQL', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First, create a valid table
    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'accounts');

    // Now add a second table that references a non-existent type, causing an error
    // Both tables' changes are in the same transaction, so adding a column
    // to the existing table AND creating a new broken table should roll back together
    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
  - name: status
    type: text
`,
      'tables/broken.yaml': `
table: broken
columns:
  - name: id
    type: serial
    primary_key: true
  - name: data
    type: nonexistent_type_that_does_not_exist
`,
    });

    // This should fail due to the invalid type
    await expect(runMigration(ctx)).rejects.toThrow();

    // The accounts table should NOT have the new 'status' column
    // because everything rolled back
    const result = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'accounts'
       ORDER BY ordinal_position`,
      [ctx.schema],
    );
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toEqual(['id', 'email']);

    // The broken table should not exist
    const tableResult = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'broken'`,
      [ctx.schema],
    );
    expect(tableResult.rowCount).toBe(0);
  });

  // (3) Hash-based change detection — run same migration twice, second run produces no operations
  it('skips re-execution when schema files have not changed', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
    nullable: false
  - name: name
    type: text
    nullable: false
`,
    });

    // First migration creates the table
    const result1 = await runMigration(ctx);
    expect(result1.executed).toBeGreaterThan(0);
    await assertTableExists(ctx, 'users');

    // Second migration with same content — no operations needed
    const result2 = await runMigration(ctx);
    expect(result2.executed).toBe(0);
  });

  // (4) Changed file re-run — modify YAML content, second run detects and applies change
  it('detects and applies changes when schema file content changes', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
    nullable: false
  - name: name
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'products');

    // Modify the YAML to add a new column
    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
    nullable: false
  - name: name
    type: text
  - name: price
    type: numeric
    nullable: true
`,
    });

    // Second migration should detect the change and add the column
    const result2 = await runMigration(ctx);
    expect(result2.executed).toBeGreaterThan(0);

    // Verify the new column exists
    const colResult = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'products' AND column_name = 'price'`,
      [ctx.schema],
    );
    expect(colResult.rowCount).toBe(1);
  });

  // (5) Invalid index detection and cleanup
  it('detects invalid indexes and reindexInvalid fixes them', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/events.yaml': `
table: events
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'events');

    // Manually create an invalid index by starting CREATE INDEX CONCURRENTLY
    // and then marking it as invalid
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      // Create a valid index first, then mark it invalid to simulate a failed CONCURRENTLY
      await client.query(`CREATE INDEX idx_events_name ON "${ctx.schema}".events (name)`);

      // Mark the index as invalid by updating pg_index
      await client.query(
        `
        UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = (
          SELECT c.oid FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'idx_events_name' AND n.nspname = $1
        )
      `,
        [ctx.schema],
      );

      // detectInvalidIndexes should find the invalid index
      const invalid = await detectInvalidIndexes(client, ctx.schema);
      expect(invalid.length).toBe(1);
      expect(invalid[0].index).toBe('idx_events_name');
      expect(invalid[0].table).toBe('events');

      // reindexInvalid should drop the invalid index
      const cleaned = await reindexInvalid(client, ctx.schema);
      expect(cleaned).toBe(1);

      // Now there should be no invalid indexes
      const afterCleanup = await detectInvalidIndexes(client, ctx.schema);
      expect(afterCleanup.length).toBe(0);
    } finally {
      client.release();
    }
  });

  // (6) Retry on transient errors — verify retry behavior
  it('retries on transient lock_timeout errors with withTransaction', async () => {
    // We test the retry mechanism by using withTransaction with maxRetries > 1
    // and triggering a lock timeout on the first attempt
    const { withTransaction } = await import('../../src/core/db.js');

    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/counters.yaml': `
table: counters
columns:
  - name: id
    type: serial
    primary_key: true
  - name: value
    type: integer
    default: "0"
`,
    });

    await runMigration(ctx);

    // Lock the table from one connection
    const pool = getPool(DATABASE_URL);
    const lockHolder = await pool.connect();
    let attempt = 0;

    try {
      // Start a transaction that holds an exclusive lock
      await lockHolder.query('BEGIN');
      await lockHolder.query(`LOCK TABLE "${ctx.schema}".counters IN ACCESS EXCLUSIVE MODE`);

      // Use withTransaction with a short lock timeout and retries
      // The first attempt(s) will fail with lock_timeout,
      // then we release the lock so the retry succeeds
      const resultPromise = withTransaction(
        DATABASE_URL,
        async (client) => {
          attempt++;
          await client.query(`INSERT INTO "${ctx.schema}".counters (value) VALUES (${attempt})`);
          return attempt;
        },
        { lockTimeout: 100, maxRetries: 3 },
      );

      // Release the lock after a short delay so the retry can succeed
      setTimeout(async () => {
        await lockHolder.query('COMMIT');
      }, 200);

      const result = await resultPromise;
      // The retry should have succeeded on attempt 2 or 3
      expect(result).toBeGreaterThan(1);
    } finally {
      // Ensure lock holder is cleaned up
      await lockHolder.query('ROLLBACK').catch(() => {});
      lockHolder.release();
    }
  });
});
