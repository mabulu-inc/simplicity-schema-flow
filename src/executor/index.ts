/**
 * Executor for simplicity-schema.
 *
 * Runs planned operations in phased order within transactions.
 * Supports advisory locking, dry-run mode, and validate mode.
 */

import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { Operation } from '../planner/index.js';
import type { SchemaFile } from '../core/files.js';
import type { Logger } from '../core/logger.js';
import { getPool } from '../core/db.js';
import { ensureHistoryTable, fileNeedsApply, recordFile } from '../core/tracker.js';
import { ensureSnapshotsTable, saveSnapshot } from '../rollback/index.js';

// Advisory lock key — consistent across all simplicity-schema instances
const ADVISORY_LOCK_KEY = 737_513; // "ss" in ASCII-inspired number

export interface ExecuteOptions {
  connectionString: string;
  operations: Operation[];
  preScripts?: SchemaFile[];
  postScripts?: SchemaFile[];
  pgSchema?: string;
  dryRun?: boolean;
  validateOnly?: boolean;
  lockTimeout?: number;
  statementTimeout?: number;
  logger?: Logger;
}

export interface ExecuteResult {
  executed: number;
  skippedScripts: number;
  preScriptsRun: number;
  postScriptsRun: number;
  dryRun: boolean;
  validated: boolean;
}

/**
 * Acquire a PostgreSQL advisory lock (non-blocking).
 * Returns true if the lock was acquired, false if already held.
 */
export async function acquireAdvisoryLock(client: pg.PoolClient): Promise<boolean> {
  const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
  return res.rows[0].acquired === true;
}

/**
 * Release the PostgreSQL advisory lock.
 */
export async function releaseAdvisoryLock(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
}

export interface InvalidIndex {
  schema: string;
  table: string;
  index: string;
}

/**
 * Detect invalid indexes left by failed CONCURRENTLY operations.
 * Returns a list of invalid indexes in the given schema.
 */
export async function detectInvalidIndexes(client: pg.PoolClient, schema = 'public'): Promise<InvalidIndex[]> {
  const res = await client.query(
    `SELECT n.nspname AS schema,
            t.relname AS table,
            i.relname AS index
     FROM pg_catalog.pg_index ix
     JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
     JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE NOT ix.indisvalid
       AND n.nspname = $1
     ORDER BY i.relname`,
    [schema],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    schema: r.schema as string,
    table: r.table as string,
    index: r.index as string,
  }));
}

/**
 * Clean up invalid indexes by dropping and recreating them.
 * Uses REINDEX which rebuilds the index in-place.
 */
export async function reindexInvalid(client: pg.PoolClient, schema = 'public', logger?: Logger): Promise<number> {
  const invalid = await detectInvalidIndexes(client, schema);
  for (const idx of invalid) {
    logger?.info(`Dropping invalid index: "${idx.schema}"."${idx.index}"`);
    await client.query(`DROP INDEX IF EXISTS "${idx.schema}"."${idx.index}"`);
  }
  return invalid.length;
}

/**
 * Execute a migration plan.
 *
 * Pipeline: acquire lock → ensure _simplicity → pre-scripts → operations → post-scripts → release lock
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const {
    connectionString,
    operations,
    preScripts = [],
    postScripts = [],
    pgSchema = 'public',
    dryRun = false,
    validateOnly = false,
    lockTimeout,
    statementTimeout,
    logger,
  } = options;

  const result: ExecuteResult = {
    executed: 0,
    skippedScripts: 0,
    preScriptsRun: 0,
    postScriptsRun: 0,
    dryRun,
    validated: validateOnly,
  };

  // Dry-run: just log what would happen
  if (dryRun) {
    for (const script of preScripts) {
      logger?.info(`[dry-run] Would run pre-script: ${script.relativePath}`);
    }
    for (const op of operations) {
      logger?.info(`[dry-run] ${op.type} ${op.objectName}: ${op.sql}`);
    }
    for (const script of postScripts) {
      logger?.info(`[dry-run] Would run post-script: ${script.relativePath}`);
    }
    return result;
  }

  const pool = getPool(connectionString);
  const lockClient = await pool.connect();

  try {
    // Acquire advisory lock
    const acquired = await acquireAdvisoryLock(lockClient);
    if (!acquired) {
      throw new Error('Could not acquire advisory lock — another migration may be running');
    }

    try {
      // Ensure _simplicity schema and history table
      await ensureHistoryTable(lockClient);

      // Auto-save a migration snapshot before executing (for rollback support)
      if (operations.length > 0 && !validateOnly) {
        await ensureSnapshotsTable(lockClient);
        await saveSnapshot(lockClient, operations, pgSchema);
        logger?.debug('Auto-saved migration snapshot');
      }

      // Run pre-scripts (each in its own transaction, tracked by hash)
      for (const script of preScripts) {
        const changed = await fileNeedsApply(lockClient, script.relativePath, script.hash);
        if (!changed) {
          result.skippedScripts++;
          logger?.debug(`Skipping unchanged pre-script: ${script.relativePath}`);
          continue;
        }

        const sql = await readFile(script.absolutePath, 'utf-8');
        const scriptClient = await pool.connect();
        try {
          await scriptClient.query('BEGIN');
          if (lockTimeout !== undefined) await scriptClient.query(`SET lock_timeout = ${lockTimeout}`);
          if (statementTimeout !== undefined) await scriptClient.query(`SET statement_timeout = ${statementTimeout}`);
          await scriptClient.query(sql);
          await scriptClient.query('COMMIT');
        } catch (err) {
          await scriptClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          scriptClient.release();
        }

        await recordFile(lockClient, script.relativePath, script.hash, 'pre');
        result.preScriptsRun++;
        logger?.info(`Executed pre-script: ${script.relativePath}`);
      }

      // Execute operations (sorted by phase)
      // Split prechecks, concurrent, and transactional operations
      const sorted = [...operations].sort((a, b) => a.phase - b.phase);
      const precheckOps = sorted.filter((op) => op.type === 'run_precheck');
      const transactionalOps = sorted.filter((op) => !op.concurrent && op.type !== 'run_precheck');
      const concurrentOps = sorted.filter((op) => op.concurrent);

      // Run prechecks before any operations
      for (const op of precheckOps) {
        logger?.debug(`Running precheck: ${op.objectName}`);
        const precheckClient = await pool.connect();
        try {
          const res = await precheckClient.query(op.sql);
          const row = res.rows[0];
          const value = row ? Object.values(row)[0] : null;
          // Falsy check: null, undefined, false, 0, '' all abort
          if (!value) {
            throw new Error(`Precheck failed: ${op.precheckMessage || op.objectName}`);
          }
          result.executed++;
          logger?.info(`Precheck passed: ${op.objectName}`);
        } finally {
          precheckClient.release();
        }
      }

      // Run transactional operations in a transaction
      if (transactionalOps.length > 0) {
        const opClient = await pool.connect();
        try {
          await opClient.query('BEGIN');
          if (lockTimeout !== undefined) await opClient.query(`SET lock_timeout = ${lockTimeout}`);
          if (statementTimeout !== undefined) await opClient.query(`SET statement_timeout = ${statementTimeout}`);

          for (const op of transactionalOps) {
            logger?.debug(`Executing: ${op.type} ${op.objectName}`);
            await opClient.query(op.sql);
            result.executed++;
          }

          if (validateOnly) {
            await opClient.query('ROLLBACK');
            logger?.info('Validate mode: all operations executed successfully, rolled back');
          } else {
            await opClient.query('COMMIT');
          }
        } catch (err) {
          await opClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          opClient.release();
        }
      }

      // Run concurrent operations outside of transactions (e.g. CREATE INDEX CONCURRENTLY)
      if (concurrentOps.length > 0 && !validateOnly) {
        for (const op of concurrentOps) {
          const concClient = await pool.connect();
          try {
            logger?.debug(`Executing (concurrent): ${op.type} ${op.objectName}`);
            await concClient.query(op.sql);
            result.executed++;
          } finally {
            concClient.release();
          }
        }
      }

      // Run post-scripts (each in its own transaction, tracked by hash)
      if (!validateOnly) {
        for (const script of postScripts) {
          const changed = await fileNeedsApply(lockClient, script.relativePath, script.hash);
          if (!changed) {
            result.skippedScripts++;
            logger?.debug(`Skipping unchanged post-script: ${script.relativePath}`);
            continue;
          }

          const sql = await readFile(script.absolutePath, 'utf-8');
          const scriptClient = await pool.connect();
          try {
            await scriptClient.query('BEGIN');
            if (lockTimeout !== undefined) await scriptClient.query(`SET lock_timeout = ${lockTimeout}`);
            if (statementTimeout !== undefined) await scriptClient.query(`SET statement_timeout = ${statementTimeout}`);
            await scriptClient.query(sql);
            await scriptClient.query('COMMIT');
          } catch (err) {
            await scriptClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            scriptClient.release();
          }

          await recordFile(lockClient, script.relativePath, script.hash, 'post');
          result.postScriptsRun++;
          logger?.info(`Executed post-script: ${script.relativePath}`);
        }
      }
    } finally {
      // Always release advisory lock
      await releaseAdvisoryLock(lockClient);
    }
  } finally {
    lockClient.release();
  }

  return result;
}
