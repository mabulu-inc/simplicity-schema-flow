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
 * Deep-substitute params into every string value of an object via a JSON
 * round-trip. Param values are JSON-escaped so they remain valid inside the
 * serialized string. Object keys never contain placeholders.
 */
function interpolateObject<T>(obj: T, params: Record<string, string>, context: string): T {
  const json = JSON.stringify(obj);
  const out = json.replace(PARAM_RE, (_m, name: string) => {
    if (!(name in params)) {
      throw new Error(`${context}: references unknown or unset mixin param "{{${name}}}"`);
    }
    // Strip the surrounding quotes JSON.stringify adds — we're already inside a
    // JSON string literal — keeping any interior escaping.
    return JSON.stringify(params[name]).slice(1, -1);
  });
  return JSON.parse(out) as T;
}

/**
 * Interpolate a mixin's `{{param}}` placeholders. The `params` field (metadata)
 * is dropped from the result. Returns the mixin unchanged when it declares no
 * params and the body contains no placeholders.
 */
export function interpolateMixin(mixin: MixinSchema, params: Record<string, string>): MixinSchema {
  const rest: MixinSchema = { ...mixin };
  delete rest.params;
  return interpolateObject(rest, params, `mixin "${mixin.mixin}"`);
}

/** Interpolate `{{param}}` placeholders in a shipped function's body. */
export function interpolateFunctionBody(fn: FunctionSchema, params: Record<string, string>): FunctionSchema {
  if (!fn.body.includes('{{')) return fn;
  return { ...fn, body: interpolateParamString(fn.body, params, `function "${fn.name}"`) };
}
