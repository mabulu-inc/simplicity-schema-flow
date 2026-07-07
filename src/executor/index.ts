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
  /**
   * Declarative schema files (the YAML under tables/, functions/, …) to record
   * in `history` once the apply succeeds. Recorded inside the run — after the
   * apply, before post-scripts — so their `applied_at` reflects true execution
   * order relative to post-scripts (which depend on them). Omit for the
   * convergence re-apply and other internal calls that shouldn't touch history.
   */
  schemaFiles?: SchemaFile[];
  pgSchema?: string;
  dryRun?: boolean;
  validateOnly?: boolean;
  lockTimeout?: number;
  statementTimeout?: number;
  /**
   * Number of attempts for a declarative DDL transaction that aborts because it
   * could not acquire its lock within `lockTimeout` (Postgres `55P03`). Each
   * attempt is a fresh, small per-table transaction retried with exponential
   * backoff so a brief lock slips through a micro-gap under live traffic.
   * Defaults to 3 (the shared `maxRetries` config). Exhausting it fails the run
   * with the contended table named — re-running converges what already landed.
   */
  maxRetries?: number;
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
   * transaction** — each pre-script tx, the bootstrap tx, each per-table DDL
   * group, the seed tx, each post-script tx, and each tighten tx. Reads the file
   * once at executor startup and runs the same SQL on each fresh client right
   * after `BEGIN`.
   *
   * Intended for per-transaction session settings that audit triggers or RLS
   * policies depend on, e.g. `SET LOCAL "app.user_id" = '...'`. PostgreSQL
   * isolates session state across connections, and the executor uses a fresh
   * client per phase, so a one-shot setup (like --pre-seed-sql) can't carry
   * those settings into the seed/migration transaction — this option closes
   * that gap.
   */
  perTxSqlPath?: string;
  /**
   * Session settings applied (via `set_config(name, value, true)` — i.e.
   * `SET LOCAL`) at the start of the bootstrap transaction, after the built-in
   * `smplcty.bootstrap = 'true'` and before any per-tx SQL. Lets a consumer
   * point schema-flow at the GUC their own audit trigger already checks (e.g.
   * `{ 'app.audit_lenient': true }`) so bootstrap seeds land the way they need
   * without modifying the trigger. Scoped to the bootstrap tx only.
   */
  bootstrapSession?: Record<string, string | number | boolean>;
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
  /** Relative paths of pre-scripts that ran, in execution order. */
  executedPreScripts: string[];
  /** Relative paths of post-scripts that ran, in execution order. */
  executedPostScripts: string[];
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

export interface AdvisoryLockOptions {
  /** Total time to keep retrying before giving up. Default 30s. */
  maxWaitMs?: number;
  /** Initial delay between attempts; doubles each retry. Default 50ms. */
  baseDelayMs?: number;
  /** Upper bound on the backoff delay. Default 1s. */
  maxDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the global advisory lock, retrying with exponential backoff until
 * it is free or the budget runs out. Returns true once held, false if the
 * lock stayed held for the whole `maxWaitMs` window.
 *
 * The lock key is global (one per database, not per pgSchema) on purpose: it
 * serializes the shared `_smplcty_schema_flow` bootstrap that every schema's
 * migration touches. Keying it per-schema would let two migrations race that
 * bootstrap, and PG's `CREATE SCHEMA/TABLE IF NOT EXISTS` is not concurrency-
 * safe. So distinct schemas migrating in parallel (e.g. parallel
 * `useTestProject` test files) wait their turn here rather than failing — the
 * old non-blocking variant threw on contention and broke that workflow.
 */
export async function acquireAdvisoryLock(client: pg.PoolClient, opts: AdvisoryLockOptions = {}): Promise<boolean> {
  const { maxWaitMs = 30_000, baseDelayMs = 50, maxDelayMs = 1_000 } = opts;
  const deadline = Date.now() + maxWaitMs;
  let delay = baseDelayMs;
  for (;;) {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
    if (res.rows[0].acquired === true) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, maxDelayMs);
  }
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

/** Postgres error code raised when `lock_timeout` fires before a lock is free. */
const LOCK_NOT_AVAILABLE = '55P03';

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
}

/**
 * Lock-group key for an operation — the object (table) name up to the first
 * dot. The planner names every table-scoped op `"<table>"` or
 * `"<table>.<detail>"` uniformly, so this collapses every op touching one table
 * to a single key. The declarative diff is applied as one transaction per
 * *consecutive run* of same-key ops, so each transaction's lock footprint is a
 * single table — held only for that group, not for the whole migration.
 */
export function lockGroupKey(op: Operation): string {
  return op.objectName.split('.')[0];
}

/**
 * Cut a phase-sorted op list into transaction groups: a new group starts
 * whenever the lock-group key changes. Consecutive runs (not a global
 * regroup-by-table) so the planner's strict phase ordering is preserved —
 * a later-phase op never jumps ahead of an earlier-phase dependency. Naturally
 * atomic same-phase pairs (e.g. `DROP CONSTRAINT fk` + `ADD … fk NOT VALID`,
 * both phase 8 and emitted adjacently) land in the same group.
 */
export function groupByLockKey(ops: Operation[]): Operation[][] {
  const groups: Operation[][] = [];
  for (const op of ops) {
    const last = groups[groups.length - 1];
    if (last && lockGroupKey(last[0]) === lockGroupKey(op)) {
      last.push(op);
    } else {
      groups.push([op]);
    }
  }
  return groups;
}

interface SeedResult {
  inserted: number;
  unchanged: number;
}

function isSqlExpression(val: unknown): val is { __sql: string } {
  return (
    typeof val === 'object' && val !== null && '__sql' in val && typeof (val as { __sql: string }).__sql === 'string'
  );
}

/**
 * Execute a seed_table operation as a bulk INSERT — seeds are insert-only.
 *
 * With a resolvable match key (PK, or a unique constraint/index, in
 * `seedMatchColumns`): INSERT rows whose key isn't already present. A partial
 * unique index contributes its key columns but never its `where` predicate, so
 * a soft-deleted builtin still counts as present and is not re-inserted. With
 * no match key, "new" means no existing row has every seed-provided column
 * equal (null-safe via `IS NOT DISTINCT FROM`). Existing rows are never
 * modified, and columns the YAML didn't mention are never read.
 */
async function executeSeedTable(client: pg.PoolClient, op: Operation, pgSchema: string): Promise<SeedResult> {
  const { seedRows, seedColumns, seedMatchColumns } = op;
  if (!seedRows || !seedColumns || seedRows.length === 0) {
    return { inserted: 0, unchanged: 0 };
  }

  const table = op.objectName;
  const matchCols = seedMatchColumns ?? [];
  const matchColSet = new Set(matchCols);
  const keyCols = seedColumns.filter((c) => matchColSet.has(c.name));

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
      const distinct = new Set(sqlExprs.values());
      if (sqlExprs.size === seedRows.length && distinct.size === 1) {
        // Every row uses the *same* SQL expression — emit it once for the column.
        const expr = distinct.values().next().value;
        return `${expr} AS "${col.name}"`;
      }
      // Mixed (some rows literal, or differing expressions): use CASE with row index
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

  const unchanged = seedRows.length - inserted;

  return { inserted, unchanged };
}

interface OnlineGroupContext {
  connectionString: string;
  pgSchema: string;
  lockTimeout?: number;
  statementTimeout?: number;
  perTxSql: string | null;
  maxRetries: number;
  logger?: Logger;
  result: ExecuteResult;
}

/**
 * Apply one per-table transaction group, retrying the whole (small) group with
 * exponential backoff when it aborts on `lock_timeout`. Because each group
 * touches a single table, a contended lock only ever costs that table's group
 * a retry — never the whole migration. `result` is updated only after COMMIT,
 * so a failed-and-rolled-back attempt is never counted as executed.
 */
async function runOnlineGroup(group: Operation[], ctx: OnlineGroupContext): Promise<void> {
  const { connectionString, pgSchema, lockTimeout, statementTimeout, perTxSql, maxRetries, logger, result } = ctx;
  const table = lockGroupKey(group[0]);
  let delay = 100;

  for (let attempt = 1; ; attempt++) {
    const client = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
    try {
      await client.query('BEGIN');
      if (perTxSql) await client.query(perTxSql);

      for (const op of group) {
        logger?.debug(`Executing (tx "${table}"): ${op.type} ${op.objectName}`);
        await withOpContext(op, () => client.query(op.sql));
        // Expand-state row must commit atomically with the trigger that created
        // it — both live in this same per-table group transaction.
        if (op.type === 'create_dual_write_trigger' && op.expandMeta) {
          await recordExpandState(client, op.expandMeta);
        }
      }

      await client.query('COMMIT');
      for (const op of group) {
        result.executed++;
        result.executedOperations.push(op);
      }
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (errorCode(err) === LOCK_NOT_AVAILABLE && attempt < maxRetries) {
        logger?.info(`Lock busy on "${table}" (attempt ${attempt}/${maxRetries}); retrying in ${delay}ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, 2_000);
        continue;
      }
      if (errorCode(err) === LOCK_NOT_AVAILABLE && err instanceof Error) {
        err.message =
          `Could not acquire lock on table "${table}" after ${attempt} attempt(s) ` +
          `(lock_timeout=${lockTimeout ?? 'unset'}ms). Another session held a conflicting lock. ` +
          `Re-run to converge — already-committed groups are skipped.\n  ${err.message}`;
      }
      throw err;
    } finally {
      client.release();
    }
  }
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
    schemaFiles = [],
    pgSchema = 'public',
    dryRun = false,
    validateOnly = false,
    lockTimeout,
    statementTimeout,
    maxRetries = 3,
    logger,
    replanAfterPreScripts,
    perTxSqlPath,
    bootstrapSession,
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
    executedPreScripts: [],
    executedPostScripts: [],
  };

  // Dry-run: populate the result with what would happen and let the caller
  // (reportMigrationResult) render it. We don't log per-op or per-script
  // lines here — that path used to dump full SQL for every operation,
  // which made `plan` output unreadable for non-trivial migrations.
  //
  // Pre/post scripts are filtered by content hash so the plan matches what
  // a real run would do. Probe the history table read-only (to_regclass)
  // rather than calling ensureHistoryTable so `plan` against a fresh DB
  // has no side effects.
  if (dryRun) {
    if (perTxSqlPath) {
      logger?.debug(`[dry-run] Would inject per-tx SQL into every transaction: ${perTxSqlPath}`);
    }

    let historyClient: pg.PoolClient | null = null;
    let historyExists = false;
    if (preScripts.length > 0 || postScripts.length > 0) {
      historyClient = await acquireClient(connectionString, { pgSchema });
      const probe = await historyClient.query(`SELECT to_regclass('_smplcty_schema_flow.history') AS reg`);
      historyExists = probe.rows[0].reg !== null;
    }

    try {
      for (const script of preScripts) {
        const wouldRun =
          !historyExists || (await fileNeedsApply(historyClient!, script.relativePath, script.hash, pgSchema));
        if (wouldRun) {
          result.preScriptsRun++;
          result.executedPreScripts.push(script.relativePath);
        } else {
          result.skippedScripts++;
        }
      }

      // Tighten ops run after post-scripts in the live path; preserve that
      // order in the plan so the output reads chronologically. Bootstrap ops
      // run in their own tx ahead of the main apply tx, so list them first.
      const dryRunMain = operations
        .filter((op) => op.type !== 'tighten_not_null')
        .sort((a, b) => Number(b.bootstrap ?? false) - Number(a.bootstrap ?? false));
      const dryRunTighten = operations.filter((op) => op.type === 'tighten_not_null');

      for (const op of dryRunMain) {
        result.executed++;
        result.executedOperations.push(op);
      }

      for (const script of postScripts) {
        const wouldRun =
          !historyExists || (await fileNeedsApply(historyClient!, script.relativePath, script.hash, pgSchema));
        if (wouldRun) {
          result.postScriptsRun++;
          result.executedPostScripts.push(script.relativePath);
        } else {
          result.skippedScripts++;
        }
      }

      for (const op of dryRunTighten) {
        result.executed++;
        result.executedOperations.push(op);
      }
    } finally {
      historyClient?.release();
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
        result.executedPreScripts.push(script.relativePath);
        // Rendering is deferred to reportMigrationResult so pre-scripts, the
        // declarative apply, and post-scripts print in one stream in true
        // execution order — a live log here would jump ahead of the apply
        // lines the report emits afterward.
        logger?.debug(`Executed pre-script: ${script.relativePath}`);
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
      const isMainTxOp = (op: Operation) =>
        !op.concurrent && op.type !== 'run_precheck' && op.type !== 'tighten_not_null';
      // Bootstrap ops apply in their own transaction that commits before the
      // main apply tx, so per-tx hooks in the main tx see the rows seeded here.
      const bootstrapOps = sorted.filter((op) => op.bootstrap && isMainTxOp(op));
      const transactionalOps = sorted.filter((op) => !op.bootstrap && isMainTxOp(op));
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

      // Bootstrap transaction — runs and COMMITs before the main apply tx so
      // its CREATEd tables and seeded rows are visible to the per-tx hook that
      // opens every subsequent transaction. Sets `smplcty.bootstrap = 'true'`
      // plus any consumer-declared session settings (e.g. an audit-lenient GUC)
      // for the duration of the tx, ahead of the per-tx SQL.
      if (bootstrapOps.length > 0) {
        const bsClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
        try {
          await bsClient.query('BEGIN');
          await bsClient.query(`SELECT set_config('smplcty.bootstrap', 'true', true)`);
          for (const [name, value] of Object.entries(bootstrapSession ?? {})) {
            await bsClient.query('SELECT set_config($1, $2, true)', [name, String(value)]);
          }
          if (perTxSql) await bsClient.query(perTxSql);

          for (const op of bootstrapOps) {
            logger?.debug(`Executing (bootstrap): ${op.type} ${op.objectName}`);
            await withOpContext(op, async () => {
              if (op.type === 'seed_table') {
                const counts = await executeSeedTable(bsClient, op, pgSchema);
                op.seedResult = counts;
              } else {
                await bsClient.query(op.sql);
              }
            });
            result.executed++;
            result.executedOperations.push(op);
          }

          if (validateOnly) {
            await bsClient.query('ROLLBACK');
          } else {
            await bsClient.query('COMMIT');
          }
        } catch (err) {
          await bsClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          bsClient.release();
        }
      }

      // Apply the declarative diff.
      //
      // Validate mode keeps the whole diff in ONE transaction and rolls it back
      // — that all-or-nothing apply-then-discard *is* the validate contract, and
      // it can't be expressed incrementally.
      //
      // A real apply instead commits the diff as one transaction *per table*
      // (per-table groups, each guarded by `lock_timeout` and retried on lock
      // contention), then runs seeds in their own atomic transaction. Holding
      // every table's `ACCESS EXCLUSIVE` until a single final commit is what
      // freezes a live database; per-table groups hold each lock only
      // momentarily. The tradeoff — a failure leaves a partially-applied schema
      // — is recovered by re-running, which recomputes the diff from live state
      // and applies only what's left. That convergence is the design, not a
      // fallback: schema-flow is declarative and every statement is guarded, so
      // an interrupted run is a valid intermediate schema, never corruption.
      if (transactionalOps.length > 0 && validateOnly) {
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
            if (op.type === 'create_dual_write_trigger' && op.expandMeta) {
              await recordExpandState(opClient, op.expandMeta);
            }
            result.executed++;
            result.executedOperations.push(op);
          }

          await opClient.query('ROLLBACK');
          logger?.info('Validate mode: all operations executed successfully, rolled back');
        } catch (err) {
          await opClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          opClient.release();
        }
      } else if (transactionalOps.length > 0) {
        const ddlOps = transactionalOps.filter((op) => op.type !== 'seed_table');
        const seedOps = transactionalOps.filter((op) => op.type === 'seed_table');

        // DDL: one transaction per consecutive same-table run, lock-guarded.
        const groups = groupByLockKey(ddlOps);
        const ctx: OnlineGroupContext = {
          connectionString,
          pgSchema,
          lockTimeout,
          statementTimeout,
          perTxSql,
          maxRetries,
          logger,
          result,
        };
        for (const group of groups) {
          await runOnlineGroup(group, ctx);
        }

        // Seeds: insert-only and atomicity-sensitive, so they stay together in
        // one transaction (they take row locks, not the table-level locks that
        // make DDL the contention problem).
        if (seedOps.length > 0) {
          const seedClient = await acquireClient(connectionString, { pgSchema, lockTimeout, statementTimeout });
          try {
            await seedClient.query('BEGIN');
            if (perTxSql) await seedClient.query(perTxSql);
            for (const op of seedOps) {
              logger?.debug(`Seeding: ${op.objectName}`);
              await withOpContext(op, async () => {
                const counts = await executeSeedTable(seedClient, op, pgSchema);
                op.seedResult = counts;
              });
              result.executed++;
              result.executedOperations.push(op);
            }
            await seedClient.query('COMMIT');
          } catch (err) {
            await seedClient.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            seedClient.release();
          }
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

      // Record the declarative schema files now — after the apply, before
      // post-scripts. post-scripts depend on these objects, so their history
      // `applied_at` must land after the schema files', not before. (Recording
      // here rather than back in the pipeline is what keeps that order true.)
      if (schemaFiles.length > 0 && !validateOnly) {
        for (const file of schemaFiles) {
          await recordFile(lockClient, file.relativePath, file.hash, file.phase, pgSchema);
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
          result.executedPostScripts.push(script.relativePath);
          // Deferred to reportMigrationResult (see pre-script note) so this
          // prints after the apply lines, matching true execution order.
          logger?.debug(`Executed post-script: ${script.relativePath}`);
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
