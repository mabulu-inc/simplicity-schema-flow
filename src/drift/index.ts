/**
 * Drift detection for simplicity-schema.
 *
 * Performs a read-only comparison of YAML definitions against the live
 * database state, producing a structured DriftReport.
 */

import type { DesiredState, ActualState } from '../planner/index.js';
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

function driftExtensions(
  desired: DesiredState['extensions'],
  actual: string[],
): DriftItem[] {
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

function driftEnums(
  desired: EnumSchema[],
  actual: Map<string, EnumSchema>,
): DriftItem[] {
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

function driftRoles(
  desired: RoleSchema[],
  actual: Map<string, RoleSchema>,
): DriftItem[] {
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
      if (dr.connection_limit !== undefined && dr.connection_limit !== ar.connection_limit) diffs.push('connection_limit');
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

function driftFunctions(
  desired: FunctionSchema[],
  actual: Map<string, FunctionSchema>,
): DriftItem[] {
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

function driftTables(
  desired: TableSchema[],
  actual: Map<string, TableSchema>,
): DriftItem[] {
  const items: DriftItem[] = [];

  for (const dt of desired) {
    const at = actual.get(dt.table);
    if (!at) {
      items.push({ type: 'table', object: dt.table, status: 'missing_in_db' });
    } else {
      items.push(...driftCompositePk(dt.table, dt.primary_key, at.primary_key));
      items.push(...driftColumns(dt.table, dt.columns, at.columns));
      items.push(...driftForeignKeys(dt.table, dt.columns, at.columns));
      items.push(...driftIndexes(dt.table, dt.indexes || [], at.indexes || []));
      items.push(...driftChecks(dt.table, dt.checks || [], at.checks || []));
      items.push(...driftUniqueConstraints(dt.table, dt.unique_constraints || [], at.unique_constraints || []));
      items.push(...driftTriggers(dt.table, dt.triggers || [], at.triggers || []));
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

function driftCompositePk(table: string, desired?: string[], actual?: string[]): DriftItem[] {
  const dPk = (desired || []).join(',');
  const aPk = (actual || []).join(',');
  if (dPk === aPk) return [];
  if (dPk && !aPk) {
    return [{
      type: 'constraint',
      object: `${table}.primary_key`,
      status: 'missing_in_db',
      expected: `(${desired!.join(', ')})`,
      detail: `Composite PK expected: (${desired!.join(', ')})`,
    }];
  }
  if (!dPk && aPk) {
    return [{
      type: 'constraint',
      object: `${table}.primary_key`,
      status: 'missing_in_yaml',
      actual: `(${actual!.join(', ')})`,
      detail: `Composite PK in DB: (${actual!.join(', ')})`,
    }];
  }
  return [{
    type: 'constraint',
    object: `${table}.primary_key`,
    status: 'different',
    expected: `(${desired!.join(', ')})`,
    actual: `(${actual!.join(', ')})`,
    detail: `Composite PK differs: expected (${desired!.join(', ')}), actual (${actual!.join(', ')})`,
  }];
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
      if (dDefault !== aDefault) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status: 'different',
          expected: dDefault ?? '(none)',
          actual: aDefault ?? '(none)',
          detail: `default: expected ${dDefault ?? '(none)'}, actual ${aDefault ?? '(none)'}`,
        });
      }
      // Generated column expression
      const dGenerated = dc.generated ?? undefined;
      const aGenerated = ac.generated ?? undefined;
      if ((dGenerated || '') !== (aGenerated || '')) {
        items.push({
          type: 'column',
          object: `${table}.${dc.name}`,
          status: dGenerated && !aGenerated ? 'missing_in_db'
            : !dGenerated && aGenerated ? 'missing_in_yaml'
            : 'different',
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

function driftIndexes(table: string, desired: IndexDef[], actual: IndexDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const actualByName = new Map<string, IndexDef>();
  for (const idx of actual) {
    if (idx.name) actualByName.set(idx.name, idx);
  }

  for (const idx of desired) {
    const name = idx.name || `idx_${table}_${idx.columns.join('_')}`;
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

  const desiredNames = new Set(
    desired.map((idx) => idx.name || `idx_${table}_${idx.columns.join('_')}`),
  );
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
    if (!actualByName.has(chk.name)) {
      items.push({ type: 'constraint', object: `${table}.${chk.name}`, status: 'missing_in_db' });
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
    if (!actualByName.has(pol.name)) {
      items.push({ type: 'policy', object: `${table}.${pol.name}`, status: 'missing_in_db' });
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
    return [{
      type: 'comment',
      object: table,
      status: 'different',
      expected: desired,
      actual: actual ?? '(none)',
      detail: `Table comment: expected "${desired}", actual "${actual ?? '(none)'}"`,
    }];
  }
  return [];
}

// ─── Views ──────────────────────────────────────────────────────

function driftViews(
  desired: ViewSchema[],
  actual: Map<string, ViewSchema>,
): DriftItem[] {
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
    }
  }
  return items;
}

// ─── Unique Constraints ─────────────────────────────────────────

function driftUniqueConstraints(
  table: string,
  desired: UniqueConstraintDef[],
  actual: UniqueConstraintDef[],
): DriftItem[] {
  const items: DriftItem[] = [];
  const getName = (uc: UniqueConstraintDef) =>
    uc.name || `${table}_${uc.columns.join('_')}_key`;
  const actualByName = new Map(actual.map((uc) => [getName(uc), uc]));

  for (const uc of desired) {
    const name = getName(uc);
    if (!actualByName.has(name)) {
      items.push({ type: 'constraint', object: `${table}.${name}`, status: 'missing_in_db' });
    }
  }

  const desiredNames = new Set(desired.map(getName));
  for (const uc of actual) {
    const name = getName(uc);
    if (!desiredNames.has(name)) {
      items.push({ type: 'constraint', object: `${table}.${name}`, status: 'missing_in_yaml' });
    }
  }
  return items;
}

// ─── Grants ─────────────────────────────────────────────────────

function driftGrants(table: string, desired: GrantDef[], actual: GrantDef[]): DriftItem[] {
  const items: DriftItem[] = [];
  const grantKey = (g: GrantDef) => {
    const colsPart = g.columns && g.columns.length > 0 ? `:cols=${[...g.columns].sort().join(',')}` : '';
    return `${g.to}:${[...g.privileges].sort().join(',')}${colsPart}`;
  };
  const actualKeys = new Set(actual.map(grantKey));
  const desiredKeys = new Set(desired.map(grantKey));

  for (const g of desired) {
    if (!actualKeys.has(grantKey(g))) {
      items.push({
        type: 'grant',
        object: `${table}:${g.to}`,
        status: 'missing_in_db',
      });
    }
  }
  for (const g of actual) {
    if (!desiredKeys.has(grantKey(g))) {
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

function driftSeeds(
  table: string,
  desired?: Record<string, unknown>[],
  actual?: Record<string, unknown>[],
): DriftItem[] {
  const dLen = desired?.length ?? 0;
  const aLen = actual?.length ?? 0;
  if (dLen === 0 && aLen === 0) return [];
  const dJson = JSON.stringify(desired || []);
  const aJson = JSON.stringify(actual || []);
  if (dJson !== aJson) {
    return [{
      type: 'seed',
      object: table,
      status: 'different',
      expected: `${dLen} seed rows`,
      actual: `${aLen} seed rows`,
      detail: `Seed data differs for ${table}`,
    }];
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
