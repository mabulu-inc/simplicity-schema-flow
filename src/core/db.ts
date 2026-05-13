/**
 * Database connection management for schema-flow.
 *
 * Provides a connection pool singleton, withClient/withTransaction helpers,
 * and retry logic for transient PostgreSQL errors.
 */

import pg from 'pg';

const { Pool } = pg;
type PoolClient = pg.PoolClient;

/** PostgreSQL error codes for transient failures that should be retried. */
export const TRANSIENT_ERROR_CODES = [
  '55P03', // lock_not_available
  '57014', // query_canceled / statement_timeout
  '40001', // serialization_failure
  '40P01', // deadlock_detected
] as const;

export interface ClientOptions {
  lockTimeout?: number;
  statementTimeout?: number;
  maxRetries?: number;
  /**
   * Postgres schema this session should operate in. When set, the connection's
   * `search_path` is configured to `"<pgSchema>", "$user", public` so that
   * unqualified references in user-provided SQL (view bodies, RLS predicates,
   * function bodies, etc.) resolve to the managed schema.
   */
  pgSchema?: string;
}

// Pool cache keyed by connection string
const pools = new Map<string, pg.Pool>();

/** Get or create a connection pool for the given connection string. */
export function getPool(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString });
    pools.set(connectionString, pool);
  }
  return pool;
}

/** Close all connection pools and clear the cache. */
export async function closePool(): Promise<void> {
  const promises = Array.from(pools.values()).map((p) => p.end());
  pools.clear();
  await Promise.all(promises);
}

/** Close and remove a specific pool from the cache. */
export async function removePool(connectionString: string): Promise<void> {
  const pool = pools.get(connectionString);
  if (pool) {
    await pool.end();
    pools.delete(connectionString);
  }
}

function isTransientError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return TRANSIENT_ERROR_CODES.includes((err as { code: string }).code as (typeof TRANSIENT_ERROR_CODES)[number]);
  }
  return false;
}

async function applySessionDefaults(client: PoolClient, opts: ClientOptions): Promise<void> {
  if (opts.pgSchema) {
    const safe = opts.pgSchema.replace(/"/g, '""');
    await client.query(`SET search_path = "${safe}", "$user", public`);
  }
  if (opts.lockTimeout !== undefined) {
    await client.query(`SET lock_timeout = ${opts.lockTimeout}`);
  }
  if (opts.statementTimeout !== undefined) {
    await client.query(`SET statement_timeout = ${opts.statementTimeout}`);
  }
}

/**
 * Check out a pool client and prime its session (`search_path`, timeouts).
 * Always prefer this over a bare `pool.connect()` so user SQL resolves names
 * inside the managed schema.
 */
export async function acquireClient(connectionString: string, opts: ClientOptions = {}): Promise<PoolClient> {
  const pool = getPool(connectionString);
  const client = await pool.connect();
  try {
    await applySessionDefaults(client, opts);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Execute a function with a pooled client. The client is automatically
 * released back to the pool when done.
 *
 * Supports retry on transient errors with exponential backoff.
 */
export async function withClient<T>(
  connectionString: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: ClientOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const pool = getPool(connectionString);
    const client = await pool.connect();
    try {
      await applySessionDefaults(client, opts);
      const result = await fn(client);
      return result;
    } catch (err) {
      if (isTransientError(err) && attempt < maxRetries) {
        // Exponential backoff: 50ms, 100ms, 200ms, ...
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('withClient: unreachable');
}

/**
 * Execute a function within a transaction. Automatically commits on success,
 * rolls back on error. Supports retry on transient errors.
 */
export async function withTransaction<T>(
  connectionString: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: ClientOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const pool = getPool(connectionString);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applySessionDefaults(client, opts);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isTransientError(err) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw new Error('withTransaction: unreachable');
}

/** Test database connectivity. Returns true if connection succeeds. */
export async function testConnection(connectionString: string): Promise<boolean> {
  try {
    // Use a direct client rather than the pool to avoid polluting the cache
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}
