/**
 * Expand/contract module for zero-downtime column migrations.
 *
 * Flow:
 * 1. Expand: add new column, create dual-write trigger, backfill existing rows
 * 2. Application switches to reading new column
 * 3. Contract: drop old column and trigger
 *
 * State tracked in `_simplicity.expand_state`.
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
  | 'backfill_column'
  | 'contract_column'
  | 'drop_dual_write_trigger';

export interface ExpandOperation {
  type: ExpandOperationType;
  phase: number;
  objectName: string;
  sql: string;
  destructive: boolean;
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
 * Create the _simplicity.expand_state table if it doesn't exist.
 */
export async function ensureExpandStateTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _simplicity.expand_state (
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
}

// ─── Plan Expand ────────────────────────────────────────────────

/**
 * Generate the trigger function name for an expand migration.
 */
function triggerName(pgSchema: string | undefined, tableName: string, newColumn: string): string {
  const prefix = pgSchema ? `${pgSchema}_` : '';
  return `_simplicity_dw_${prefix}${tableName}_${newColumn}`;
}

/**
 * Generate the trigger function name used in the schema for the function.
 */
function triggerFnName(pgSchema: string | undefined, tableName: string, newColumn: string): string {
  return `_simplicity_dw_fn_${pgSchema ? `${pgSchema}_` : ''}${tableName}_${newColumn}`;
}

/**
 * Plan expand operations for a column migration.
 *
 * Returns operations to:
 * 1. Add the new column
 * 2. Create a dual-write trigger (+ function)
 * 3. Backfill existing rows
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

  const ops: ExpandOperation[] = [];

  // 1. Add the new column
  ops.push({
    type: 'expand_column',
    phase: 100,
    objectName: `${tableName}.${newColumn}`,
    sql: `ALTER TABLE ${qualifiedTable} ADD COLUMN ${newColumn} ${columnType}`,
    destructive: false,
  });

  // 2. Create dual-write trigger function + trigger
  const triggerSql = `
CREATE OR REPLACE FUNCTION ${qualifiedFn}() RETURNS trigger AS $$
BEGIN
  NEW.${newColumn} := ${expand.transform.replace(/\b(\w+)\b/g, (match) => {
    // Replace column references with NEW.column
    if (match === expand.from) return `NEW.${match}`;
    return match;
  })};
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
  });

  // 3. Backfill existing rows
  ops.push({
    type: 'backfill_column',
    phase: 102,
    objectName: `${tableName}.${newColumn}`,
    sql: `UPDATE ${qualifiedTable} SET ${newColumn} = ${expand.transform} WHERE ${newColumn} IS NULL`,
    destructive: false,
  });

  return ops;
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
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const { connectionString, tableName, newColumn, transform, batchSize = 1000, pgSchema, logger } = options;

  const qualifiedTable = pgSchema ? `${pgSchema}.${tableName}` : tableName;
  const pool = getPool(connectionString);
  let totalUpdated = 0;

  // Batch update using ctid for efficiency
  while (true) {
    const client = await pool.connect();
    try {
      const res = await client.query(
        `UPDATE ${qualifiedTable} SET ${newColumn} = ${transform}
         WHERE ctid = ANY(
           ARRAY(SELECT ctid FROM ${qualifiedTable} WHERE ${newColumn} IS NULL LIMIT ${batchSize})
         )`,
      );
      const updated = res.rowCount ?? 0;
      totalUpdated += updated;
      logger?.debug(`Backfilled ${updated} rows (total: ${totalUpdated})`);
      if (updated < batchSize) break;
    } finally {
      client.release();
    }
  }

  logger?.info(`Backfill complete: ${totalUpdated} rows updated in ${qualifiedTable}.${newColumn}`);
  return { rowsUpdated: totalUpdated };
}

// ─── Contract ───────────────────────────────────────────────────

export interface ContractOptions {
  connectionString: string;
  tableName: string;
  newColumn: string;
  pgSchema?: string;
  logger?: Logger;
}

export interface ContractResult {
  dropped: boolean;
  oldColumn: string;
  triggerDropped: boolean;
}

/**
 * Complete the contract phase: drop old column and dual-write trigger.
 */
export async function runContract(options: ContractOptions): Promise<ContractResult> {
  const { connectionString, tableName, newColumn, pgSchema, logger } = options;

  const qualifiedTableName = pgSchema ? `${pgSchema}.${tableName}` : tableName;
  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    // Ensure expand_state table exists
    await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
    await ensureExpandStateTable(client);

    // Look up expand state
    const stateRes = await client.query(
      `SELECT * FROM _simplicity.expand_state
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

    const qualifiedTable = pgSchema ? `${pgSchema}.${tableName}` : tableName;
    const fnName = triggerFnName(pgSchema, tableName, newColumn);
    const qualifiedFn = pgSchema ? `${pgSchema}.${fnName}` : fnName;

    // Acquire advisory lock
    const acquired = await acquireAdvisoryLock(client);
    if (!acquired) {
      throw new Error('Could not acquire advisory lock — another migration may be running');
    }

    try {
      await client.query('BEGIN');

      // Drop the trigger
      await client.query(`DROP TRIGGER IF EXISTS ${state.trigger_name} ON ${qualifiedTable}`);
      logger?.info(`Dropped trigger ${state.trigger_name}`);

      // Drop the trigger function
      await client.query(`DROP FUNCTION IF EXISTS ${qualifiedFn}()`);
      logger?.info(`Dropped function ${qualifiedFn}`);

      // Drop old column
      await client.query(`ALTER TABLE ${qualifiedTable} DROP COLUMN ${state.old_column}`);
      logger?.info(`Dropped column ${qualifiedTable}.${state.old_column}`);

      // Update expand state
      await client.query(`UPDATE _simplicity.expand_state SET status = 'contracted' WHERE id = $1`, [state.id]);

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
  const res = await client.query(`SELECT * FROM _simplicity.expand_state ORDER BY created_at DESC`);
  return res.rows as ExpandState[];
}
