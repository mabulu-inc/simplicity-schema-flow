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
import { acquireClient } from '../core/db.js';
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
  /**
   * Optional path to a SQL file injected at the **start of every executor
   * transaction** — each pre-script tx, the main migrate+seeds tx, each
   * post-script tx, and each tighten tx. Reads the file once at executor
   * startup and runs the same SQL on each fresh client right after `BEGIN`.
   *
   * Intended for per-transaction session settings that audit triggers or RLS
   * policies depend on, e.g. `SET LOCAL "app.user_id" = '...'`. PostgreSQL
   * isolates session state across connections, and the executor uses a fresh
   * client per phase, so a one-shot setup (like --pre-seed-sql) can't carry
   * those settings into the seed/migration transaction — this option closes
   * that gap.
   */
  perTxSqlPath?: string;
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
 *
 * With a resolvable match key (PK or unique constraint, in `seedMatchColumns`):
 * two round-trips per table — UPDATE rows whose non-key columns differ, then
 * INSERT rows that don't match the key. With no match key, the UPDATE is
 * skipped entirely and the INSERT only fires for rows where at least one of
 * the seed-provided columns already differs (null-safe via
 * `IS NOT DISTINCT FROM`). Columns the YAML didn't mention are ignored.
 */
async function executeSeedTable(client: pg.PoolClient, op: Operation, pgSchema: string): Promise<SeedResult> {
  const { seedRows, seedColumns, seedMatchColumns, seedOnConflict } = op;
  if (!seedRows || !seedColumns || seedRows.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  const table = op.objectName;
  const matchCols = seedMatchColumns ?? [];
  const matchColSet = new Set(matchCols);
  const keyCols = seedColumns.filter((c) => matchColSet.has(c.name));
  const nonKeyCols = seedColumns.filter((c) => !matchColSet.has(c.name));

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

  // UPDATE changed rows. Skipped when there's nothing to key on (no idempotent
  // update is possible without a stable identity), when seeds_on_conflict says
  // DO NOTHING, or when every seed column is part of the match key.
  if (matchCols.length > 0 && seedOnConflict !== 'DO NOTHING' && nonKeyCols.length > 0) {
    const setClauses = nonKeyCols.map((c) => `"${c.name}" = d."${c.name}"`).join(', ');
    const keyJoin = keyCols.map((c) => `t."${c.name}" IS NOT DISTINCT FROM d."${c.name}"`).join(' AND ');
    const distinctChecks = nonKeyCols.map((c) => `t."${c.name}" IS DISTINCT FROM d."${c.name}"`).join(' OR ');

    const updateSql = `${dataCte}
UPDATE "${pgSchema}"."${table}" t
SET ${setClauses}
FROM data d
WHERE ${keyJoin}
AND (${distinctChecks})`;

    const updateRes = await client.query(updateSql, [JSON.stringify(jsonbData)]);
    updated = updateRes.rowCount ?? 0;
  }

  // INSERT new rows. With a match key, "new" means no row shares the key.
  // Without one, "new" means no row already has every seed-provided column
  // equal to the seed values — table columns the YAML didn't mention are
  // never read.
  const allColNames = seedColumns.map((c) => `"${c.name}"`).join(', ');
  const selectCols = seedColumns.map((c) => `d."${c.name}"`).join(', ');
  const existsCols = matchCols.length > 0 ? keyCols : seedColumns;
  const existsJoin = existsCols.map((c) => `t."${c.name}" IS NOT DISTINCT FROM d."${c.name}"`).join(' AND ');

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
    perTxSqlPath,
  } = options;

  // Read once; injected after BEGIN in every executor transaction below.
  const perTxSql = perTxSqlPath ? await readFile(perTxSqlPath, 'utf-8') : null;
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
    if (perTxSqlPath) {
      logger?.info(`[dry-run] Would inject per-tx SQL into every transaction: ${perTxSqlPath}`);
    }
    for (const script of preScripts) {
      logger?.info(`[dry-run] Would run pre-script: ${script.relativePath}`);
    }
    const dryRunMain = operations.filter((op) => op.type !== 'tighten_not_null');
    const dryRunTighten = operations.filter((op) => op.type === 'tighten_not_null');
    for (const op of dryRunMain) {
      logger?.info(`[dry-run] ${op.type} ${op.objectName}: ${op.sql}`);
    }
    for (const script of postScripts) {
      logger?.info(`[dry-run] Would run post-script: ${script.relativePath}`);
    }
    for (const op of dryRunTighten) {
      logger?.info(`[dry-run] ${op.type} ${op.objectName}: ${op.sql}`);
    }
    return result;
  }

  const lockClient = await acquireClient(connectionString, { pgSchema });

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
        const changed = await fileNeedsApply(lockClient, script.relativePath, script.hash, pgSchema);
        if (!changed) {
          result.skippedScripts++;
          logger?.debug(`Skipping unchanged pre-script: ${script.relativePath}`);
          continue;
        }

        const sql = await readFile(script.absolutePath, 'utf-8');
        const scriptClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
        try {
          await scriptClient.query('BEGIN');
          if (perTxSql) await scriptClient.query(perTxSql);
          await scriptClient.query(sql);
          await scriptClient.query('COMMIT');
        } catch (err) {
          await scriptClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          scriptClient.release();
        }

        await recordFile(lockClient, script.relativePath, script.hash, 'pre', pgSchema);
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
      // Split prechecks, concurrent, transactional, and tighten operations.
      // tighten_not_null ops are deferred until after post-scripts so any
      // backfill the consumer wrote gets to land before NOT NULL is enforced.
      const sorted = [...operations].sort((a, b) => a.phase - b.phase);
      const precheckOps = sorted.filter((op) => op.type === 'run_precheck');
      const tightenOps = sorted.filter((op) => op.type === 'tighten_not_null');
      const transactionalOps = sorted.filter(
        (op) => !op.concurrent && op.type !== 'run_precheck' && op.type !== 'tighten_not_null',
      );
      const concurrentOps = sorted.filter((op) => op.concurrent);

      // Run prechecks before any operations
      for (const op of precheckOps) {
        logger?.debug(`Running precheck: ${op.objectName}`);
        const precheckClient = await acquireClient(connectionString, { pgSchema });
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
        const opClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
        try {
          await opClient.query('BEGIN');
          if (perTxSql) await opClient.query(perTxSql);

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
          const concClient = await acquireClient(connectionString, { pgSchema });
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
          const changed = await fileNeedsApply(lockClient, script.relativePath, script.hash, pgSchema);
          if (!changed) {
            result.skippedScripts++;
            logger?.debug(`Skipping unchanged post-script: ${script.relativePath}`);
            continue;
          }

          const sql = await readFile(script.absolutePath, 'utf-8');
          const scriptClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
          try {
            await scriptClient.query('BEGIN');
            if (perTxSql) await scriptClient.query(perTxSql);
            await scriptClient.query(sql);
            await scriptClient.query('COMMIT');
          } catch (err) {
            await scriptClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            scriptClient.release();
          }

          await recordFile(lockClient, script.relativePath, script.hash, 'post', pgSchema);
          result.postScriptsRun++;
          logger?.info(`Executed post-script: ${script.relativePath}`);
        }
      }

      // Tighten phase — runs AFTER post-scripts so backfills land first.
      // Each column-tighten gets its own tx; a failure on one column (e.g.
      // VALIDATE finds NULLs) won't roll back tightens already committed for
      // other columns.
      if (tightenOps.length > 0 && !validateOnly) {
        for (const op of tightenOps) {
          logger?.debug(`Tightening: ${op.objectName}`);
          const tClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
          try {
            await tClient.query('BEGIN');
            if (perTxSql) await tClient.query(perTxSql);
            await withOpContext(op, () => tClient.query(op.sql));
            await tClient.query('COMMIT');
          } catch (err) {
            await tClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            tClient.release();
          }
          result.executed++;
          result.executedOperations.push(op);
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
