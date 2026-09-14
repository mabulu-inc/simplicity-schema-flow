/**
 * File tracker for schema-flow.
 *
 * Manages the _smplcty_schema_flow.history table that tracks which files have been
 * applied and their SHA-256 hashes. Files are re-run only when content changes.
 */

import type pg from 'pg';
import type { Phase } from './files.js';
import { createLogger, type Logger } from './logger.js';
import { runBootstrapDDL } from './db.js';

export interface HistoryEntry {
  filePath: string;
  fileHash: string;
  phase: Phase;
  appliedAt: Date;
}

/**
 * Bookkeeping tables schema-flow created in the legacy `_simplicity` schema,
 * with the columns that identify each as ours (from the original DDL).
 * `_simplicity` is also a real application schema name (simplicity-admin keeps
 * its system tables there), so a table only counts as ours when both its name
 * and its columns match.
 */
const LEGACY_TABLES: Record<string, string[]> = {
  history: ['file_path', 'file_hash', 'phase', 'applied_at'],
  snapshots: ['id', 'operations', 'created_at'],
  expand_state: ['id', 'table_name', 'new_column', 'old_column', 'transform', 'trigger_name', 'status', 'created_at'],
};

/**
 * Move schema-flow's legacy bookkeeping tables out of `_simplicity` into
 * `_smplcty_schema_flow`. The `_simplicity` schema itself and everything else
 * in it are never renamed, moved, or dropped (issue #78). Also renames
 * dual-write triggers/functions from `_simplicity_dw_` to `_smplcty_sf_dw_`.
 */
async function migrateLegacySchema(client: pg.PoolClient, logger: Logger): Promise<void> {
  const { rows } = await client.query(
    `SELECT c.relname,
            array_agg(a.attname::text) AS columns,
            to_regclass('_smplcty_schema_flow.' || quote_ident(c.relname)) IS NOT NULL AS target_exists
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = '_simplicity' AND c.relkind = 'r' AND c.relname = ANY($1)
     GROUP BY c.relname
     ORDER BY c.relname`,
    [Object.keys(LEGACY_TABLES)],
  );

  let moved = 0;
  for (const row of rows) {
    const table = row.relname as string;
    const columns = new Set(row.columns as string[]);
    if (!LEGACY_TABLES[table].every((col) => columns.has(col))) continue;

    if (row.target_exists) {
      logger.warn(
        `Legacy _simplicity.${table} left in place: _smplcty_schema_flow.${table} already exists — reconcile manually.`,
      );
      continue;
    }

    await runBootstrapDDL(async () => {
      await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
    });
    await client.query(`ALTER TABLE _simplicity.${table} SET SCHEMA _smplcty_schema_flow`);
    logger.info(`Migrated internal table: _simplicity.${table} → _smplcty_schema_flow.${table}`);
    moved++;
  }

  // Drop `_simplicity` only when this run emptied it. An empty `_simplicity`
  // we did not empty may be an application's, created just before this run
  // (a fresh simplicity-admin bootstrap), and must survive. Every object in a
  // schema records a dependency on it, so no pg_depend rows means empty.
  if (moved > 0) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM pg_depend
       WHERE refclassid = 'pg_namespace'::regclass
         AND refobjid = (SELECT oid FROM pg_namespace WHERE nspname = '_simplicity')
       LIMIT 1`,
    );
    if (rowCount === 0) {
      await client.query('DROP SCHEMA _simplicity RESTRICT');
      logger.info('Dropped legacy schema _simplicity (empty after migration)');
    }
  }

  await renameLegacyDualWriteObjects(client, logger);
}

/**
 * Rename dual-write triggers and functions from `_simplicity_dw_` prefix to `_smplcty_sf_dw_`.
 * Matched with `starts_with`, not `LIKE`: in a LIKE pattern every `_` is a
 * single-character wildcard, so names that merely resemble the prefix match.
 */
async function renameLegacyDualWriteObjects(client: pg.PoolClient, logger: Logger): Promise<void> {
  // Rename triggers
  const triggers = await client.query(`
    SELECT t.tgname, c.relname, n.nspname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE starts_with(t.tgname, '_simplicity_dw_')
  `);
  for (const row of triggers.rows) {
    const oldName = row.tgname as string;
    const newName = oldName.replace('_simplicity_dw_', '_smplcty_sf_dw_');
    await client.query(`ALTER TRIGGER "${oldName}" ON "${row.nspname}"."${row.relname}" RENAME TO "${newName}"`);
    logger.info(`Renamed trigger: ${oldName} → ${newName}`);
  }

  // Rename functions
  const functions = await client.query(`
    SELECT p.proname, n.nspname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE starts_with(p.proname, '_simplicity_dw_')
  `);
  for (const row of functions.rows) {
    const oldName = row.proname as string;
    const newName = oldName.replace('_simplicity_dw_', '_smplcty_sf_dw_');
    await client.query(`ALTER FUNCTION "${row.nspname}"."${oldName}"(${row.args}) RENAME TO "${newName}"`);
    logger.info(`Renamed function: ${oldName} → ${newName}`);
  }
}

/**
 * Ensure the _smplcty_schema_flow schema and history table exist.
 * Relocates any legacy schema-flow tables from `_simplicity` first. Without a
 * logger, relocation messages still go to stdout/stderr — a move must never
 * be silent.
 * Also upgrades pre-pgSchema-aware tables in place: adds the `pg_schema`
 * column (defaulting existing rows to 'public') and re-keys the primary
 * key on `(file_path, pg_schema)` so a single database can manage multiple
 * pgSchemas independently.
 */
export async function ensureHistoryTable(client: pg.PoolClient, logger?: Logger): Promise<void> {
  await migrateLegacySchema(client, logger ?? createLogger({ verbose: false, quiet: false, json: false }));
  // Tolerate concurrent first-runs: parallel migrations against one database
  // (one schema each) can race on creating this shared schema/table, where
  // CREATE ... IF NOT EXISTS still throws a catalog duplicate. The block is
  // idempotent, so runBootstrapDDL re-runs it after a lost race.
  await runBootstrapDDL(async () => {
    await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
    await client.query(`
      CREATE TABLE IF NOT EXISTS _smplcty_schema_flow.history (
        file_path  text NOT NULL,
        file_hash  text NOT NULL,
        phase      text NOT NULL,
        pg_schema  text NOT NULL DEFAULT 'public',
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (file_path, pg_schema)
      )
    `);

    // Upgrade pre-pgSchema-aware history table in place. The column add and PK
    // swap are both idempotent: existing rows get pg_schema='public', and the
    // old single-column PK is replaced with the composite key.
    const hasColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = '_smplcty_schema_flow' AND table_name = 'history' AND column_name = 'pg_schema'`,
    );
    if (hasColumn.rowCount === 0) {
      await client.query(
        "ALTER TABLE _smplcty_schema_flow.history ADD COLUMN pg_schema text NOT NULL DEFAULT 'public'",
      );
      await client.query('ALTER TABLE _smplcty_schema_flow.history DROP CONSTRAINT IF EXISTS history_pkey');
      await client.query('ALTER TABLE _smplcty_schema_flow.history ADD PRIMARY KEY (file_path, pg_schema)');
    }
  });
}

/**
 * Get all entries from the history table for a given pgSchema.
 */
export async function getHistory(client: pg.PoolClient, pgSchema: string): Promise<HistoryEntry[]> {
  const result = await client.query(
    `SELECT file_path, file_hash, phase, applied_at
     FROM _smplcty_schema_flow.history
     WHERE pg_schema = $1
     ORDER BY file_path`,
    [pgSchema],
  );
  return result.rows.map((row) => ({
    filePath: row.file_path,
    fileHash: row.file_hash,
    phase: row.phase as Phase,
    appliedAt: row.applied_at,
  }));
}

/**
 * Get the stored hash for a specific file in a pgSchema, or null if not tracked.
 */
export async function getFileHash(client: pg.PoolClient, filePath: string, pgSchema: string): Promise<string | null> {
  const result = await client.query(
    'SELECT file_hash FROM _smplcty_schema_flow.history WHERE file_path = $1 AND pg_schema = $2',
    [filePath, pgSchema],
  );
  return result.rows.length > 0 ? result.rows[0].file_hash : null;
}

/**
 * Record a file as applied (upsert).
 */
export async function recordFile(
  client: pg.PoolClient,
  filePath: string,
  fileHash: string,
  phase: Phase,
  pgSchema: string,
): Promise<void> {
  await client.query(
    `INSERT INTO _smplcty_schema_flow.history (file_path, file_hash, phase, pg_schema, applied_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (file_path, pg_schema) DO UPDATE
       SET file_hash = EXCLUDED.file_hash,
           phase = EXCLUDED.phase,
           applied_at = EXCLUDED.applied_at`,
    [filePath, fileHash, phase, pgSchema],
  );
}

/**
 * Check if a file needs to be re-run (new file or hash changed for this pgSchema).
 */
export async function fileNeedsApply(
  client: pg.PoolClient,
  filePath: string,
  currentHash: string,
  pgSchema: string,
): Promise<boolean> {
  const storedHash = await getFileHash(client, filePath, pgSchema);
  return storedHash !== currentHash;
}

/**
 * Remove a file's history entry for a pgSchema (e.g., when the file is deleted).
 */
export async function removeFileHistory(client: pg.PoolClient, filePath: string, pgSchema: string): Promise<boolean> {
  const result = await client.query(
    'DELETE FROM _smplcty_schema_flow.history WHERE file_path = $1 AND pg_schema = $2',
    [filePath, pgSchema],
  );
  return (result.rowCount ?? 0) > 0;
}
