/**
 * File tracker for simplicity-schema.
 *
 * Manages the _simplicity.history table that tracks which files have been
 * applied and their SHA-256 hashes. Files are re-run only when content changes.
 */

import type pg from 'pg';
import type { Phase } from './files.js';

export interface HistoryEntry {
  filePath: string;
  fileHash: string;
  phase: Phase;
  appliedAt: Date;
}

/**
 * Ensure the _simplicity schema and history table exist.
 */
export async function ensureHistoryTable(client: pg.PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
  await client.query(`
    CREATE TABLE IF NOT EXISTS _simplicity.history (
      file_path  text PRIMARY KEY,
      file_hash  text NOT NULL,
      phase      text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Get all entries from the history table.
 */
export async function getHistory(client: pg.PoolClient): Promise<HistoryEntry[]> {
  const result = await client.query(
    'SELECT file_path, file_hash, phase, applied_at FROM _simplicity.history ORDER BY file_path',
  );
  return result.rows.map((row) => ({
    filePath: row.file_path,
    fileHash: row.file_hash,
    phase: row.phase as Phase,
    appliedAt: row.applied_at,
  }));
}

/**
 * Get the stored hash for a specific file, or null if not tracked.
 */
export async function getFileHash(client: pg.PoolClient, filePath: string): Promise<string | null> {
  const result = await client.query('SELECT file_hash FROM _simplicity.history WHERE file_path = $1', [filePath]);
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
): Promise<void> {
  await client.query(
    `INSERT INTO _simplicity.history (file_path, file_hash, phase, applied_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (file_path) DO UPDATE
       SET file_hash = EXCLUDED.file_hash,
           phase = EXCLUDED.phase,
           applied_at = EXCLUDED.applied_at`,
    [filePath, fileHash, phase],
  );
}

/**
 * Check if a file needs to be re-run (new file or hash changed).
 */
export async function fileNeedsApply(client: pg.PoolClient, filePath: string, currentHash: string): Promise<boolean> {
  const storedHash = await getFileHash(client, filePath);
  return storedHash !== currentHash;
}

/**
 * Remove a file's history entry (e.g., when file is deleted).
 */
export async function removeFileHistory(client: pg.PoolClient, filePath: string): Promise<boolean> {
  const result = await client.query('DELETE FROM _simplicity.history WHERE file_path = $1', [filePath]);
  return (result.rowCount ?? 0) > 0;
}
