/**
 * E2E test helpers for simplicity-schema.
 *
 * Re-exports core test utilities and adds E2E-specific helpers
 * for querying the database and asserting schema state.
 */

import { getPool } from '../../src/core/db.js';
import type { TestProject } from '../../src/testing/index.js';

export { useTestProject, writeSchema } from '../../src/testing/index.js';
export type { TestProject } from '../../src/testing/index.js';

export interface ColumnInfo {
  type: string;
  nullable: boolean;
  default: string | null;
  generated: string | null;
}

/**
 * Run the full migration pipeline against a test project and return the result.
 */
export async function runMigration(ctx: TestProject, opts?: { allowDestructive?: boolean }) {
  return ctx.migrate(opts);
}

/**
 * Execute arbitrary SQL against the test project's database.
 */
export async function queryDb(ctx: TestProject, sql: string, params?: unknown[]) {
  const pool = getPool(ctx.config.connectionString);
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Assert that a table exists in the test project's schema.
 */
export async function assertTableExists(ctx: TestProject, name: string): Promise<void> {
  const result = await queryDb(
    ctx,
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [ctx.schema, name],
  );
  if (result.rowCount === 0) {
    throw new Error(`Expected table "${name}" to exist in schema "${ctx.schema}", but it does not`);
  }
}

/**
 * Assert that a column exists on a table in the test project's schema.
 */
export async function assertColumnExists(ctx: TestProject, table: string, column: string): Promise<void> {
  const result = await queryDb(
    ctx,
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [ctx.schema, table, column],
  );
  if (result.rowCount === 0) {
    throw new Error(`Expected column "${column}" on table "${table}" in schema "${ctx.schema}", but it does not exist`);
  }
}

/**
 * Assert that an enum type exists with exactly the given values (order-sensitive).
 */
export async function assertEnumValues(ctx: TestProject, name: string, values: string[]): Promise<void> {
  const result = await queryDb(
    ctx,
    `SELECT e.enumlabel
     FROM pg_enum e
     JOIN pg_type t ON e.enumtypid = t.oid
     JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE n.nspname IN ($1, 'public') AND t.typname = $2
     ORDER BY e.enumsortorder`,
    [ctx.schema, name],
  );
  const actual = result.rows.map((r: { enumlabel: string }) => r.enumlabel);
  if (JSON.stringify(actual) !== JSON.stringify(values)) {
    throw new Error(
      `Expected enum "${name}" to have values ${JSON.stringify(values)}, but got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Get detailed column information from the test project's schema.
 */
export async function getColumnInfo(ctx: TestProject, table: string, column: string): Promise<ColumnInfo> {
  const result = await queryDb(
    ctx,
    `SELECT
       data_type AS type,
       is_nullable = 'YES' AS nullable,
       column_default AS "default",
       generation_expression AS generated
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [ctx.schema, table, column],
  );
  if (result.rowCount === 0) {
    throw new Error(`Column "${column}" not found on table "${table}" in schema "${ctx.schema}"`);
  }
  const row = result.rows[0];
  return {
    type: row.type,
    nullable: row.nullable,
    default: row.default ?? null,
    generated: row.generated ?? null,
  };
}
