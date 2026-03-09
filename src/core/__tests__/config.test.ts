import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SIMPLICITY_SCHEMA_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns convention defaults when no overrides or env vars', () => {
    const config = resolveConfig();
    expect(config.baseDir).toBe('./schema');
    expect(config.pgSchema).toBe('public');
    expect(config.dryRun).toBe(false);
    expect(config.allowDestructive).toBe(false);
    expect(config.skipChecks).toBe(false);
    expect(config.lockTimeout).toBe(5000);
    expect(config.statementTimeout).toBe(30000);
    expect(config.maxRetries).toBe(3);
    expect(config.historyTable).toBe('history');
    expect(config.verbose).toBe(false);
    expect(config.quiet).toBe(false);
    expect(config.json).toBe(false);
    expect(config.connectionString).toBe('');
  });

  it('reads DATABASE_URL from environment', () => {
    process.env.DATABASE_URL = 'postgres://localhost/mydb';
    const config = resolveConfig();
    expect(config.connectionString).toBe('postgres://localhost/mydb');
  });

  it('prefers SIMPLICITY_SCHEMA_DATABASE_URL over DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://localhost/generic';
    process.env.SIMPLICITY_SCHEMA_DATABASE_URL = 'postgres://localhost/specific';
    const config = resolveConfig();
    expect(config.connectionString).toBe('postgres://localhost/specific');
  });

  it('CLI overrides take highest priority', () => {
    process.env.DATABASE_URL = 'postgres://localhost/envdb';
    const config = resolveConfig({
      connectionString: 'postgres://localhost/clidb',
      pgSchema: 'custom',
      lockTimeout: 1000,
      verbose: true,
    });
    expect(config.connectionString).toBe('postgres://localhost/clidb');
    expect(config.pgSchema).toBe('custom');
    expect(config.lockTimeout).toBe(1000);
    expect(config.verbose).toBe(true);
  });

  it('does not override defaults for unspecified overrides', () => {
    const config = resolveConfig({ verbose: true });
    expect(config.baseDir).toBe('./schema');
    expect(config.pgSchema).toBe('public');
    expect(config.lockTimeout).toBe(5000);
    expect(config.verbose).toBe(true);
  });
});
