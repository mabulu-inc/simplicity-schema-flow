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

/**
 * Where a run sits relative to the deploy (#83). `before-deploy` applies only
 * what the old code can live with; `after-deploy` is the full pass, run once
 * every service is deployed and checked. schema-flow cannot tell when that is,
 * so the caller says so.
 */
export type Stage = 'before-deploy' | 'after-deploy';

export const STAGES: readonly Stage[] = ['before-deploy', 'after-deploy'];

export interface SimplicitySchemaConfig {
  connectionString: string;
  baseDir: string;
  pgSchema: string;
  dryRun: boolean;
  allowDestructive: boolean;
  /** Overrides `allowDestructive` when set: off before deploy, on after (see `applyStage`). */
  stage?: Stage;
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
   * (pre-scripts, each per-table DDL group, the seed tx, post-scripts, tighten).
   * Intended for per-tx session settings — e.g. `SET LOCAL "app.user_id" = '...'`
   * so audit triggers see a stable actor across the whole pipeline.
   */
  perTxSqlPath?: string;
  /**
   * Session settings applied (as `SET LOCAL`) to every transaction that writes
   * seeds: the bootstrap transaction (alongside the built-in
   * `smplcty.bootstrap = 'true'`) and the seed transaction. Maps GUC name →
   * value, e.g. `{ 'app.audit_lenient': true }`. Config-file only (a map
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
  stage?: Stage;
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
  if (overrides.stage !== undefined) config.stage = overrides.stage;

  return applyStage(config);
}

/**
 * A stage decides destructive work outright: `before-deploy` never applies a
 * destructive change, whatever else is set; `after-deploy` applies them all,
 * plus anything additive still pending. No stage leaves `allowDestructive` alone.
 */
export function applyStage(config: SimplicitySchemaConfig): SimplicitySchemaConfig {
  if (!config.stage) return config;
  return { ...config, allowDestructive: config.stage === 'after-deploy' };
}

/** How to get a held-back destructive change applied, for "Blocked" messages. */
export function destructiveHint(stage: Stage | undefined): string {
  return stage === 'before-deploy' ? 'waits for --stage after-deploy' : 'use --allow-destructive to allow';
}
