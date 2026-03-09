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

// Advisory lock key — consistent across all simplicity-schema instances
const ADVISORY_LOCK_KEY = 737_513; // "ss" in ASCII-inspired number

export interface ExecuteOptions {
  connectionString: string;
  operations: Operation[];
  preScripts?: SchemaFile[];
  postScripts?: SchemaFile[];
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

      // Execute operations (sorted by phase) in a transaction
      const sorted = [...operations].sort((a, b) => a.phase - b.phase);

      if (sorted.length > 0) {
        const opClient = await pool.connect();
        try {
          await opClient.query('BEGIN');
          if (lockTimeout !== undefined) await opClient.query(`SET lock_timeout = ${lockTimeout}`);
          if (statementTimeout !== undefined) await opClient.query(`SET statement_timeout = ${statementTimeout}`);

          for (const op of sorted) {
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
