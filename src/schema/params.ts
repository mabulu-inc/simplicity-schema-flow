/**
 * Mixin parameter interpolation.
 *
 * A sharable mixin (and the functions shipped in the same package) can use
 * `{{name}}` placeholders. The consuming app supplies values via
 * `imports[].params`; defaults declared on the mixin cover the common case.
 * Resolved values are substituted into the mixin's columns/refs/indexes/
 * policies and into the package's function bodies.
 */

import type { MixinSchema, FunctionSchema } from './types.js';

const PARAM_RE = /\{\{(\w+)\}\}/g;

/**
 * Object keys whose string values are documentation/metadata, never structural
 * SQL. They are left inert at any nesting depth so a comment (or the mixin name)
 * can mention `{{param}}` syntax in prose without the loader mistaking it for a
 * real, unresolved placeholder.
 */
const METADATA_KEYS = new Set(['comment', 'mixin']);

/** Replace `{{name}}` placeholders in a plain string, throwing on unresolved. */
export function interpolateParamString(str: string, params: Record<string, string>, context: string): string {
  return str.replace(PARAM_RE, (_m, name: string) => {
    if (!(name in params)) {
      throw new Error(`${context}: references unknown or unset mixin param "{{${name}}}"`);
    }
    return params[name];
  });
}

/**
 * Deep-substitute params into every structural string of a value, skipping
 * metadata keys (`comment`, the mixin name) at any depth. Operating on real
 * string values means param values need no JSON escaping.
 */
function interpolateValue<T>(value: T, params: Record<string, string>, context: string): T {
  if (typeof value === 'string') {
    return interpolateParamString(value, params, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, params, context)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = METADATA_KEYS.has(key) ? v : interpolateValue(v, params, context);
    }
    return out as T;
  }
  return value;
}

/**
 * Interpolate a mixin's `{{param}}` placeholders. The `params` field (metadata)
 * is dropped from the result. `comment` prose and the `mixin` name are left
 * untouched, so a mixin can document its own params without aborting the run.
 */
export function interpolateMixin(mixin: MixinSchema, params: Record<string, string>): MixinSchema {
  const rest: MixinSchema = { ...mixin };
  delete rest.params;
  return interpolateValue(rest, params, `mixin "${mixin.mixin}"`);
}

/** Interpolate `{{param}}` placeholders in a shipped function's body. */
export function interpolateFunctionBody(fn: FunctionSchema, params: Record<string, string>): FunctionSchema {
  if (!fn.body.includes('{{')) return fn;
  return { ...fn, body: interpolateParamString(fn.body, params, `function "${fn.name}"`) };
}
