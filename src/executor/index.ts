/**
 * Executor for schema-flow.
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
import { recordExpandState } from '../expand/index.js';

// Advisory lock key — consistent across all schema-flow instances
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
  /**
   * Optional callback invoked after pre-scripts execute. Returns the operation
   * list to apply, computed against the post-pre-script DB state. Pre-scripts
   * routinely mutate the DB in ways the original plan can't reflect (e.g.
   * column renames the planner cannot express declaratively), so the apply
   * phase must use a fresh plan or it collides with state the pre-script
   * already established. (Issue #28.)
   */
  replanAfterPreScripts?: () => Promise<Operation[]>;
}

export interface ExecuteResult {
  executed: number;
  skippedScripts: number;
  preScriptsRun: number;
  postScriptsRun: number;
  dryRun: boolean;
  validated: boolean;
  /** Operations that were executed (for output reporting) */
  executedOperations: Operation[];
}

/**
 * Run an operation's SQL inside a context wrapper that, on failure,
 * prepends the operation type, object name, and SQL to the error
 * message. The original error is rethrown (not replaced) so callers
 * that inspect `.code`, `.detail`, etc. on Postgres errors keep
 * working. (Issue #27.)
 */
async function withOpContext<T>(op: Operation, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error) {
      err.message = `${op.type} ${op.objectName}: ${err.message}\n  SQL: ${op.sql}`;
    }
    throw err;
  }
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

interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

function isSqlExpression(val: unknown): val is { __sql: string } {
  return (
    typeof val === 'object' && val !== null && '__sql' in val && typeof (val as { __sql: string }).__sql === 'string'
  );
}

/**
 * Execute a seed_table operation using bulk JSONB upsert.
 * Two round-trips per table: UPDATE changed rows, INSERT new rows.
 */
async function executeSeedTable(client: pg.PoolClient, op: Operation, pgSchema: string): Promise<SeedResult> {
  const { seedRows, seedColumns, seedOnConflict } = op;
  if (!seedRows || !seedColumns || seedRows.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  const table = op.objectName;
  const pkCols = seedColumns.filter((c) => c.isPk);
  const nonPkCols = seedColumns.filter((c) => !c.isPk);

  // Check if any values contain SQL expressions
  const sqlExpressions = new Map<string, Map<number, string>>(); // col -> (rowIdx -> sql)
  for (let i = 0; i < seedRows.length; i++) {
    for (const col of seedColumns) {
      const val = seedRows[i][col.name];
      if (isSqlExpression(val)) {
        if (!sqlExpressions.has(col.name)) sqlExpressions.set(col.name, new Map());
        sqlExpressions.get(col.name)!.set(i, val.__sql);
      }
    }
  }

  // Build JSONB data (replace SQL expressions with null in JSONB)
  const jsonbData = seedRows.map((row, idx) => {
    const obj: Record<string, unknown> = { _idx: idx };
    for (const col of seedColumns) {
      const val = row[col.name];
      if (isSqlExpression(val)) {
        obj[col.name] = null; // placeholder — SQL expression injected in query
      } else {
        obj[col.name] = val;
      }
    }
    return obj;
  });

  // Build column extraction expressions for the CTE
  const colExtractions = seedColumns.map((col) => {
    const sqlExprs = sqlExpressions.get(col.name);
    if (sqlExprs) {
      if (sqlExprs.size === seedRows.length) {
        // All rows have the same SQL expression — just use it directly
        const expr = sqlExprs.values().next().value;
        return `${expr} AS "${col.name}"`;
      }
      // Mixed: use CASE with row index
      const cases = [...sqlExprs.entries()]
        .map(([idx, expr]) => `WHEN (elem->>'_idx')::integer = ${idx} THEN ${expr}`)
        .join(' ');
      return `CASE ${cases} ELSE (elem->>'${col.name}')::${col.type} END AS "${col.name}"`;
    }
    return `(elem->>'${col.name}')::${col.type} AS "${col.name}"`;
  });

  const dataCte = `WITH data AS (
  SELECT ${colExtractions.join(',\n    ')}
  FROM jsonb_array_elements($1::jsonb) AS elem
)`;

  let updated = 0;

  // UPDATE changed rows (skip if DO NOTHING or no non-PK columns)
  if (seedOnConflict !== 'DO NOTHING' && nonPkCols.length > 0) {
    const setClauses = nonPkCols.map((c) => `"${c.name}" = d."${c.name}"`).join(', ');
    const pkJoin = pkCols.map((c) => `t."${c.name}" = d."${c.name}"`).join(' AND ');
    const distinctChecks = nonPkCols.map((c) => `t."${c.name}" IS DISTINCT FROM d."${c.name}"`).join(' OR ');

    const updateSql = `${dataCte}
UPDATE "${pgSchema}"."${table}" t
SET ${setClauses}
FROM data d
WHERE ${pkJoin}
AND (${distinctChecks})`;

    const updateRes = await client.query(updateSql, [JSON.stringify(jsonbData)]);
    updated = updateRes.rowCount ?? 0;
  }

  // INSERT new rows
  const allColNames = seedColumns.map((c) => `"${c.name}"`).join(', ');
  const selectCols = seedColumns.map((c) => `d."${c.name}"`).join(', ');
  const existsJoin = pkCols.map((c) => `t."${c.name}" = d."${c.name}"`).join(' AND ');

  const insertSql = `${dataCte}
INSERT INTO "${pgSchema}"."${table}" (${allColNames})
SELECT ${selectCols}
FROM data d
WHERE NOT EXISTS (
  SELECT 1 FROM "${pgSchema}"."${table}" t WHERE ${existsJoin}
)`;

  const insertRes = await client.query(insertSql, [JSON.stringify(jsonbData)]);
  const inserted = insertRes.rowCount ?? 0;

  const unchanged = seedRows.length - inserted - updated;

  return { inserted, updated, unchanged };
}

/**
 * Execute a migration plan.
 *
 * Pipeline: acquire lock → ensure _smplcty_schema_flow → pre-scripts → operations → post-scripts → release lock
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const {
    connectionString,
    preScripts = [],
    postScripts = [],
    pgSchema = 'public',
    dryRun = false,
    validateOnly = false,
    lockTimeout,
    statementTimeout,
    logger,
    replanAfterPreScripts,
  } = options;
  let operations = options.operations;

  const result: ExecuteResult = {
    executed: 0,
    skippedScripts: 0,
    preScriptsRun: 0,
    postScriptsRun: 0,
    dryRun,
    validated: validateOnly,
    executedOperations: [],
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
      // Ensure _smplcty_schema_flow schema and history table
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

      // Pre-scripts may have mutated state in ways the original plan can't
      // reflect (e.g. column renames). Re-plan against the current DB so
      // the apply phase doesn't collide with state pre-scripts established.
      if (result.preScriptsRun > 0 && replanAfterPreScripts) {
        operations = await replanAfterPreScripts();
        logger?.debug(`Re-planned after pre-scripts: ${operations.length} operations`);
      }

      // Auto-save a migration snapshot of the operations actually about to
      // execute (post-replan, if any). Saving here — rather than before
      // pre-scripts — keeps the snapshot in sync with what gets applied.
      if (operations.length > 0 && !validateOnly) {
        await ensureSnapshotsTable(lockClient);
        await saveSnapshot(lockClient, operations, pgSchema);
        logger?.debug('Auto-saved migration snapshot');
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
          result.executedOperations.push(op);
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
            await withOpContext(op, async () => {
              if (op.type === 'seed_table') {
                const counts = await executeSeedTable(opClient, op, pgSchema);
                op.seedResult = counts;
              } else {
                await opClient.query(op.sql);
              }
            });
            // Record expand state once the trigger is in place; the column has
            // already been created earlier in this transaction. Idempotent —
            // re-runs ON CONFLICT DO NOTHING.
            if (op.type === 'create_dual_write_trigger' && op.expandMeta) {
              await recordExpandState(opClient, op.expandMeta);
            }
            result.executed++;
            result.executedOperations.push(op);
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
            await withOpContext(op, () => concClient.query(op.sql));
            result.executed++;
            result.executedOperations.push(op);
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
