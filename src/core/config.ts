/**
 * Configuration resolution for simplicity-schema.
 *
 * Resolution order (highest priority first):
 * 1. CLI flags (passed as overrides)
 * 2. Config file (simplicity-schema.config.yaml)
 * 3. Environment variables
 * 4. Convention defaults
 */

import { loadConfigFile } from './config-file.js';

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
  return process.env.SIMPLICITY_SCHEMA_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? '';
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

  return config;
}
