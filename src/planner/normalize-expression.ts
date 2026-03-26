/**
 * Normalize RLS policy USING/CHECK expressions by round-tripping
 * through PostgreSQL so the desired (YAML) form matches the introspected
 * (pg_get_expr) form exactly.
 */

import type { PoolClient } from 'pg';
import type { TableSchema } from '../schema/types.js';

/**
 * Normalize all USING/CHECK expressions in the given tables' policies
 * by round-tripping each expression through PostgreSQL.
 *
 * Mutates the policy objects in place. Uses a single transaction that
 * is always rolled back — no persistent changes are made.
 */
export async function normalizePolicyExpressions(client: PoolClient, tables: TableSchema[]): Promise<void> {
  const tablesWithPolicies = tables.filter((t) => t.table && t.policies?.length);
  if (tablesWithPolicies.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const table of tablesWithPolicies) {
      for (const policy of table.policies!) {
        if (policy.using) {
          policy.using = await normalizeExpression(client, table, policy.using, 'using');
        }
        if (policy.check) {
          policy.check = await normalizeExpression(client, table, policy.check, 'check');
        }
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

async function normalizeExpression(
  client: PoolClient,
  table: TableSchema,
  expression: string,
  kind: 'using' | 'check',
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const tempTable = `_sf_norm_${suffix}`;
  const policyName = '_sf_norm_policy';

  await client.query('SAVEPOINT normalize_expr');
  try {
    const colDefs = table.columns.map((c) => `"${c.name}" ${mapColumnType(c.type)}`).join(', ');
    await client.query(`CREATE TEMP TABLE "${tempTable}" (${colDefs})`);
    await client.query(`ALTER TABLE "${tempTable}" ENABLE ROW LEVEL SECURITY`);

    const clause = kind === 'check' ? `WITH CHECK (${expression})` : `USING (${expression})`;
    await client.query(`CREATE POLICY "${policyName}" ON "${tempTable}" FOR ALL ${clause}`);

    const exprColumn =
      kind === 'check' ? 'pg_get_expr(pol.polwithcheck, pol.polrelid)' : 'pg_get_expr(pol.polqual, pol.polrelid)';
    const result = await client.query(
      `SELECT ${exprColumn} AS expr
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class cls ON cls.oid = pol.polrelid
       WHERE cls.relname = $1 AND pol.polname = $2`,
      [tempTable, policyName],
    );

    const normalized = result.rows[0]?.expr;
    await client.query('ROLLBACK TO normalize_expr');
    return normalized ?? expression;
  } catch {
    await client.query('ROLLBACK TO normalize_expr').catch(() => {});
    return expression;
  }
}

/**
 * Map schema types to simple PostgreSQL types for the temp table.
 * Only needs to be accurate enough for expression parsing.
 */
function mapColumnType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === 'serial' || lower === 'bigserial' || lower === 'smallserial') {
    return 'integer';
  }
  return type;
}
