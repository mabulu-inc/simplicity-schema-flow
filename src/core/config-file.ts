/**
 * Config file loading for schema-flow.
 *
 * Loads optional schema-flow.config.yaml with:
 * - ${VAR} environment variable interpolation
 * - Environment-specific overrides via `environments` section
 * - `default` section as base for all environments
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ImportSpec } from './config.js';

export interface FileConfigValues {
  connectionString?: string;
  baseDir?: string;
  pgSchema?: string;
  lockTimeout?: number;
  statementTimeout?: number;
  maxRetries?: number;
  dryRun?: boolean;
  allowDestructive?: boolean;
  skipChecks?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  perTxSqlPath?: string;
  bootstrapSession?: Record<string, string | number | boolean>;
  imports?: ImportSpec[];
}

interface RawConfigFile {
  default?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
  imports?: unknown;
}

const DEFAULT_CONFIG_FILENAME = 'schema-flow.config.yaml';

/**
 * Interpolate ${VAR} references in a string with environment variable values.
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Recursively interpolate env vars in all string values of an object.
 */
function interpolateObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = interpolateEnvVars(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function toFileConfigValues(raw: Record<string, unknown>): FileConfigValues {
  const result: FileConfigValues = {};

  if (typeof raw.connectionString === 'string') result.connectionString = raw.connectionString;
  if (typeof raw.baseDir === 'string') result.baseDir = raw.baseDir;
  if (typeof raw.pgSchema === 'string') result.pgSchema = raw.pgSchema;
  if (typeof raw.lockTimeout === 'number') result.lockTimeout = raw.lockTimeout;
  if (typeof raw.statementTimeout === 'number') result.statementTimeout = raw.statementTimeout;
  if (typeof raw.maxRetries === 'number') result.maxRetries = raw.maxRetries;
  if (typeof raw.dryRun === 'boolean') result.dryRun = raw.dryRun;
  if (typeof raw.allowDestructive === 'boolean') result.allowDestructive = raw.allowDestructive;
  if (typeof raw.skipChecks === 'boolean') result.skipChecks = raw.skipChecks;
  if (typeof raw.verbose === 'boolean') result.verbose = raw.verbose;
  if (typeof raw.quiet === 'boolean') result.quiet = raw.quiet;
  if (typeof raw.json === 'boolean') result.json = raw.json;
  if (typeof raw.perTxSqlPath === 'string') result.perTxSqlPath = raw.perTxSqlPath;
  if (raw.bootstrapSession && typeof raw.bootstrapSession === 'object' && !Array.isArray(raw.bootstrapSession)) {
    const session: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.bootstrapSession as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') session[k] = v;
    }
    result.bootstrapSession = session;
  }

  return result;
}

/**
 * Normalize the `imports:` section into a list of ImportSpec. Each entry is
 * either a bare package name (string) or an object with `package` and optional
 * `params`. Env vars are interpolated in package names and param values.
 */
function normalizeImports(raw: unknown): ImportSpec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('config: "imports" must be a list of package names or { package, params } objects');
  }
  const specs: ImportSpec[] = raw.map((entry, i) => {
    if (typeof entry === 'string') {
      return { package: interpolateEnvVars(entry) };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const pkg = obj.package;
      if (typeof pkg !== 'string' || pkg.length === 0) {
        throw new Error(`config: imports[${i}] must have a non-empty "package" string`);
      }
      const spec: ImportSpec = { package: interpolateEnvVars(pkg) };
      if (obj.params !== undefined) {
        if (typeof obj.params !== 'object' || obj.params === null || Array.isArray(obj.params)) {
          throw new Error(`config: imports[${i}].params must be a map of param → value`);
        }
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
          params[k] = interpolateEnvVars(String(v));
        }
        spec.params = params;
      }
      return spec;
    }
    throw new Error(`config: imports[${i}] must be a package name (string) or { package, params } object`);
  });
  return specs;
}

/**
 * Load and parse the config file. Returns null if no config file found.
 */
export function loadConfigFile(configPath?: string, environment?: string): FileConfigValues | null {
  const filePath = configPath ?? resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as RawConfigFile | null;

  if (!parsed) {
    return null;
  }

  // Start with default section
  let merged: Record<string, unknown> = {};
  if (parsed.default) {
    merged = { ...parsed.default };
  }

  // Overlay environment-specific section
  if (environment && parsed.environments?.[environment]) {
    merged = { ...merged, ...parsed.environments[environment] };
  }

  // Interpolate env vars
  merged = interpolateObject(merged);

  const result = toFileConfigValues(merged);

  // `imports:` is a top-level key (sibling to default/environments), but also
  // honored under `default:`. Top-level wins when both are present.
  const imports = normalizeImports(parsed.imports ?? merged.imports);
  if (imports !== undefined) result.imports = imports;

  return result;
}
