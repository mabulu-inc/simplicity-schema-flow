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
}

interface RawConfigFile {
  default?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
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

  return result;
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

  return toFileConfigValues(merged);
}
