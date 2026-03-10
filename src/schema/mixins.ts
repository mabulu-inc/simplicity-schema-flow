import type { MixinSchema, TableSchema, ColumnDef, IndexDef, CheckDef, TriggerDef, PolicyDef } from './types.js';

export type MixinRegistry = Map<string, MixinSchema>;

/**
 * Build a mixin registry (name → MixinSchema) from an array of parsed mixins.
 */
export function loadMixins(mixins: MixinSchema[]): MixinRegistry {
  const registry: MixinRegistry = new Map();
  for (const m of mixins) {
    if (registry.has(m.mixin)) {
      throw new Error(`Duplicate mixin name: "${m.mixin}"`);
    }
    registry.set(m.mixin, m);
  }
  return registry;
}

/**
 * Apply all referenced mixins to a table schema, returning a new TableSchema.
 * Does not mutate the input table or the mixin definitions.
 */
export function applyMixins(table: TableSchema, registry: MixinRegistry): TableSchema {
  if (!table.mixins || table.mixins.length === 0) {
    return table;
  }

  const tableName = table.table;
  const existingColumnNames = new Set(table.columns.map((c) => c.name));

  const columns = [...table.columns];
  const indexes = table.indexes ? [...table.indexes] : [];
  const checks = table.checks ? [...table.checks] : [];
  const triggers = table.triggers ? [...table.triggers] : [];
  const policies = table.policies ? [...table.policies] : [];
  const grants = table.grants ? [...table.grants] : [];

  let hasIndexes = !!table.indexes;
  let hasChecks = !!table.checks;
  let hasTriggers = !!table.triggers;
  let hasPolicies = !!table.policies;
  let hasGrants = !!table.grants;
  let rls = !!table.rls;
  let forceRls = !!table.force_rls;

  for (const mixinName of table.mixins) {
    const mixin = registry.get(mixinName);
    if (!mixin) {
      throw new Error(`Mixin "${mixinName}" not found in registry`);
    }

    // Merge columns (skip duplicates already on the table)
    if (mixin.columns) {
      for (const col of mixin.columns) {
        if (!existingColumnNames.has(col.name)) {
          columns.push(substituteColumn(col, tableName));
          existingColumnNames.add(col.name);
        }
      }
    }

    if (mixin.indexes) {
      hasIndexes = true;
      indexes.push(...mixin.indexes.map((idx) => substituteIndex(idx, tableName)));
    }

    if (mixin.checks) {
      hasChecks = true;
      checks.push(...mixin.checks.map((chk) => substituteCheck(chk, tableName)));
    }

    if (mixin.triggers) {
      hasTriggers = true;
      triggers.push(...mixin.triggers.map((trig) => substituteTrigger(trig, tableName)));
    }

    if (mixin.policies) {
      hasPolicies = true;
      policies.push(...mixin.policies.map((pol) => substitutePolicy(pol, tableName)));
    }

    if (mixin.grants) {
      hasGrants = true;
      grants.push(...mixin.grants.map((g) => ({ ...g })));
    }

    if (mixin.rls === true) rls = true;
    if (mixin.force_rls === true) forceRls = true;
  }

  const result: TableSchema = {
    ...table,
    columns,
  };

  if (hasIndexes) result.indexes = indexes;
  if (hasChecks) result.checks = checks;
  if (hasTriggers) result.triggers = triggers;
  if (hasPolicies) result.policies = policies;
  if (hasGrants) result.grants = grants;
  if (rls) result.rls = true;
  if (forceRls) result.force_rls = true;

  return result;
}

// ─── {table} placeholder substitution ──────────────────────────

function sub(str: string, tableName: string): string {
  return str.replace(/\{table\}/g, tableName);
}

function substituteColumn(col: ColumnDef, tableName: string): ColumnDef {
  return {
    ...col,
    name: sub(col.name, tableName),
    ...(col.default !== undefined && { default: sub(col.default, tableName) }),
    ...(col.comment !== undefined && { comment: sub(col.comment, tableName) }),
  };
}

function substituteIndex(idx: IndexDef, tableName: string): IndexDef {
  return {
    ...idx,
    ...(idx.name !== undefined && { name: sub(idx.name, tableName) }),
    ...(idx.where !== undefined && { where: sub(idx.where, tableName) }),
  };
}

function substituteCheck(chk: CheckDef, tableName: string): CheckDef {
  return {
    ...chk,
    name: sub(chk.name, tableName),
    expression: sub(chk.expression, tableName),
  };
}

function substituteTrigger(trig: TriggerDef, tableName: string): TriggerDef {
  return {
    ...trig,
    name: sub(trig.name, tableName),
    function: sub(trig.function, tableName),
    ...(trig.when !== undefined && { when: sub(trig.when, tableName) }),
  };
}

function substitutePolicy(pol: PolicyDef, tableName: string): PolicyDef {
  return {
    ...pol,
    name: sub(pol.name, tableName),
    ...(pol.using !== undefined && { using: sub(pol.using, tableName) }),
    ...(pol.check !== undefined && { check: sub(pol.check, tableName) }),
  };
}
