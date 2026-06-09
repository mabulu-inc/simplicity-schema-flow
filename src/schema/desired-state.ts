/**
 * Build a merged DesiredState from schema files spanning multiple sources
 * (imported packages + the local schema).
 *
 * Responsibilities:
 *  - parse every schema file
 *  - reject duplicate table declarations across sources (naming both sources)
 *  - merge `extend:` fragments into their target tables
 *  - apply mixins (resolving the registry across all sources)
 */

import { readFile } from 'node:fs/promises';
import type { SchemaFile } from '../core/files.js';
import { parseSchemaFile } from './parser.js';
import { loadMixins, applyMixins } from './mixins.js';
import { interpolateMixin, interpolateFunctionBody } from './params.js';
import type { DesiredState } from '../planner/index.js';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ExtensionsSchema,
  MixinSchema,
  MixinParam,
  ExtendSchema,
} from './types.js';

/** A source key — the package name, or `''` for the local schema. */
function sourceKey(file: SchemaFile): string {
  return file.source ?? '';
}

export interface BuildDesiredStateOptions {
  /**
   * Per-package param overrides, keyed by package name (the `source`), as
   * supplied by `imports[].params`. Overrides the defaults declared on that
   * package's mixins.
   */
  importParams?: Map<string, Record<string, string>>;
}

/** A file label for error messages — package-qualified when imported. */
function label(file: SchemaFile): string {
  return file.relativePath;
}

interface SourcedTable {
  table: TableSchema;
  file: SchemaFile;
}

/**
 * Merge an `extend:` fragment into a target table, mutating a working copy.
 * Re-declaring an existing column is an error.
 */
function mergeExtend(target: TableSchema, ext: ExtendSchema, extLabel: string, targetLabel: string): void {
  if (ext.columns) {
    const existing = new Set(target.columns.map((c) => c.name));
    for (const col of ext.columns) {
      if (existing.has(col.name)) {
        throw new Error(
          `extend (${extLabel}) re-declares column "${col.name}" already defined on table "${ext.extend}" ` +
            `(${targetLabel}). Column type changes go through a pre-script, not extend.`,
        );
      }
      target.columns.push(col);
      existing.add(col.name);
    }
  }
  if (ext.indexes) target.indexes = [...(target.indexes ?? []), ...ext.indexes];
  if (ext.checks) target.checks = [...(target.checks ?? []), ...ext.checks];
  if (ext.triggers) target.triggers = [...(target.triggers ?? []), ...ext.triggers];
  if (ext.policies) target.policies = [...(target.policies ?? []), ...ext.policies];
  if (ext.grants) target.grants = [...(target.grants ?? []), ...ext.grants];
  if (ext.mixins) target.mixins = [...(target.mixins ?? []), ...ext.mixins];
  if (ext.seeds) target.seeds = [...(target.seeds ?? []), ...ext.seeds];
  if (ext.seeds_on_conflict !== undefined) target.seeds_on_conflict = ext.seeds_on_conflict;
  if (ext.rls === true) target.rls = true;
  if (ext.force_rls === true) target.force_rls = true;
}

/**
 * Resolve the effective param values for each source. A source's declared
 * params are the union of `params:` across its mixins; values come from the
 * declared `default`, overridden by `imports[].params`. Throws if an override
 * names a param the package never declares.
 */
function resolveParamsBySource(
  sourcedMixins: { mixin: MixinSchema; key: string }[],
  importParams: Map<string, Record<string, string>>,
): Map<string, Record<string, string>> {
  const declaredBySource = new Map<string, Map<string, MixinParam>>();
  for (const { mixin, key } of sourcedMixins) {
    if (!mixin.params) continue;
    const declared = declaredBySource.get(key) ?? new Map<string, MixinParam>();
    for (const [name, spec] of Object.entries(mixin.params)) {
      declared.set(name, spec);
    }
    declaredBySource.set(key, declared);
  }

  const resolved = new Map<string, Record<string, string>>();
  const sources = new Set<string>([...declaredBySource.keys(), ...importParams.keys()]);
  for (const key of sources) {
    const declared = declaredBySource.get(key) ?? new Map<string, MixinParam>();
    const overrides = importParams.get(key) ?? {};

    for (const name of Object.keys(overrides)) {
      if (!declared.has(name)) {
        const pkg = key === '' ? 'the local schema' : `"${key}"`;
        throw new Error(
          `Import param "${name}" for ${pkg} is not declared by any of its mixins. ` +
            `Declared params: ${[...declared.keys()].map((p) => `"${p}"`).join(', ') || '(none)'}.`,
        );
      }
    }

    const values: Record<string, string> = {};
    for (const [name, spec] of declared) {
      if (name in overrides) values[name] = overrides[name];
      else if (spec.default !== undefined) values[name] = spec.default;
    }
    resolved.set(key, values);
  }
  return resolved;
}

/**
 * Parse all schema files (across sources) and build the merged DesiredState.
 */
export async function buildDesiredState(
  schemaFiles: SchemaFile[],
  options: BuildDesiredStateOptions = {},
): Promise<DesiredState> {
  const sourcedTables: SourcedTable[] = [];
  const extends_: { ext: ExtendSchema; file: SchemaFile }[] = [];
  const enums: EnumSchema[] = [];
  const sourcedFunctions: { fn: FunctionSchema; key: string }[] = [];
  const views: ViewSchema[] = [];
  const materializedViews: MaterializedViewSchema[] = [];
  const roles: RoleSchema[] = [];
  const sourcedMixins: { mixin: MixinSchema; key: string }[] = [];
  let extensions: ExtensionsSchema | null = null;

  for (const file of schemaFiles) {
    const content = await readFile(file.absolutePath, 'utf-8');
    let parsed;
    try {
      parsed = parseSchemaFile(content);
    } catch (err) {
      throw new Error(`Failed to parse ${label(file)}: ${(err as Error).message}`, { cause: err });
    }
    switch (parsed.kind) {
      case 'table':
        sourcedTables.push({ table: parsed.schema, file });
        break;
      case 'extend':
        extends_.push({ ext: parsed.schema, file });
        break;
      case 'enum':
        enums.push(parsed.schema);
        break;
      case 'function':
        sourcedFunctions.push({ fn: parsed.schema, key: sourceKey(file) });
        break;
      case 'view':
        views.push(parsed.schema);
        break;
      case 'materialized_view':
        materializedViews.push(parsed.schema);
        break;
      case 'role':
        roles.push(parsed.schema);
        break;
      case 'extensions':
        extensions = parsed.schema;
        break;
      case 'mixin':
        sourcedMixins.push({ mixin: parsed.schema, key: sourceKey(file) });
        break;
    }
  }

  // Resolve mixin params per source (defaults + import overrides), then
  // interpolate `{{param}}` placeholders into mixins and function bodies.
  const resolvedParams = resolveParamsBySource(sourcedMixins, options.importParams ?? new Map());
  const mixinSchemas = sourcedMixins.map(({ mixin, key }) => interpolateMixin(mixin, resolvedParams.get(key) ?? {}));
  const functions = sourcedFunctions.map(({ fn, key }) => interpolateFunctionBody(fn, resolvedParams.get(key) ?? {}));

  // Build the table map, rejecting duplicate declarations across sources.
  const byName = new Map<string, SourcedTable>();
  for (const st of sourcedTables) {
    const prior = byName.get(st.table.table);
    if (prior) {
      throw new Error(
        `Table "${st.table.table}" is declared in two sources: ${label(prior.file)} and ${label(st.file)}. ` +
          `To add columns to an imported table, use an "extend:" file instead of re-declaring it.`,
      );
    }
    // Work on a shallow clone so extend merges don't mutate parsed objects.
    byName.set(st.table.table, { table: { ...st.table, columns: [...st.table.columns] }, file: st.file });
  }

  // Apply extends in source order.
  for (const { ext, file } of extends_) {
    const target = byName.get(ext.extend);
    if (!target) {
      throw new Error(
        `extend (${label(file)}) targets unknown table "${ext.extend}". ` +
          `Define the table locally or import a package that provides it.`,
      );
    }
    mergeExtend(target.table, ext, label(file), label(target.file));
  }

  const tables = [...byName.values()].map((st) => st.table);

  // Apply mixins.
  if (mixinSchemas.length > 0) {
    const registry = loadMixins(mixinSchemas);
    for (let i = 0; i < tables.length; i++) {
      tables[i] = applyMixins(tables[i], registry);
    }
  }

  return { tables, enums, functions, views, materializedViews, roles, extensions };
}
