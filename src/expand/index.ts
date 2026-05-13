/**
 * Expand/contract module for zero-downtime column migrations.
 *
 * Flow:
 * 1. Expand (run): add new column, create dual-write trigger, record state.
 *    `schema-flow run` does this. It is fast — no row scan.
 * 2. Backfill (out-of-band): drain rows where the invariant doesn't hold.
 *    `schema-flow backfill` does this. Resumable; safe to run multiple times.
 * 3. Application switches to reading/writing the new column.
 * 4. Contract: drop old column + trigger. `schema-flow contract` does this,
 *    refusing unless `new IS DISTINCT FROM transform(old)` count is zero.
 *
 * The same invariant — `new IS DISTINCT FROM transform(old)` — is used by the
 * trigger guard, the backfill predicate, and the contract gate. It is null-safe
 * by construction, so nullable source columns and identity-transform renames
 * both behave correctly.
 *
 * State tracked in `_smplcty_schema_flow.expand_state`.
 */

import type pg from 'pg';
import type { ExpandDef } from '../schema/types.js';
import type { Logger } from '../core/logger.js';
import { getPool } from '../core/db.js';
import { acquireAdvisoryLock, releaseAdvisoryLock } from '../executor/index.js';

// ─── Operation types for expand/contract ────────────────────────

export type ExpandOperationType =
  | 'expand_column'
  | 'create_dual_write_trigger'
  | 'contract_column'
  | 'drop_dual_write_trigger';

/**
 * Structured metadata threaded through the planner/executor for expand ops,
 * so the executor can record state in `_smplcty_schema_flow.expand_state`
 * without re-parsing object names.
 */
export interface ExpandMeta {
  tableName: string;
  newColumn: string;
  oldColumn: string;
  transform: string;
  triggerName: string;
  pgSchema?: string;
}

export interface ExpandOperation {
  type: ExpandOperationType;
  phase: number;
  objectName: string;
  sql: string;
  destructive: boolean;
  expandMeta?: ExpandMeta;
}

// ─── Expand State Table ─────────────────────────────────────────

export interface ExpandState {
  id: number;
  table_name: string;
  new_column: string;
  old_column: string;
  transform: string;
  trigger_name: string;
  status: 'expanded' | 'contracted';
  created_at: Date;
}

/**
 * Create the _smplcty_schema_flow.expand_state table if it doesn't exist.
 *
 * Adds a UNIQUE constraint on (table_name, new_column) so that
 * `recordExpandState` can use ON CONFLICT for idempotency. The constraint is
 * added conditionally for forward-compatibility with installations that
 * created the table under an older schema-flow version.
 */
export async function ensureExpandStateTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _smplcty_schema_flow.expand_state (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      new_column TEXT NOT NULL,
      old_column TEXT NOT NULL,
      transform TEXT NOT NULL,
      trigger_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'expanded',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_expand_state_table_col'
          AND conrelid = '_smplcty_schema_flow.expand_state'::regclass
      ) THEN
        ALTER TABLE _smplcty_schema_flow.expand_state
          ADD CONSTRAINT uq_expand_state_table_col UNIQUE (table_name, new_column);
      END IF;
    END $$;
  `);
}

// ─── Plan Expand ────────────────────────────────────────────────

function triggerName(pgSchema: string | undefined, tableName: string, newColumn: string): string {
  const prefix = pgSchema ? `${pgSchema}_` : '';
  return `_smplcty_sf_dw_${prefix}${tableName}_${newColumn}`;
}

function triggerFnName(pgSchema: string | undefined, tableName: string, newColumn: string): string {
  return `_smplcty_sf_dw_fn_${pgSchema ? `${pgSchema}_` : ''}${tableName}_${newColumn}`;
}

/**
 * Substitute references to the source column with `NEW.<col>` inside a
 * transform expression. This is the same token-level rewrite the trigger has
 * always used; identity transforms (`transform: <from>`) become `NEW.<from>`,
 * which is what the dual-write trigger needs.
 */
function rewriteForTrigger(expr: string, sourceColumn: string): string {
  return expr.replace(/\b(\w+)\b/g, (match) => (match === sourceColumn ? `NEW.${match}` : match));
}

/**
 * Plan expand operations for a column migration.
 *
 * Emits two operations:
 *  1. `expand_column` — add the new column (no default; backfill is separate).
 *  2. `create_dual_write_trigger` — a guarded BEFORE INSERT/UPDATE trigger
 *     that preserves direct writes to the new column.
 *
 * The actual backfill is NOT in the migration plan. Operators run
 * `schema-flow backfill` separately. This keeps `schema-flow run` fast and
 * lock-free regardless of table size.
 */
export function planExpandColumn(
  tableName: string,
  newColumn: string,
  columnType: string,
  expand: ExpandDef,
  pgSchema?: string,
): ExpandOperation[] {
  const qualifiedTable = pgSchema ? `${pgSchema}.${tableName}` : tableName;
  const trgName = triggerName(pgSchema, tableName, newColumn);
  const fnName = triggerFnName(pgSchema, tableName, newColumn);
  const qualifiedFn = pgSchema ? `${pgSchema}.${fnName}` : fnName;

  const meta: ExpandMeta = {
    tableName,
    newColumn,
    oldColumn: expand.from,
    transform: expand.transform,
    triggerName: trgName,
    pgSchema,
  };

  const ops: ExpandOperation[] = [];

  // 1. Add the new column.
  ops.push({
    type: 'expand_column',
    phase: 100,
    objectName: `${tableName}.${newColumn}`,
    sql: `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS ${newColumn} ${columnType}`,
    destructive: false,
    expandMeta: meta,
  });

  // 2. Create dual-write trigger function + trigger.
  //
  // The forward branch fires on INSERT (only when the new column wasn't
  // explicitly written) and on UPDATEs that actually change the source column.
  // This preserves direct writes to the new column once the app cuts over,
  // and avoids infinite-looping the trigger if the table is updated in place.
  //
  // The reverse branch, when present, fires on UPDATEs that change only the
  // new column. On INSERT it fires when only the new column was supplied.
  const forwardExpr = rewriteForTrigger(expand.transform, expand.from);
  const reverseExpr = expand.reverse ? rewriteForTrigger(expand.reverse, newColumn) : null;

  const insertBranch = reverseExpr
    ? `    IF NEW.${newColumn} IS NULL AND NEW.${expand.from} IS NOT NULL THEN
      NEW.${newColumn} := ${forwardExpr};
    ELSIF NEW.${expand.from} IS NULL AND NEW.${newColumn} IS NOT NULL THEN
      NEW.${expand.from} := ${reverseExpr};
    END IF;`
    : `    IF NEW.${newColumn} IS NULL THEN
      NEW.${newColumn} := ${forwardExpr};
    END IF;`;

  const updateBranch = reverseExpr
    ? `    IF NEW.${expand.from} IS DISTINCT FROM OLD.${expand.from} THEN
      NEW.${newColumn} := ${forwardExpr};
    ELSIF NEW.${newColumn} IS DISTINCT FROM OLD.${newColumn} THEN
      NEW.${expand.from} := ${reverseExpr};
    END IF;`
    : `    IF NEW.${expand.from} IS DISTINCT FROM OLD.${expand.from} THEN
      NEW.${newColumn} := ${forwardExpr};
    END IF;`;

  const triggerSql = `
CREATE OR REPLACE FUNCTION ${qualifiedFn}() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
${insertBranch}
  ELSE
${updateBranch}
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER ${trgName}
  BEFORE INSERT OR UPDATE ON ${qualifiedTable}
  FOR EACH ROW
  EXECUTE FUNCTION ${qualifiedFn}()`;

  ops.push({
    type: 'create_dual_write_trigger',
    phase: 101,
    objectName: `${tableName}.${trgName}`,
    sql: triggerSql,
    destructive: false,
    expandMeta: meta,
  });

  return ops;
}

/**
 * Record (or refresh) the expand_state row for a given migration. Idempotent:
 * re-running the migration after the state row already exists is a no-op.
 */
export async function recordExpandState(client: pg.PoolClient, meta: ExpandMeta): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
  await ensureExpandStateTable(client);
  const qualifiedTableName = meta.pgSchema ? `${meta.pgSchema}.${meta.tableName}` : meta.tableName;
  await client.query(
    `INSERT INTO _smplcty_schema_flow.expand_state
       (table_name, new_column, old_column, transform, trigger_name, status)
     VALUES ($1, $2, $3, $4, $5, 'expanded')
     ON CONFLICT (table_name, new_column) DO NOTHING`,
    [qualifiedTableName, meta.newColumn, meta.oldColumn, meta.transform, meta.triggerName],
  );
}

// ─── Backfill ───────────────────────────────────────────────────

export interface BackfillOptions {
  connectionString: string;
  tableName: string;
  newColumn: string;
  transform: string;
  batchSize?: number;
  pgSchema?: string;
  logger?: Logger;
}

export interface BackfillResult {
  rowsUpdated: number;
}

/**
 * Backfill a column in batches.
 *
 * Predicate uses `IS DISTINCT FROM (transform)` rather than `IS NULL`, so:
 *   - rows where the invariant already holds are skipped (idempotent / resumable);
 *   - rows where the source column is NULL are not re-processed forever
 *     (would have been an infinite loop under the old `IS NULL` predicate);
 *   - the same predicate is used by `checkBackfillComplete`, giving a single
 *     definition of "backfill done".
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const { connectionString, tableName, newColumn, transform, batchSize = 1000, pgSchema, logger } = options;

  const qualifiedTable = pgSchema ? `${pgSchema}.${tableName}` : tableName;
  const pool = getPool(connectionString);
  let totalUpdated = 0;

  while (true) {
    const client = await pool.connect();
    try {
      const res = await client.query(
        `UPDATE ${qualifiedTable} SET ${newColumn} = ${transform}
         WHERE ctid = ANY(
           ARRAY(
             SELECT ctid FROM ${qualifiedTable}
             WHERE ${newColumn} IS DISTINCT FROM (${transform})
             LIMIT ${batchSize}
           )
         )`,
      );
      const updated = res.rowCount ?? 0;
      totalUpdated += updated;
      logger?.debug(`Backfilled ${updated} rows (total: ${totalUpdated})`);
      if (updated === 0) break;
    } finally {
      client.release();
    }
  }

  logger?.info(`Backfill complete: ${totalUpdated} rows updated in ${qualifiedTable}.${newColumn}`);
  return { rowsUpdated: totalUpdated };
}

export interface BackfillAllOptions {
  connectionString: string;
  pgSchema?: string;
  /** Restrict to a single table (matches expand_state.table_name suffix). */
  table?: string;
  /** Restrict to a single column ("table.column"). */
  column?: string;
  /** Max concurrent backfills (default 1). */
  concurrency?: number;
  batchSize?: number;
  logger?: Logger;
}

export interface BackfillAllResult {
  processed: number;
  totalRowsUpdated: number;
  perState: { table: string; column: string; rowsUpdated: number }[];
}

/**
 * Drain all pending expand-column backfills. Sequential by default; opt-in
 * parallelism via `concurrency`. Resumable — re-running picks up wherever
 * the last invocation left off, because `runBackfill` is idempotent.
 */
export async function runBackfillAll(options: BackfillAllOptions): Promise<BackfillAllResult> {
  const { connectionString, pgSchema, table, column, concurrency = 1, batchSize, logger } = options;
  const pool = getPool(connectionString);

  const states: ExpandState[] = [];
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
    await ensureExpandStateTable(client);
    const res = await client.query(
      `SELECT * FROM _smplcty_schema_flow.expand_state
       WHERE status = 'expanded'
       ORDER BY created_at ASC`,
    );
    states.push(...(res.rows as ExpandState[]));
  } finally {
    client.release();
  }

  // Filter to the requested scope.
  const filtered = states.filter((s) => {
    const tableOnly = s.table_name.includes('.') ? s.table_name.split('.').pop()! : s.table_name;
    if (table && tableOnly !== table) return false;
    if (column) {
      const [colTable, colName] = column.split('.');
      if (colTable !== tableOnly || colName !== s.new_column) return false;
    }
    return true;
  });

  const perState: { table: string; column: string; rowsUpdated: number }[] = [];

  async function processOne(state: ExpandState): Promise<void> {
    const tableOnly = state.table_name.includes('.') ? state.table_name.split('.').pop()! : state.table_name;
    const effectiveSchema = pgSchema ?? (state.table_name.includes('.') ? state.table_name.split('.')[0] : undefined);
    logger?.info(`Backfilling ${state.table_name}.${state.new_column} → transform: ${state.transform}`);
    const result = await runBackfill({
      connectionString,
      tableName: tableOnly,
      newColumn: state.new_column,
      transform: state.transform,
      pgSchema: effectiveSchema,
      batchSize,
      logger,
    });
    perState.push({ table: state.table_name, column: state.new_column, rowsUpdated: result.rowsUpdated });
  }

  // Sequential or bounded-parallel.
  if (concurrency <= 1) {
    for (const s of filtered) await processOne(s);
  } else {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, filtered.length) }, async () => {
      while (idx < filtered.length) {
        const my = idx++;
        await processOne(filtered[my]);
      }
    });
    await Promise.all(workers);
  }

  const totalRowsUpdated = perState.reduce((acc, r) => acc + r.rowsUpdated, 0);
  return { processed: filtered.length, totalRowsUpdated, perState };
}

/**
 * Count rows that violate the expand invariant for a single state row. Returns
 * 0 when backfill is complete and the new column is safe to swap in.
 *
 * Pure read; safe to call from `contract`, `expand-status`, or anywhere else.
 */
export async function checkBackfillComplete(client: pg.PoolClient, state: ExpandState): Promise<number> {
  const tableOnly = state.table_name.includes('.') ? state.table_name.split('.').pop()! : state.table_name;
  const schemaPrefix = state.table_name.includes('.') ? state.table_name.split('.')[0] : undefined;
  const qualifiedTable = schemaPrefix ? `${schemaPrefix}.${tableOnly}` : tableOnly;
  const res = await client.query(
    `SELECT count(*)::bigint AS cnt FROM ${qualifiedTable}
     WHERE ${state.new_column} IS DISTINCT FROM (${state.transform})`,
  );
  return Number(res.rows[0].cnt);
}

// ─── Contract ───────────────────────────────────────────────────

export interface ContractOptions {
  connectionString: string;
  tableName: string;
  newColumn: string;
  pgSchema?: string;
  /** Bypass the backfill-completion check. Requires explicit operator intent. */
  force?: boolean;
  logger?: Logger;
}

export interface ContractResult {
  dropped: boolean;
  oldColumn: string;
  triggerDropped: boolean;
  forced: boolean;
  rowsDiverged: number;
}

/**
 * Complete the contract phase: drop old column and dual-write trigger.
 *
 * Refuses to proceed unless `new IS DISTINCT FROM transform(old)` count is
 * zero. Pass `force: true` to drop anyway (the caller has confirmed the
 * divergence is intentional / acceptable).
 */
export async function runContract(options: ContractOptions): Promise<ContractResult> {
  const { connectionString, tableName, newColumn, pgSchema, force, logger } = options;

  const qualifiedTableName = pgSchema ? `${pgSchema}.${tableName}` : tableName;
  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
    await ensureExpandStateTable(client);

    const stateRes = await client.query(
      `SELECT * FROM _smplcty_schema_flow.expand_state
       WHERE table_name = $1 AND new_column = $2
       ORDER BY created_at DESC LIMIT 1`,
      [qualifiedTableName, newColumn],
    );

    if (stateRes.rows.length === 0) {
      throw new Error(`No expand state found for ${qualifiedTableName}.${newColumn}`);
    }

    const state = stateRes.rows[0] as ExpandState;

    if (state.status === 'contracted') {
      throw new Error(`Column ${qualifiedTableName}.${newColumn} is already contracted`);
    }

    const rowsDiverged = await checkBackfillComplete(client, state);

    if (rowsDiverged > 0 && !force) {
      throw new Error(
        `Cannot contract ${qualifiedTableName}.${newColumn}: ${rowsDiverged} row(s) still satisfy ` +
          `\`${newColumn} IS DISTINCT FROM (${state.transform})\`. Run \`schema-flow backfill\` ` +
          `to complete the migration, then re-run contract. Pass --force to drop anyway (DATA LOSS RISK).`,
      );
    }
    if (rowsDiverged > 0 && force) {
      logger?.warn(`Forcing contract with ${rowsDiverged} diverged row(s). Old column will be dropped.`);
    }

    const fnName = triggerFnName(pgSchema, tableName, newColumn);
    const qualifiedFn = pgSchema ? `${pgSchema}.${fnName}` : fnName;

    const acquired = await acquireAdvisoryLock(client);
    if (!acquired) {
      throw new Error('Could not acquire advisory lock — another migration may be running');
    }

    try {
      await client.query('BEGIN');

      await client.query(`DROP TRIGGER IF EXISTS ${state.trigger_name} ON ${qualifiedTableName}`);
      logger?.info(`Dropped trigger ${state.trigger_name}`);

      await client.query(`DROP FUNCTION IF EXISTS ${qualifiedFn}()`);
      logger?.info(`Dropped function ${qualifiedFn}`);

      await client.query(`ALTER TABLE ${qualifiedTableName} DROP COLUMN ${state.old_column}`);
      logger?.info(`Dropped column ${qualifiedTableName}.${state.old_column}`);

      await client.query(`UPDATE _smplcty_schema_flow.expand_state SET status = 'contracted' WHERE id = $1`, [
        state.id,
      ]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await releaseAdvisoryLock(client);
    }

    return {
      dropped: true,
      oldColumn: state.old_column,
      triggerDropped: true,
      forced: !!force && rowsDiverged > 0,
      rowsDiverged,
    };
  } finally {
    client.release();
  }
}

// ─── Status ─────────────────────────────────────────────────────

/**
 * Get all expand/contract migration states.
 */
export async function getExpandStatus(client: pg.PoolClient): Promise<ExpandState[]> {
  await ensureExpandStateTable(client);
  const res = await client.query(`SELECT * FROM _smplcty_schema_flow.expand_state ORDER BY created_at DESC`);
  return res.rows as ExpandState[];
}
