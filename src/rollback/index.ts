/**
 * Rollback module for simplicity-schema.
 *
 * Captures migration snapshots before execution and computes reverse
 * operations to undo a migration via the `down` command.
 */

import type pg from 'pg';
import type { Operation, OperationType } from '../planner/index.js';
import type { Logger } from '../core/logger.js';
import { getPool } from '../core/db.js';
import { acquireAdvisoryLock, releaseAdvisoryLock } from '../executor/index.js';

// ─── Types ───────────────────────────────────────────────────────

export interface MigrationSnapshot {
  id: number;
  operations: Operation[];
  pgSchema: string;
  createdAt: Date;
}

export interface RollbackResult {
  operations: Operation[];
  /** Operations that could not be reversed */
  skipped: string[];
}

export interface RunDownResult {
  executed: number;
  skipped: string[];
}

// ─── Snapshot Table ──────────────────────────────────────────────

/**
 * Ensure the _simplicity.snapshots table exists.
 */
export async function ensureSnapshotsTable(client: pg.PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
  await client.query(`
    CREATE TABLE IF NOT EXISTS _simplicity.snapshots (
      id          serial PRIMARY KEY,
      operations  jsonb NOT NULL,
      pg_schema   text NOT NULL DEFAULT 'public',
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Save a migration snapshot.
 */
export async function saveSnapshot(client: pg.PoolClient, operations: Operation[], pgSchema: string): Promise<number> {
  const res = await client.query(
    `INSERT INTO _simplicity.snapshots (operations, pg_schema)
     VALUES ($1, $2) RETURNING id`,
    [JSON.stringify(operations), pgSchema],
  );
  return res.rows[0].id;
}

/**
 * Get the most recent migration snapshot, or null if none exist.
 */
export async function getLatestSnapshot(client: pg.PoolClient): Promise<MigrationSnapshot | null> {
  const res = await client.query(
    `SELECT id, operations, pg_schema, created_at
     FROM _simplicity.snapshots
     ORDER BY id DESC LIMIT 1`,
  );
  if (res.rows.length === 0) return null;
  return rowToSnapshot(res.rows[0]);
}

/**
 * List all snapshots in reverse chronological order.
 */
export async function listSnapshots(client: pg.PoolClient): Promise<MigrationSnapshot[]> {
  const res = await client.query(
    `SELECT id, operations, pg_schema, created_at
     FROM _simplicity.snapshots
     ORDER BY id DESC`,
  );
  return res.rows.map(rowToSnapshot);
}

/**
 * Delete a snapshot by ID.
 */
export async function deleteSnapshot(client: pg.PoolClient, snapshotId: number): Promise<void> {
  await client.query('DELETE FROM _simplicity.snapshots WHERE id = $1', [snapshotId]);
}

function rowToSnapshot(row: Record<string, unknown>): MigrationSnapshot {
  return {
    id: row.id as number,
    operations: row.operations as Operation[],
    pgSchema: row.pg_schema as string,
    createdAt: row.created_at as Date,
  };
}

// ─── Compute Rollback ────────────────────────────────────────────

/** Operation types that cannot be reversed */
const IRREVERSIBLE_TYPES: Set<OperationType> = new Set([
  'add_enum_value',
  'alter_column',
  'drop_column',
  'drop_table',
  'drop_index',
  'drop_trigger',
  'drop_policy',
  'drop_view',
  'drop_materialized_view',
  'drop_extension',
  'disable_rls',
  'alter_role',
  'revoke_table',
  'validate_constraint',
  'set_comment',
  'add_seed',
  'refresh_materialized_view',
  'drop_foreign_key',
  'drop_unique_constraint',
]);

/**
 * Compute reverse operations from a migration snapshot.
 *
 * Returns operations in reverse order so dependencies are respected
 * (e.g., drop column before drop table).
 */
export function computeRollback(snapshot: MigrationSnapshot): RollbackResult {
  const operations: Operation[] = [];
  const skipped: string[] = [];
  const { pgSchema } = snapshot;

  // Process in reverse order
  const reversed = [...snapshot.operations].reverse();

  for (const op of reversed) {
    if (IRREVERSIBLE_TYPES.has(op.type)) {
      skipped.push(`${op.type} ${op.objectName} (irreversible)`);
      continue;
    }

    const reverseOp = computeReverseOperation(op, pgSchema);
    if (reverseOp) {
      operations.push(reverseOp);
    } else {
      skipped.push(`${op.type} ${op.objectName} (no reverse mapping)`);
    }
  }

  return { operations, skipped };
}

function computeReverseOperation(op: Operation, pgSchema: string): Operation | null {
  const q = (name: string) => `"${name}"`;

  switch (op.type) {
    case 'create_table':
      return {
        type: 'drop_table',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP TABLE IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };

    case 'add_column': {
      const [table, column] = splitObjectName(op.objectName);
      return {
        type: 'drop_column',
        phase: op.phase,
        objectName: op.objectName,
        sql: `ALTER TABLE ${q(pgSchema)}.${q(table)} DROP COLUMN IF EXISTS ${q(column)}`,
        destructive: true,
      };
    }

    case 'add_index': {
      return {
        type: 'drop_index',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP INDEX IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };
    }

    case 'create_enum':
      return {
        type: 'create_enum' as OperationType, // reusing type for drop
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP TYPE IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };

    case 'create_function':
      return {
        type: 'create_function' as OperationType,
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP FUNCTION IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };

    case 'create_view':
      return {
        type: 'drop_view',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP VIEW IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };

    case 'create_materialized_view':
      return {
        type: 'drop_materialized_view',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP MATERIALIZED VIEW IF EXISTS ${q(pgSchema)}.${q(op.objectName)}`,
        destructive: true,
      };

    case 'create_trigger': {
      const [table, trigger] = splitObjectName(op.objectName);
      return {
        type: 'drop_trigger',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP TRIGGER IF EXISTS ${q(trigger)} ON ${q(pgSchema)}.${q(table)}`,
        destructive: true,
      };
    }

    case 'enable_rls':
      return {
        type: 'disable_rls',
        phase: op.phase,
        objectName: op.objectName,
        sql: `ALTER TABLE ${q(pgSchema)}.${q(op.objectName)} DISABLE ROW LEVEL SECURITY`,
        destructive: true,
      };

    case 'create_policy': {
      const [table, policy] = splitObjectName(op.objectName);
      return {
        type: 'drop_policy',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP POLICY IF EXISTS ${q(policy)} ON ${q(pgSchema)}.${q(table)}`,
        destructive: true,
      };
    }

    case 'create_extension':
      return {
        type: 'drop_extension',
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP EXTENSION IF EXISTS ${q(op.objectName)}`,
        destructive: true,
      };

    case 'create_role':
      return {
        type: 'create_role' as OperationType,
        phase: op.phase,
        objectName: op.objectName,
        sql: `DROP ROLE IF EXISTS ${q(op.objectName)}`,
        destructive: true,
      };

    case 'add_foreign_key':
    case 'add_foreign_key_not_valid': {
      const [table, constraint] = splitObjectName(op.objectName);
      return {
        type: 'drop_foreign_key',
        phase: op.phase,
        objectName: op.objectName,
        sql: `ALTER TABLE ${q(pgSchema)}.${q(table)} DROP CONSTRAINT IF EXISTS ${q(constraint)}`,
        destructive: true,
      };
    }

    case 'add_check': {
      const [table, constraint] = splitObjectName(op.objectName);
      return {
        type: 'add_check' as OperationType,
        phase: op.phase,
        objectName: op.objectName,
        sql: `ALTER TABLE ${q(pgSchema)}.${q(table)} DROP CONSTRAINT IF EXISTS ${q(constraint)}`,
        destructive: true,
      };
    }

    case 'add_unique_constraint': {
      const [table, constraint] = splitObjectName(op.objectName);
      return {
        type: 'drop_unique_constraint',
        phase: op.phase,
        objectName: op.objectName,
        sql: `ALTER TABLE ${q(pgSchema)}.${q(table)} DROP CONSTRAINT IF EXISTS ${q(constraint)}`,
        destructive: true,
      };
    }

    case 'grant_table': {
      const [table, role] = splitObjectName(op.objectName);
      return {
        type: 'revoke_table',
        phase: op.phase,
        objectName: op.objectName,
        sql: `REVOKE ALL ON ${q(pgSchema)}.${q(table)} FROM ${q(role)}`,
        destructive: true,
      };
    }

    default:
      return null;
  }
}

function splitObjectName(objectName: string): [string, string] {
  const dotIdx = objectName.indexOf('.');
  if (dotIdx === -1) {
    return [objectName, objectName];
  }
  return [objectName.substring(0, dotIdx), objectName.substring(dotIdx + 1)];
}

// ─── Run Down ────────────────────────────────────────────────────

export interface RunDownOptions {
  logger?: Logger;
}

/**
 * Execute a rollback: load the latest snapshot, compute reverse operations,
 * execute them, and delete the snapshot.
 */
export async function runDown(connectionString: string, options: RunDownOptions = {}): Promise<RunDownResult> {
  const { logger } = options;
  const pool = getPool(connectionString);
  const lockClient = await pool.connect();

  try {
    const acquired = await acquireAdvisoryLock(lockClient);
    if (!acquired) {
      throw new Error('Could not acquire advisory lock — another migration may be running');
    }

    try {
      await ensureSnapshotsTable(lockClient);

      const snapshot = await getLatestSnapshot(lockClient);
      if (!snapshot) {
        throw new Error('No migration snapshot found — nothing to rollback');
      }

      const { operations, skipped } = computeRollback(snapshot);

      if (skipped.length > 0) {
        logger?.warn(`Skipped ${skipped.length} irreversible operation(s):`);
        for (const s of skipped) {
          logger?.warn(`  - ${s}`);
        }
      }

      let executed = 0;

      if (operations.length > 0) {
        const opClient = await pool.connect();
        try {
          await opClient.query('BEGIN');
          for (const op of operations) {
            logger?.debug(`Rollback: ${op.type} ${op.objectName}`);
            await opClient.query(op.sql);
            executed++;
          }
          await opClient.query('COMMIT');
        } catch (err) {
          await opClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          opClient.release();
        }
      }

      // Delete the snapshot after successful rollback
      await deleteSnapshot(lockClient, snapshot.id);
      logger?.info(`Rollback complete: ${executed} operation(s) reversed`);

      return { executed, skipped };
    } finally {
      await releaseAdvisoryLock(lockClient);
    }
  } finally {
    lockClient.release();
  }
}
