/**
 * Multi-source schema discovery.
 *
 * schema-flow loads schema not only from the local `baseDir` but also from
 * packages listed in `imports:`. Each import contributes its `schema/`
 * directory as an additional source, merged with the local schema. Imported
 * sources load first (in listed order), then the local schema — so a local
 * `extend:` can augment an imported table and local objects can reference
 * imported ones.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SimplicitySchemaConfig } from './config.js';
import { discoverSchemaFiles } from './files.js';
import type { DiscoveredFiles, SchemaFile } from './files.js';

/**
 * Resolve a package's `schema/` directory by walking up from `fromDir` looking
 * for `node_modules/<pkg>/schema`. This resolves from the consumer project's
 * `node_modules` (baseDir lives inside the consumer project), so under
 * `pnpm dlx` the imported schema comes from the consumer's installed
 * dependency — version-pinned — not the dlx sandbox where schema-flow itself
 * was fetched. Throws a clear error if the package or its `schema/` dir is
 * missing.
 */
export function resolveImportDir(pkg: string, fromDir: string): string {
  let dir = path.resolve(fromDir);

  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', ...pkg.split('/'));
    const schemaDir = path.join(pkgDir, 'schema');

    if (existsSync(pkgDir) && statSync(pkgDir).isDirectory()) {
      if (existsSync(schemaDir) && statSync(schemaDir).isDirectory()) {
        return schemaDir;
      }
      throw new Error(
        `Imported package "${pkg}" was found at ${pkgDir} but has no "schema/" directory — ` +
          `it does not ship a schema-flow schema.`,
      );
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Imported package "${pkg}" could not be resolved from any node_modules above ${path.resolve(fromDir)}. ` +
      `Install it as a dependency of this project.`,
  );
}

export interface ResolvedSource {
  /** Package name, or undefined for the local schema. */
  source?: string;
  /** Absolute path to this source's schema directory. */
  dir: string;
}

/**
 * Resolve the ordered list of schema sources: imported packages first (in the
 * order listed in `imports:`), then the local `baseDir`.
 */
export function resolveSources(config: SimplicitySchemaConfig): ResolvedSource[] {
  const baseDir = path.resolve(config.baseDir);
  const sources: ResolvedSource[] = [];
  for (const spec of config.imports ?? []) {
    sources.push({ source: spec.package, dir: resolveImportDir(spec.package, baseDir) });
  }
  sources.push({ dir: baseDir });
  return sources;
}

/**
 * Build the per-package param-override map from `imports[].params`, keyed by
 * package name. Consumed by the desired-state builder to interpolate
 * parameterized mixins and function bodies.
 */
export function resolveImportParams(config: SimplicitySchemaConfig): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const spec of config.imports ?? []) {
    if (spec.params) map.set(spec.package, spec.params);
  }
  return map;
}

/**
 * Discover schema files across all sources, concatenated in source order
 * (imports first, then local) within each phase.
 */
export async function discoverAllSources(config: SimplicitySchemaConfig): Promise<DiscoveredFiles> {
  const sources = resolveSources(config);
  const pre: SchemaFile[] = [];
  const schema: SchemaFile[] = [];
  const post: SchemaFile[] = [];

  for (const src of sources) {
    const discovered = await discoverSchemaFiles(src.dir, src.source);
    pre.push(...discovered.pre);
    schema.push(...discovered.schema);
    post.push(...discovered.post);
  }

  return { pre, schema, post };
}
