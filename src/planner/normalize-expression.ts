/**
 * Normalize SQL expressions in YAML-defined schema (RLS policy USING/CHECK
 * clauses, table CHECK constraints, partial-index WHERE clauses) by
 * round-tripping each through PostgreSQL so the desired (YAML) form
 * matches the introspected (pg_get_expr / pg_get_constraintdef) form
 * exactly. Without this, every migrate would emit drop+recreate ops
 * for objects whose source text differs only in PG's added casts and
 * parens — see issue #26.
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
  // The temp table reuses the real table name so self-qualified
  // references in the expression (`yards.region_id`) resolve against the
  // temp's columns — pg_temp is searched first on search_path and
  // shadows any persistent same-named table for the savepoint's lifetime.
  const tempTable = table.table;
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
       WHERE cls.relname = $1 AND pol.polname = $2
         AND cls.relnamespace = pg_my_temp_schema()`,
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

/**
 * Normalize all CHECK constraint expressions in the given tables by
 * round-tripping through PostgreSQL — same approach as
 * `normalizePolicyExpressions`, but for table-level checks where
 * PG canonically rewrites e.g. `total >= 0` as `total >= 0::numeric`.
 */
export async function normalizeCheckExpressions(client: PoolClient, tables: TableSchema[]): Promise<void> {
  const tablesWithChecks = tables.filter((t) => t.table && t.checks?.length);
  if (tablesWithChecks.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const table of tablesWithChecks) {
      for (const check of table.checks!) {
        check.expression = await normalizeCheckExpression(client, table, check.expression);
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

async function normalizeCheckExpression(client: PoolClient, table: TableSchema, expression: string): Promise<string> {
  // See normalizeExpression for the temp-table-shadows-real-table rationale.
  const tempTable = table.table;
  const constraintName = `_sf_norm_check`;

  await client.query('SAVEPOINT normalize_check');
  try {
    const colDefs = table.columns.map((c) => `"${c.name}" ${mapColumnType(c.type)}`).join(', ');
    await client.query(`CREATE TEMP TABLE "${tempTable}" (${colDefs})`);
    await client.query(`ALTER TABLE "${tempTable}" ADD CONSTRAINT "${constraintName}" CHECK (${expression})`);

    const result = await client.query(
      `SELECT pg_get_constraintdef(con.oid, true) AS def
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
       WHERE cls.relname = $1 AND con.conname = $2
         AND cls.relnamespace = pg_my_temp_schema()`,
      [tempTable, constraintName],
    );

    const def = result.rows[0]?.def as string | undefined;
    await client.query('ROLLBACK TO normalize_check');
    if (!def) return expression;
    // pg_get_constraintdef returns "CHECK ((expr))" or "CHECK (expr)" — extract inner.
    const m = def.match(/^CHECK\s*\(\((.*)\)\)$/s) || def.match(/^CHECK\s*\((.*)\)$/s);
    return m ? m[1] : expression;
  } catch {
    await client.query('ROLLBACK TO normalize_check').catch(() => {});
    return expression;
  }
}

/**
 * Normalize all partial-index WHERE clauses in the given tables by
 * round-tripping through PostgreSQL. Same shape as the policy/check
 * normalisers; uses a temp index to capture PG's canonical form.
 */
export async function normalizeIndexWhereClauses(client: PoolClient, tables: TableSchema[]): Promise<void> {
  const tablesWithPartialIdx = tables.filter((t) => t.table && t.indexes?.some((i) => i.where));
  if (tablesWithPartialIdx.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const table of tablesWithPartialIdx) {
      for (const idx of table.indexes!) {
        if (!idx.where) continue;
        idx.where = await normalizeIndexWhere(client, table, idx.where);
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

/**
 * Normalize all column DEFAULT expressions in the given tables by
 * round-tripping through PostgreSQL. PG canonicalises functional defaults
 * — `CURRENT_TIMESTAMP + INTERVAL '7 days'` becomes
 * `(CURRENT_TIMESTAMP + '7 days'::interval)`, regex literals get `::text`
 * casts, etc. — so the diff has to compare the YAML text against PG's
 * post-rewrite form for ALTER COLUMN SET DEFAULT to settle on a re-plan.
 *
 * Bare-literal defaults (`true`, `'foo'`, `0`) round-trip unchanged in
 * most cases but go through the same path so the behaviour is uniform.
 */
export async function normalizeColumnDefaults(client: PoolClient, tables: TableSchema[]): Promise<void> {
  const tablesWithDefaults = tables.filter(
    (t) => t.table && t.columns.some((c) => c.default !== undefined && c.default !== null),
  );
  if (tablesWithDefaults.length === 0) return;

  await client.query('BEGIN');
  try {
    for (const table of tablesWithDefaults) {
      for (const col of table.columns) {
        if (col.default === undefined || col.default === null) continue;
        col.default = await normalizeColumnDefault(client, table, col.name, col.type, col.default);
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

async function normalizeColumnDefault(
  client: PoolClient,
  table: TableSchema,
  columnName: string,
  columnType: string,
  expression: string,
): Promise<string> {
  // See normalizeExpression for the temp-table-shadows-real-table rationale.
  const tempTable = table.table;

  await client.query('SAVEPOINT normalize_default');
  try {
    await client.query(
      `CREATE TEMP TABLE "${tempTable}" ("${columnName}" ${mapColumnType(columnType)} DEFAULT ${expression})`,
    );

    const result = await client.query(
      `SELECT pg_get_expr(ad.adbin, ad.adrelid) AS expr
       FROM pg_catalog.pg_attrdef ad
       JOIN pg_catalog.pg_class cls ON cls.oid = ad.adrelid
       JOIN pg_catalog.pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
       WHERE cls.relname = $1
         AND a.attname = $2
         AND cls.relnamespace = pg_my_temp_schema()`,
      [tempTable, columnName],
    );

    const expr = result.rows[0]?.expr as string | undefined;
    await client.query('ROLLBACK TO normalize_default');
    return expr ?? expression;
  } catch {
    await client.query('ROLLBACK TO normalize_default').catch(() => {});
    return expression;
  }
}

async function normalizeIndexWhere(client: PoolClient, table: TableSchema, where: string): Promise<string> {
  // See normalizeExpression for the temp-table-shadows-real-table rationale.
  const tempTable = table.table;
  const suffix = Math.random().toString(36).slice(2, 10);
  const tempIdx = `_sf_norm_idx_${suffix}`;
  // Pick the first column for the index key — only the WHERE clause's
  // canonical form matters here; the key column is irrelevant.
  const firstCol = table.columns[0]?.name;
  if (!firstCol) return where;

  await client.query('SAVEPOINT normalize_where');
  try {
    const colDefs = table.columns.map((c) => `"${c.name}" ${mapColumnType(c.type)}`).join(', ');
    await client.query(`CREATE TEMP TABLE "${tempTable}" (${colDefs})`);
    await client.query(`CREATE INDEX "${tempIdx}" ON "${tempTable}" ("${firstCol}") WHERE (${where})`);

    const result = await client.query(
      `SELECT pg_get_expr(ix.indpred, ix.indrelid) AS expr
       FROM pg_catalog.pg_index ix
       JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = i.relnamespace
       WHERE i.relname = $1
         AND ns.oid = pg_my_temp_schema()`,
      [tempIdx],
    );

    const expr = result.rows[0]?.expr as string | undefined;
    await client.query('ROLLBACK TO normalize_where');
    return expr ?? where;
  } catch {
    await client.query('ROLLBACK TO normalize_where').catch(() => {});
    return where;
  }
}
