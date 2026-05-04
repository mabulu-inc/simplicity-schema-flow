/**
 * Suppress seed_table emission when every YAML seed row already exists
 * verbatim in the target database. Mutates `table.seeds` to `[]` for
 * tables whose seeds match exactly, so the planner emits no op for them.
 *
 * Strategy: load the YAML seeds into a temp table and EXCEPT-compare
 * against the real table over the seed-declared columns. If the result
 * is empty, every seed row has a matching row in the real table.
 *
 * Skipped (seeds left intact, planner emits the op as before):
 *  - tables with seed values that are SQL expressions (`{ __sql: '…' }`)
 *    — those evaluate at apply time and can't be compared statically;
 *  - tables whose primary key isn't present in every seed row — without
 *    a stable identity column we can't tell "row exists with same data"
 *    from "row exists with different data";
 *  - first-apply against a fresh DB where the real table doesn't exist
 *    yet — the EXCEPT throws, the catch leaves seeds intact.
 */

import type { PoolClient } from 'pg';
import type { TableSchema } from '../schema/types.js';

export async function filterUnchangedSeeds(client: PoolClient, tables: TableSchema[], pgSchema: string): Promise<void> {
  const candidates = tables.filter((t) => t.table && t.seeds && t.seeds.length > 0);
  if (candidates.length === 0) return;

  await client.query('BEGIN');
  try {
    await processCandidates(client, candidates, pgSchema);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function processCandidates(client: PoolClient, candidates: TableSchema[], pgSchema: string): Promise<void> {
  for (const table of candidates) {
    const seeds = table.seeds!;

    if (seeds.some((row) => Object.values(row).some(isSqlExpression))) continue;

    const seedColumns = collectSeedColumns(seeds);
    const pkCols = (table.columns ?? []).filter((c) => c.primary_key).map((c) => c.name);
    if (pkCols.length === 0) continue;
    if (!pkCols.every((c) => seedColumns.includes(c))) continue;

    const colDefMap = new Map((table.columns ?? []).map((c) => [c.name, mapColumnType(c.type)]));
    if (!seedColumns.every((c) => colDefMap.has(c))) continue;

    await client.query('SAVEPOINT filter_seeds');
    try {
      const tempName = `_sf_seed_${Math.random().toString(36).slice(2, 10)}`;
      const colDefs = seedColumns.map((c) => `"${c}" ${colDefMap.get(c)}`).join(', ');
      await client.query(`CREATE TEMP TABLE "${tempName}" (${colDefs})`);

      const params: unknown[] = [];
      const valueLines = seeds.map((row) => {
        const placeholders = seedColumns.map((c) => {
          params.push(row[c] ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      const colList = seedColumns.map((c) => `"${c}"`).join(', ');
      await client.query(`INSERT INTO "${tempName}" (${colList}) VALUES ${valueLines.join(', ')}`, params);

      const diff = await client.query(
        `SELECT 1 FROM (
           SELECT ${colList} FROM "${tempName}"
           EXCEPT
           SELECT ${colList} FROM "${pgSchema}"."${table.table}"
         ) d LIMIT 1`,
      );

      if (diff.rows.length === 0) {
        table.seeds = [];
      }
    } catch {
      // Real table missing, type mismatch in temp insert, or EXCEPT
      // column-resolution failure — leave seeds intact, planner emits
      // the op as before.
    } finally {
      await client.query('ROLLBACK TO filter_seeds').catch(() => {});
    }
  }
}

function isSqlExpression(val: unknown): boolean {
  return (
    typeof val === 'object' && val !== null && '__sql' in val && typeof (val as { __sql: string }).__sql === 'string'
  );
}

function collectSeedColumns(seeds: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of seeds) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

function mapColumnType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === 'serial' || lower === 'bigserial' || lower === 'smallserial') return 'integer';
  return type;
}
