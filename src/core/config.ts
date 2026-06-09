/**
 * Configuration resolution for schema-flow.
 *
 * Resolution order (highest priority first):
 * 1. CLI flags (passed as overrides)
 * 2. Config file (schema-flow.config.yaml)
 * 3. Environment variables
 * 4. Convention defaults
 */

import { loadConfigFile } from './config-file.js';

/**
 * A package import. Either a bare package name (string in YAML) or an object
 * with `package` and optional `params` (used to override mixin parameters
 * shipped by that package — see parameterized mixins).
 */
export interface ImportSpec {
  package: string;
  params?: Record<string, string>;
}

export interface SimplicitySchemaConfig {
  connectionString: string;
  baseDir: string;
  pgSchema: string;
  dryRun: boolean;
  allowDestructive: boolean;
  skipChecks: boolean;
  lockTimeout: number;
  statementTimeout: number;
  maxRetries: number;
  historyTable: string;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  /**
   * Optional SQL file injected at the start of every executor transaction
   * (pre-scripts, the main migrate+seeds tx, post-scripts, tighten). Intended
   * for per-tx session settings — e.g. `SET LOCAL "app.user_id" = '...'` so
   * audit triggers see a stable actor across the whole pipeline.
   */
  perTxSqlPath?: string;
  /**
   * Session settings applied (as `SET LOCAL`) for the duration of the bootstrap
   * transaction, alongside the built-in `smplcty.bootstrap = 'true'`. Maps GUC
   * name → value, e.g. `{ 'app.audit_lenient': true }`. Config-file only (a map
   * doesn't fit a CLI flag).
   */
  bootstrapSession?: Record<string, string | number | boolean>;
  /**
   * Packages whose `schema/` directories are loaded as additional sources,
   * merged with the local schema. Resolved from the consumer project's
   * `node_modules` (walking up from `baseDir`), so the installed dependency
   * version controls the imported schema. Imported sources load first (in
   * listed order), then the local schema.
   */
  imports?: ImportSpec[];
}

export interface ConfigOverrides {
  connectionString?: string;
  baseDir?: string;
  pgSchema?: string;
  dryRun?: boolean;
  allowDestructive?: boolean;
  skipChecks?: boolean;
  lockTimeout?: number;
  statementTimeout?: number;
  maxRetries?: number;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  env?: string;
  configPath?: string;
  perTxSqlPath?: string;
}

const DEFAULTS: SimplicitySchemaConfig = {
  connectionString: '',
  baseDir: './schema',
  pgSchema: 'public',
  dryRun: false,
  allowDestructive: false,
  skipChecks: false,
  lockTimeout: 5000,
  statementTimeout: 30000,
  maxRetries: 3,
  historyTable: 'history',
  verbose: false,
  quiet: false,
  json: false,
};

function resolveConnectionString(): string {
  return process.env.SCHEMA_FLOW_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

export function resolveConfig(overrides: ConfigOverrides = {}): SimplicitySchemaConfig {
  // Layer 4: defaults
  const config: SimplicitySchemaConfig = { ...DEFAULTS };

  // Layer 3: environment variables (only connectionString)
  const envConnectionString = resolveConnectionString();
  if (envConnectionString) {
    config.connectionString = envConnectionString;
  }

  // Layer 2: config file
  const fileConfig = loadConfigFile(overrides.configPath, overrides.env);
  if (fileConfig) {
    if (fileConfig.connectionString !== undefined) config.connectionString = fileConfig.connectionString;
    if (fileConfig.pgSchema !== undefined) config.pgSchema = fileConfig.pgSchema;
    if (fileConfig.baseDir !== undefined) config.baseDir = fileConfig.baseDir;
    if (fileConfig.lockTimeout !== undefined) config.lockTimeout = fileConfig.lockTimeout;
    if (fileConfig.statementTimeout !== undefined) config.statementTimeout = fileConfig.statementTimeout;
    if (fileConfig.maxRetries !== undefined) config.maxRetries = fileConfig.maxRetries;
    if (fileConfig.dryRun !== undefined) config.dryRun = fileConfig.dryRun;
    if (fileConfig.allowDestructive !== undefined) config.allowDestructive = fileConfig.allowDestructive;
    if (fileConfig.skipChecks !== undefined) config.skipChecks = fileConfig.skipChecks;
    if (fileConfig.verbose !== undefined) config.verbose = fileConfig.verbose;
    if (fileConfig.quiet !== undefined) config.quiet = fileConfig.quiet;
    if (fileConfig.json !== undefined) config.json = fileConfig.json;
    if (fileConfig.perTxSqlPath !== undefined) config.perTxSqlPath = fileConfig.perTxSqlPath;
    if (fileConfig.bootstrapSession !== undefined) config.bootstrapSession = fileConfig.bootstrapSession;
    if (fileConfig.imports !== undefined) config.imports = fileConfig.imports;
  }

  // Layer 1: CLI overrides
  if (overrides.connectionString !== undefined) config.connectionString = overrides.connectionString;
  if (overrides.baseDir !== undefined) config.baseDir = overrides.baseDir;
  if (overrides.pgSchema !== undefined) config.pgSchema = overrides.pgSchema;
  if (overrides.dryRun !== undefined) config.dryRun = overrides.dryRun;
  if (overrides.allowDestructive !== undefined) config.allowDestructive = overrides.allowDestructive;
  if (overrides.skipChecks !== undefined) config.skipChecks = overrides.skipChecks;
  if (overrides.lockTimeout !== undefined) config.lockTimeout = overrides.lockTimeout;
  if (overrides.statementTimeout !== undefined) config.statementTimeout = overrides.statementTimeout;
  if (overrides.maxRetries !== undefined) config.maxRetries = overrides.maxRetries;
  if (overrides.verbose !== undefined) config.verbose = overrides.verbose;
  if (overrides.quiet !== undefined) config.quiet = overrides.quiet;
  if (overrides.json !== undefined) config.json = overrides.json;
  if (overrides.perTxSqlPath !== undefined) config.perTxSqlPath = overrides.perTxSqlPath;

  return config;
}
