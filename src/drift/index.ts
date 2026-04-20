/**
 * Drift detection for schema-flow.
 *
 * Performs a read-only comparison of YAML definitions against the live
 * database state, producing a structured DriftReport.
 */

import type { PoolClient } from 'pg';
import type { DesiredState, ActualState } from '../planner/index.js';
import { normalizeGrants } from '../planner/index.js';
import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  CheckDef,
  UniqueConstraintDef,
  TriggerDef,
  PolicyDef,
  GrantDef,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
} from '../schema/types.js';

// ─── Types ──────────────────────────────────────────────────────

export type DriftItemType =
  | 'table'
  | 'column'
  | 'index'
  | 'constraint'
  | 'enum'
  | 'function'
  | 'view'
  | 'materialized_view'
  | 'role'
  | 'grant'
  | 'trigger'
  | 'policy'
  | 'comment'
  | 'seed'
  | 'extension';

export type DriftStatus = 'missing_in_db' | 'missing_in_yaml' | 'different';

export interface DriftItem {
  type: DriftItemType;
  object: string;
  status: DriftStatus;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface DriftReport {
  items: DriftItem[];
  summary: { total: number; byType: Record<string, number> };
}

// ─── Seed Hydration ────────────────────────────────────────────

/**
 * Query the database for actual seed data and attach it to the actual table state.
 * For each desired table with seeds, queries the matching rows by PK and sets
 * them on the actual table so drift detection can compare them.
 */
export async function hydrateActualSeeds(
  client: PoolClient,
  desiredTables: TableSchema[],
  actualTables: Map<string, TableSchema>,
  pgSchema: string,
): Promise<void> {
  for (const dt of desiredTables) {
    if (!dt.seeds || dt.seeds.length === 0) continue;
    const at = actualTables.get(dt.table);
    if (!at) continue;

    const pkCols = dt.columns.filter((c) => c.primary_key).map((c) => c.name);
    if (pkCols.length === 0) continue;

    const seedCols = Object.keys(dt.seeds[0]);

    const rows: Record<string, unknown>[] = [];
    for (const seed of dt.seeds) {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < pkCols.length; i++) {
        params.push(seed[pkCols[i]]);
        whereParts.push(`"${pkCols[i]}" = $${i + 1}`);
      }

      const colList = seedCols.map((c) => `"${c}"`).join(', ');
      const sql = `SELECT ${colList} FROM "${pgSchema}"."${dt.table}" WHERE ${whereParts.join(' AND ')} LIMIT 1`;
      const result = await client.query(sql, params);
      if (result.rows.length > 0) {
        rows.push(result.rows[0] as Record<string, unknown>);
      }
    }

    at.seeds = rows;
  }
}

// ─── Main ───────────────────────────────────────────────────────

export function detectDrift(desired: DesiredState, actual: ActualState): DriftReport {
  const items: DriftItem[] = [];

  items.push(...driftExtensions(desired.extensions, actual.extensions));
  items.push(...driftEnums(desired.enums, actual.enums));
  items.push(...driftRoles(desired.roles, actual.roles));
  items.push(...driftFunctions(desired.functions, actual.functions));
  items.push(...driftTables(desired.tables, actual.tables));
  items.push(...driftViews(desired.views, actual.views));
  items.push(...driftMaterializedViews(desired.materializedViews, actual.materializedViews));

  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
  }

  return { items, summary: { total: items.length, byType } };
}

// ─── Extensions ─────────────────────────────────────────────────

function driftExtensions(desired: DesiredState['extensions'], actual: string[]): DriftItem[] {
  const items: DriftItem[] = [];
  const desiredExts = desired?.extensions ?? [];

  for (const ext of desiredExts) {
    if (!actual.includes(ext)) {
      items.push({ type: 'extension', object: ext, status: 'missing_in_db' });
    }
  }
  for (const ext of actual) {
    if (!desiredExts.includes(ext)) {
      items.push({ type: 'extension', object: ext, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Enums ──────────────────────────────────────────────────────

function driftEnums(desired: EnumSchema[], actual: Map<string, EnumSchema>): DriftItem[] {
  const items: DriftItem[] = [];

  for (const de of desired) {
    const ae = actual.get(de.name);
    if (!ae) {
      items.push({ type: 'enum', object: de.name, status: 'missing_in_db' });
    } else {
      const dv = de.values.join(', ');
      const av = ae.values.join(', ');
      if (dv !== av) {
        items.push({
          type: 'enum',
          object: de.name,
          status: 'different',
          expected: dv,
          actual: av,
          detail: `Values differ: expected [${dv}], actual [${av}]`,
        });
      }
    }
  }
  for (const [name] of actual) {
    if (!desired.find((e) => e.name === name)) {
      items.push({ type: 'enum', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Roles ──────────────────────────────────────────────────────

function driftRoles(desired: RoleSchema[], actual: Map<string, RoleSchema>): DriftItem[] {
  const items: DriftItem[] = [];

  for (const dr of desired) {
    const ar = actual.get(dr.role);
    if (!ar) {
      items.push({ type: 'role', object: dr.role, status: 'missing_in_db' });
    } else {
      const diffs: string[] = [];
      if (dr.login !== undefined && dr.login !== ar.login) diffs.push('login');
      if (dr.superuser !== undefined && dr.superuser !== ar.superuser) diffs.push('superuser');
      if (dr.createdb !== undefined && dr.createdb !== ar.createdb) diffs.push('createdb');
      if (dr.createrole !== undefined && dr.createrole !== ar.createrole) diffs.push('createrole');
      if (dr.inherit !== undefined && dr.inherit !== ar.inherit) diffs.push('inherit');
      if (dr.bypassrls !== undefined && dr.bypassrls !== ar.bypassrls) diffs.push('bypassrls');
      if (dr.replication !== undefined && dr.replication !== ar.replication) diffs.push('replication');
      if (dr.connection_limit !== undefined && dr.connection_limit !== ar.connection_limit)
        diffs.push('connection_limit');
      // Membership comparison
      const dMemberships = (dr.in || []).sort().join(',');
      const aMemberships = (ar.in || []).sort().join(',');
      if (dMemberships !== aMemberships) diffs.push('membership');
      if (diffs.length > 0) {
        items.push({
          type: 'role',
          object: dr.role,
          status: 'different',
          detail: `Attributes differ: ${diffs.join(', ')}`,
        });
      }
    }
  }
  for (const [name] of actual) {
    if (!desired.find((r) => r.role === name)) {
      items.push({ type: 'role', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Functions ──────────────────────────────────────────────────

function driftFunctions(desired: FunctionSchema[], actual: Map<string, FunctionSchema>): DriftItem[] {
  const items: DriftItem[] = [];

  for (const df of desired) {
    const af = actual.get(df.name);
    if (!af) {
      items.push({ type: 'function', object: df.name, status: 'missing_in_db' });
    } else {
      const diffs: string[] = [];
      if (normalizeWhitespace(df.body) !== normalizeWhitespace(af.body)) diffs.push('body');
      if (df.returns !== af.returns) diffs.push('returns');
      if ((df.security || 'invoker') !== (af.security || 'invoker')) diffs.push('security');
      if ((df.volatility || 'volatile') !== (af.volatility || 'volatile')) diffs.push('volatility');
      if ((df.parallel || 'unsafe') !== (af.parallel || 'unsafe')) diffs.push('parallel');
      if (!!df.strict !== !!af.strict) diffs.push('strict');
      if (!!df.leakproof !== !!af.leakproof) diffs.push('leakproof');
      if ((df.cost ?? null) !== (af.cost ?? null)) diffs.push('cost');
      if ((df.rows ?? null) !== (af.rows ?? null)) diffs.push('rows');
      const dSet = JSON.stringify(df.set || {});
      const aSet = JSON.stringify(af.set || {});
      if (dSet !== aSet) diffs.push('set');
      const dArgs = (df.args || []).map((a) => `${a.name}:${a.type}`).join(',');
      const aArgs = (af.args || []).map((a) => `${a.name}:${a.type}`).join(',');
      if (dArgs !== aArgs) diffs.push('args');
      if (diffs.length > 0) {
        items.push({
          type: 'function',
          object: df.name,
          status: 'different',
          detail: `Differs in: ${diffs.join(', ')}`,
        });
      }
    }
  }
  for (const [name] of actual) {
    if (!desired.find((f) => f.name === name)) {
      items.push({ type: 'function', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Tables ─────────────────────────────────────────────────────

function driftTables(desired: TableSchema[], actual: Map<string, TableSchema>): DriftItem[] {
  const items: DriftItem[] = [];

  for (const dt of desired) {
    const at = actual.get(dt.table);
    if (!at) {
      items.push({ type: 'table', object: dt.table, status: 'missing_in_db' });
    } else {
      items.push(...driftCompositePk(dt.table, dt, at));
      items.push(...driftColumns(dt.table, dt.columns, at.columns));
      items.push(...driftForeignKeys(dt.table, dt.columns, at.columns));
      items.push(...driftIndexes(dt.table, dt.indexes || [], at.indexes || [], dt.columns));
      items.push(...driftChecks(dt.table, dt.checks || [], at.checks || []));
      items.push(
        ...driftUniqueConstraints(dt.table, dt.unique_constraints || [], at.unique_constraints || [], dt.columns),
      );
      items.push(...driftTriggers(dt.table, dt.triggers || [], at.triggers || []));
      items.push(...driftRls(dt, at));
      items.push(...driftPolicies(dt.table, dt.policies || [], at.policies || []));
      items.push(...driftGrants(dt.table, dt.grants || [], at.grants || []));
      items.push(...driftSeeds(dt.table, dt.seeds, at.seeds));
      items.push(...driftTableComment(dt.table, dt.comment, at.comment));
    }
  }
  for (const [name] of actual) {
    if (!desired.find((t) => t.table === name)) {
      items.push({ type: 'table', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function driftRls(desired: TableSchema, actual: TableSchema): DriftItem[] {
  const items: DriftItem[] = [];
  const wantRls = !!desired.rls || !!(desired.policies && desired.policies.length > 0);
  const haveRls = !!actual.rls;
  if (wantRls !== haveRls) {
    items.push({
      type: 'table',
      object: desired.table,
      status: 'different',
      expected: wantRls ? 'rls enabled' : 'rls disabled',
      actual: haveRls ? 'rls enabled' : 'rls disabled',
      detail: `RLS: expected ${wantRls ? 'enabled' : 'disabled'}, actual ${haveRls ? 'enabled' : 'disabled'}`,
    });
  }
  const wantForce = !!desired.force_rls;
  const haveForce = !!actual.force_rls;
  if (wantForce !== haveForce) {
    items.push({
      type: 'table',
      object: desired.table,
      status: 'different',
      expected: wantForce ? 'force_rls enabled' : 'force_rls disabled',
      actual: haveForce ? 'force_rls enabled' : 'force_rls disabled',
      detail: `force_rls: expected ${wantForce ? 'enabled' : 'disabled'}, actual ${haveForce ? 'enabled' : 'disabled'}`,
    });
  }
  return items;
}

function driftCompositePk(table: string, desiredTable: TableSchema, actualTable: TableSchema): DriftItem[] {
  const desired = desiredTable.primary_key;
  const actual = actualTable.primary_key;
  const items: DriftItem[] = [];
  const dPk = (desired || []).join(',');
  const aPk = (actual || []).join(',');
  if (dPk !== aPk) {
    if (dPk && !aPk) {
      items.push({
        type: 'constraint',
        object: `${table}.primary_key`,
        status: 'missing_in_db',
        expected: `(${desired!.join(', ')})`,
        detail: `Composite PK expected: (${desired!.join(', ')})`,
      });
    } else if (!dPk && aPk) {
      items.push({
        type: 'constraint',
        object: `${table}.primary_key`,
        status: 'missing_in_yaml',
        actual: `(${actual!.join(', ')})`,
        detail: `Composite PK in DB: (${actual!.join(', ')})`,
      });
    } else {
      items.push({
        type: 'constraint',
        object: `${table}.primary_key`,
        status: 'different',
        expected: `(${desired!.join(', ')})`,
        actual: `(${actual!.join(', ')})`,
        detail: `Composite PK differs: expected (${desired!.join(', ')}), actual (${actual!.join(', ')})`,
      });
    }
  }
  // PK constraint name drift
  const dName = desiredTable.primary_key_name;
  const aName = actualTable.primary_key_name;
  if (dName && dName !== aName) {
    items.push({
      type: 'constraint',
      object: `${table}.primary_key`,
      status: 'different',
      expected: dName,
      actual: aName ?? '(default)',
      detail: `PK constraint name differs: expected ${dName}, actual ${aName ?? '(default)'}`,
    });
  }
  return items;
}

function driftColumns(table: string, desired: ColumnDef[], actual: ColumnDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualMap = new Map(actual.map((c) => [c.name, c]));
  const desiredMap = new Map(desired.map((c) => [c.name, c]));

  for (const dc of desired) {
    const ac = actualMap.get(dc.name);
    if (!ac) {
      items.push({ type: 'column', object: `${table}.${dc.name}`, status: 'missing_in_db' });
    } else {
      // Type
      if (normalizeTypeName(dc.type) !== normalizeTypeName(ac.type)) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status: 'different',
          expected: dc.type,
          actual: ac.type,
          detail: `Type: expected ${dc.type}, actual ${ac.type}`,
        });
      }
      // Nullable
      const dNullable = dc.nullable !== false;
      const aNullable = ac.nullable !== false;
      if (dNullable !== aNullable) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status: 'different',
          expected: dNullable ? 'nullable' : 'not null',
          actual: aNullable ? 'nullable' : 'not null',
          detail: `nullable: expected ${dNullable ? 'true' : 'false'}, actual ${aNullable ? 'true' : 'false'}`,
        });
      }
      // Default
      const dDefault = dc.default !== undefined ? String(dc.default) : undefined;
      const aDefault = ac.default !== undefined ? String(ac.default) : undefined;
      const serialType = /^(small)?serial|bigserial$/i.test(dc.type);
      const impliedNextval = serialType && !dDefault && aDefault && /^nextval\(/.test(aDefault);
      if (dDefault !== aDefault && !impliedNextval) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status: 'different',
          expected: dDefault ?? '(none)',
          actual: aDefault ?? '(none)',
          detail: `default: expected ${dDefault ?? '(none)'}, actual ${aDefault ?? '(none)'}`,
        });
      }
      // Unique constraint name
      if (dc.unique_name && dc.unique_name !== ac.unique_name) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          expected: dc.unique_name,
          actual: ac.unique_name ?? '(default)',
          detail: `unique_name differs: expected ${dc.unique_name}, actual ${ac.unique_name ?? '(default)'}`,
        });
      }
      // Unique
      const dUnique = !!dc.unique;
      const aUnique = !!ac.unique;
      if (dUnique !== aUnique) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: dUnique ? 'missing_in_db' : 'missing_in_yaml',
          expected: dUnique ? 'unique' : 'not unique',
          actual: aUnique ? 'unique' : 'not unique',
          detail: `unique: expected ${dUnique}, actual ${aUnique}`,
        });
      }
      // Generated column expression
      const dGenerated = dc.generated ?? undefined;
      const aGenerated = ac.generated ?? undefined;
      if ((dGenerated || '') !== (aGenerated || '')) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status:
            dGenerated && !aGenerated ? 'missing_in_db' : !dGenerated && aGenerated ? 'missing_in_yaml' : 'different',
          expected: dGenerated ?? '(none)',
          actual: aGenerated ?? '(none)',
          detail: `generated: expected ${dGenerated ?? '(none)'}, actual ${aGenerated ?? '(none)'}`,
        });
      }
    }
  }

  for (const ac of actual) {
    if (!desiredMap.has(ac.name)) {
      items.push({ type: 'column', object: `${table}.${ac.name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function driftIndexes(table: string, desired: IndexDef[], actual: IndexDef[], columns: ColumnDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualByName = new Map<string, IndexDef>();
  for (const idx of actual) {
    if (idx.name) actualByName.set(idx.name, idx);
  }

  // Build set of constraint names managed at the column level (unique: true).
  // Constraint-backed indexes are filtered out by introspection, so an explicit
  // index entry whose name matches a column-level unique constraint is satisfied
  // by that constraint and should not be reported as missing.
  const columnLevelUniqueNames = new Set<string>();
  for (const col of columns) {
    if (col.unique) {
      columnLevelUniqueNames.add(col.unique_name || `${table}_${col.name}_key`);
    }
  }

  for (const idx of desired) {
    const name = idx.name || `idx_${table}_${idx.columns.join('_')}`;
    if (columnLevelUniqueNames.has(name)) continue;
    const ai = actualByName.get(name);
    if (!ai) {
      items.push({ type: 'index', object: name, status: 'missing_in_db' });
    } else {
      const diffs: string[] = [];
      if (idx.columns.join(',') !== ai.columns.join(',')) diffs.push('columns');
      if (Boolean(idx.unique) !== Boolean(ai.unique)) diffs.push('unique');
      if ((idx.method || 'btree') !== (ai.method || 'btree')) diffs.push('method');
      if ((idx.where || '') !== (ai.where || '')) diffs.push('where');
      if (diffs.length > 0) {
        items.push({
          type: 'index',
          object: name,
          status: 'different',
          detail: `Index differs: ${diffs.join(', ')}`,
        });
      }
    }
  }

  const desiredNames = new Set(desired.map((idx) => idx.name || `idx_${table}_${idx.columns.join('_')}`));
  for (const idx of actual) {
    if (idx.name && !desiredNames.has(idx.name)) {
      items.push({ type: 'index', object: idx.name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function driftChecks(table: string, desired: CheckDef[], actual: CheckDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualByName = new Map(actual.map((c) => [c.name, c]));

  for (const chk of desired) {
    const act = actualByName.get(chk.name);
    if (!act) {
      items.push({ type: 'constraint', object: `${table}.${chk.name}`, status: 'missing_in_db' });
    } else if (normalizeCheckExpression(chk.expression) !== normalizeCheckExpression(act.expression)) {
      items.push({
        type: 'constraint',
        object: `${table}.${chk.name}`,
        status: 'different',
        expected: chk.expression,
        actual: act.expression,
        detail: `check expression: expected "${chk.expression}", actual "${act.expression}"`,
      });
    }
  }

  const desiredNames = new Set(desired.map((c) => c.name));
  for (const chk of actual) {
    if (!desiredNames.has(chk.name)) {
      items.push({ type: 'constraint', object: `${table}.${chk.name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function driftTriggers(table: string, desired: TriggerDef[], actual: TriggerDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualByName = new Map(actual.map((t) => [t.name, t]));

  for (const trg of desired) {
    const act = actualByName.get(trg.name);
    if (!act) {
      items.push({ type: 'trigger', object: `${table}.${trg.name}`, status: 'missing_in_db' });
    } else if (triggersDiffer(trg, act)) {
      items.push({ type: 'trigger', object: `${table}.${trg.name}`, status: 'different' });
    }
  }

  const desiredNames = new Set(desired.map((t) => t.name));
  for (const trg of actual) {
    if (!desiredNames.has(trg.name)) {
      items.push({ type: 'trigger', object: `${table}.${trg.name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function triggersDiffer(desired: TriggerDef, actual: TriggerDef): boolean {
  if (desired.timing !== actual.timing) return true;
  if ((desired.for_each || 'ROW') !== (actual.for_each || 'ROW')) return true;
  if ((desired.when || '') !== (actual.when || '')) return true;
  if (desired.function !== actual.function) return true;
  const dEvents = [...desired.events].sort().join(',');
  const aEvents = [...actual.events].sort().join(',');
  if (dEvents !== aEvents) return true;
  return false;
}

function driftPolicies(table: string, desired: PolicyDef[], actual: PolicyDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualByName = new Map(actual.map((p) => [p.name, p]));

  for (const pol of desired) {
    const act = actualByName.get(pol.name);
    if (!act) {
      items.push({ type: 'policy', object: `${table}.${pol.name}`, status: 'missing_in_db' });
    } else {
      // Compare attributes
      const details: string[] = [];
      const dPermissive = pol.permissive !== false;
      const aPermissive = act.permissive !== false;
      if (dPermissive !== aPermissive) {
        details.push(`permissive: expected ${dPermissive}, actual ${aPermissive}`);
      }
      if ((pol.for || 'ALL') !== (act.for || 'ALL')) {
        details.push(`for: expected ${pol.for || 'ALL'}, actual ${act.for || 'ALL'}`);
      }
      if (pol.to !== act.to) {
        details.push(`to: expected ${pol.to}, actual ${act.to}`);
      }
      if ((pol.using || '') !== (act.using || '')) {
        details.push(`using: expected ${pol.using || '(none)'}, actual ${act.using || '(none)'}`);
      }
      if ((pol.check || '') !== (act.check || '')) {
        details.push(`check: expected ${pol.check || '(none)'}, actual ${act.check || '(none)'}`);
      }
      if (details.length > 0) {
        items.push({
          type: 'policy',
          object: `${table}.${pol.name}`,
          status: 'different',
          detail: details.join('; '),
        });
      }
    }
  }

  const desiredNames = new Set(desired.map((p) => p.name));
  for (const pol of actual) {
    if (!desiredNames.has(pol.name)) {
      items.push({ type: 'policy', object: `${table}.${pol.name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

function driftTableComment(table: string, desired?: string, actual?: string): DriftItem[] {
  if (desired && desired !== actual) {
    return [
      {
        type: 'comment',
        object: table,
        status: 'different',
        expected: desired,
        actual: actual ?? '(none)',
        detail: `Table comment: expected "${desired}", actual "${actual ?? '(none)'}"`,
      },
    ];
  }
  return [];
}

// ─── Views ──────────────────────────────────────────────────────

function driftViews(desired: ViewSchema[], actual: Map<string, ViewSchema>): DriftItem[] {
  const items: DriftItem[] = [];

  for (const dv of desired) {
    const av = actual.get(dv.name);
    if (!av) {
      items.push({ type: 'view', object: dv.name, status: 'missing_in_db' });
    } else if (normalizeWhitespace(dv.query) !== normalizeWhitespace(av.query)) {
      items.push({
        type: 'view',
        object: dv.name,
        status: 'different',
        expected: dv.query,
        actual: av.query,
        detail: 'View query differs',
      });
    }
    // Compare grants on views
    if (av && dv.grants) {
      items.push(...driftGrants(dv.name, dv.grants, av.grants ?? []));
    }
  }
  for (const [name] of actual) {
    if (!desired.find((v) => v.name === name)) {
      items.push({ type: 'view', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Materialized Views ─────────────────────────────────────────

function driftMaterializedViews(
  desired: MaterializedViewSchema[],
  actual: Map<string, MaterializedViewSchema>,
): DriftItem[] {
  const items: DriftItem[] = [];

  for (const dv of desired) {
    const av = actual.get(dv.name);
    if (!av) {
      items.push({ type: 'materialized_view', object: dv.name, status: 'missing_in_db' });
    } else if (normalizeWhitespace(dv.query) !== normalizeWhitespace(av.query)) {
      items.push({
        type: 'materialized_view',
        object: dv.name,
        status: 'different',
        expected: dv.query,
        actual: av.query,
        detail: 'Materialized view query differs',
      });
    }
  }
  for (const [name] of actual) {
    if (!desired.find((v) => v.name === name)) {
      items.push({ type: 'materialized_view', object: name, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Foreign Keys ───────────────────────────────────────────────

function driftForeignKeys(table: string, desired: ColumnDef[], actual: ColumnDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualMap = new Map(actual.map((c) => [c.name, c]));

  for (const dc of desired) {
    const ac = actualMap.get(dc.name);
    if (!ac) continue; // column-level drift already reported
    const dRef = dc.references;
    const aRef = ac.references;
    if (dRef && !aRef) {
      items.push({
        type: 'constraint',
        object: `${table}.${dc.name}`,
        status: 'different',
        detail: `FK expected on ${dc.name} -> ${dRef.table}.${dRef.column}, not present in DB`,
      });
    } else if (!dRef && aRef) {
      items.push({
        type: 'constraint',
        object: `${table}.${dc.name}`,
        status: 'different',
        detail: `FK on ${dc.name} -> ${aRef.table}.${aRef.column} exists in DB but not in YAML`,
      });
    } else if (dRef && aRef) {
      if (dRef.table !== aRef.table || dRef.column !== aRef.column) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK target differs: expected ${dRef.table}.${dRef.column}, actual ${aRef.table}.${aRef.column}`,
        });
      }
      // Compare FK schema references
      const dSchema = dRef.schema || '';
      const aSchema = aRef.schema || '';
      if (dSchema !== aSchema) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK schema differs: expected ${dSchema || '(default)'}, actual ${aSchema || '(default)'}`,
        });
      }
      // Compare FK options
      const dOnDelete = dRef.on_delete || 'NO ACTION';
      const aOnDelete = aRef.on_delete || 'NO ACTION';
      if (dOnDelete !== aOnDelete) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK on_delete differs: expected ${dOnDelete}, actual ${aOnDelete}`,
        });
      }
      const dOnUpdate = dRef.on_update || 'NO ACTION';
      const aOnUpdate = aRef.on_update || 'NO ACTION';
      if (dOnUpdate !== aOnUpdate) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK on_update differs: expected ${dOnUpdate}, actual ${aOnUpdate}`,
        });
      }
      const dDeferrable = dRef.deferrable || false;
      const aDeferrable = aRef.deferrable || false;
      if (dDeferrable !== aDeferrable) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK deferrable differs: expected ${dDeferrable}, actual ${aDeferrable}`,
        });
      }
      if (dDeferrable && aDeferrable) {
        const dDeferred = dRef.initially_deferred || false;
        const aDeferred = aRef.initially_deferred || false;
        if (dDeferred !== aDeferred) {
          items.push({
            type: 'constraint',
            object: `${table}.${dc.name}`,
            status: 'different',
            detail: `FK initially_deferred differs: expected ${dDeferred}, actual ${aDeferred}`,
          });
        }
      }
      // FK constraint name drift
      if (dRef.name && dRef.name !== aRef.name) {
        items.push({
          type: 'constraint',
          object: `${table}.${dc.name}`,
          status: 'different',
          detail: `FK name differs: expected ${dRef.name}, actual ${aRef.name ?? '(default)'}`,
        });
      }
    }
  }
  return items;
}

// ─── Unique Constraints ─────────────────────────────────────────

function driftUniqueConstraints(
  table: string,
  desired: UniqueConstraintDef[],
  actual: UniqueConstraintDef[],
  desiredColumns: ColumnDef[],
): DriftItem[] {
  const items: DriftItem[] = [];
  const getName = (uc: UniqueConstraintDef) => uc.name || `${table}_${uc.columns.join('_')}_key`;
  const actualByName = new Map(actual.map((uc) => [getName(uc), uc]));

  // Build set of constraint names managed at the column level (unique: true).
  // These are NOT in the unique_constraints array but exist in the DB as real constraints.
  const columnLevelUniqueNames = new Set<string>();
  for (const col of desiredColumns) {
    if (col.unique) {
      columnLevelUniqueNames.add(col.unique_name || `${table}_${col.name}_key`);
    }
  }

  for (const uc of desired) {
    const name = getName(uc);
    if (!actualByName.has(name)) {
      items.push({ type: 'constraint', object: `${table}.${name}`, status: 'missing_in_db' });
    }
  }

  const desiredNames = new Set(desired.map(getName));
  for (const uc of actual) {
    const name = getName(uc);
    if (!desiredNames.has(name) && !columnLevelUniqueNames.has(name)) {
      items.push({ type: 'constraint', object: `${table}.${name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Grants ─────────────────────────────────────────────────────

function driftGrants(table: string, desired: GrantDef[], actual: GrantDef[]): DriftItem[] {
  // Normalize both sides first. A single YAML grant block that mixes
  // column-qualified privileges (SELECT/INSERT/UPDATE/REFERENCES) with
  // table-only privileges (DELETE/TRUNCATE/TRIGGER) gets stored in two
  // different Postgres tables (column_privileges + table_privileges); on
  // read-back we see two grants and mismatched keys unless we split the
  // YAML side the same way.
  const nDesired = normalizeGrants(desired);
  const nActual = normalizeGrants(actual);

  const items: DriftItem[] = [];
  const grantKey = (g: GrantDef) => {
    const colsPart = g.columns && g.columns.length > 0 ? `:cols=${[...g.columns].sort().join(',')}` : '';
    return `${g.to}:${[...g.privileges].sort().join(',')}${colsPart}`;
  };
  const actualMap = new Map<string, GrantDef>();
  for (const g of nActual) actualMap.set(grantKey(g), g);
  const desiredMap = new Map<string, GrantDef>();
  for (const g of nDesired) desiredMap.set(grantKey(g), g);

  for (const g of nDesired) {
    const key = grantKey(g);
    const match = actualMap.get(key);
    if (!match) {
      items.push({
        type: 'grant',
        object: `${table}:${g.to}`,
        status: 'missing_in_db',
      });
    } else if (!!g.with_grant_option !== !!match.with_grant_option) {
      items.push({
        type: 'grant',
        object: `${table}:${g.to}`,
        status: 'different',
      });
    }
  }
  for (const g of nActual) {
    if (!desiredMap.has(grantKey(g))) {
      // If the actual grant has columns, check if a table-level desired grant
      // (no columns) covers it — PostgreSQL populates column_privileges for
      // table-level grants, so the introspected column-level grant is redundant.
      // We use a subset check because table-level-only privileges (e.g. DELETE,
      // TRUNCATE) never appear in column_privileges, so the introspected
      // column-level grant may list fewer privileges than the desired grant.
      if (g.columns && g.columns.length > 0) {
        const actualPrivs = g.privileges;
        const coveredByTableLevel = nDesired.some(
          (d) => !d.columns?.length && d.to === g.to && actualPrivs.every((p) => d.privileges.includes(p)),
        );
        if (coveredByTableLevel) continue;
      }
      items.push({
        type: 'grant',
        object: `${table}:${g.to}`,
        status: 'missing_in_yaml',
      });
    }
  }
  return items;
}

// ─── Seeds ──────────────────────────────────────────────────────

function normalizeSeedValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

function normalizeSeedRow(row: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(row)) {
    result[key] = normalizeSeedValue(val);
  }
  return result;
}

function driftSeeds(
  table: string,
  desired?: Record<string, unknown>[],
  actual?: Record<string, unknown>[],
): DriftItem[] {
  const dLen = desired?.length ?? 0;
  const aLen = actual?.length ?? 0;
  if (dLen === 0 && aLen === 0) return [];
  const normalizedDesired = (desired || []).map(normalizeSeedRow);
  const normalizedActual = (actual || []).map(normalizeSeedRow);
  const dJson = JSON.stringify(normalizedDesired);
  const aJson = JSON.stringify(normalizedActual);
  if (dJson !== aJson) {
    return [
      {
        type: 'seed',
        object: table,
        status: 'different',
        expected: `${dLen} seed rows`,
        actual: `${aLen} seed rows`,
        detail: `Seed data differs for ${table}`,
      },
    ];
  }
  return [];
}

// ─── Helpers ────────────────────────────────────────────────────

function normalizeTypeName(t: string): string {
  const lower = t.toLowerCase().trim();
  const aliases: Record<string, string> = {
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    serial: 'integer',
    bigserial: 'bigint',
  };
  return aliases[lower] || lower;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeCheckExpression(s: string): string {
  return s.replace(/::character varying::text/g, '::character varying').replace(/\]::text\[\]/g, ']');
}
