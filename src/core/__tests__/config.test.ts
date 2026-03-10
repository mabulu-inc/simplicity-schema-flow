import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig } from '../config.js';
import { parseArgs } from '../../cli/args.js';

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

describe('--env flag E2E', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SIMPLICITY_SCHEMA_DATABASE_URL;
    delete process.env.DATABASE_URL;
    tmpDir = join(tmpdir(), `simplicity-env-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--env staging selects staging environment block from config file', () => {
    const configPath = join(tmpDir, 'simplicity-schema.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://localhost/default_db
  lockTimeout: 5000
  statementTimeout: 30000
  pgSchema: public

environments:
  staging:
    connectionString: postgres://staging-host/staging_db
    lockTimeout: 10000
    statementTimeout: 60000
  production:
    connectionString: postgres://prod-host/prod_db
    lockTimeout: 15000
`,
    );

    const parsed = parseArgs(['node', 'simplicity-schema', 'run', '--env', 'staging']);
    expect(parsed.overrides.env).toBe('staging');

    const config = resolveConfig({ ...parsed.overrides, configPath });
    expect(config.connectionString).toBe('postgres://staging-host/staging_db');
    expect(config.lockTimeout).toBe(10000);
    expect(config.statementTimeout).toBe(60000);
    // pgSchema inherited from default
    expect(config.pgSchema).toBe('public');
  });

  it('--env production selects production environment block', () => {
    const configPath = join(tmpDir, 'simplicity-schema.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://localhost/default_db
  lockTimeout: 5000
  statementTimeout: 30000

environments:
  production:
    connectionString: postgres://prod-host/prod_db
    lockTimeout: 15000
    statementTimeout: 120000
`,
    );

    const parsed = parseArgs(['node', 'simplicity-schema', 'plan', '--env', 'production']);
    const config = resolveConfig({ ...parsed.overrides, configPath });
    expect(config.connectionString).toBe('postgres://prod-host/prod_db');
    expect(config.lockTimeout).toBe(15000);
    expect(config.statementTimeout).toBe(120000);
  });

  it('CLI overrides take priority over environment-specific config', () => {
    const configPath = join(tmpDir, 'simplicity-schema.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  lockTimeout: 5000

environments:
  staging:
    connectionString: postgres://staging/db
    lockTimeout: 10000
`,
    );

    const parsed = parseArgs([
      'node',
      'simplicity-schema',
      'run',
      '--env',
      'staging',
      '--lock-timeout',
      '2000',
      '--connection-string',
      'postgres://cli-override/db',
    ]);
    const config = resolveConfig({ ...parsed.overrides, configPath });
    // CLI flags override environment config
    expect(config.connectionString).toBe('postgres://cli-override/db');
    expect(config.lockTimeout).toBe(2000);
  });

  it('without --env, only default section is used', () => {
    const configPath = join(tmpDir, 'simplicity-schema.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://localhost/default_db
  lockTimeout: 7000

environments:
  staging:
    connectionString: postgres://staging/db
    lockTimeout: 10000
`,
    );

    const parsed = parseArgs(['node', 'simplicity-schema', 'run']);
    expect(parsed.overrides.env).toBeUndefined();

    const config = resolveConfig({ ...parsed.overrides, configPath });
    expect(config.connectionString).toBe('postgres://localhost/default_db');
    expect(config.lockTimeout).toBe(7000);
  });

  it('--env with ${VAR} interpolation in environment block', () => {
    process.env.STAGING_DB_HOST = 'staging-rds.example.com';
    const configPath = join(tmpDir, 'simplicity-schema.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://localhost/default_db

environments:
  staging:
    connectionString: postgres://\${STAGING_DB_HOST}/staging_db
`,
    );

    const parsed = parseArgs(['node', 'simplicity-schema', 'run', '--env', 'staging']);
    const config = resolveConfig({ ...parsed.overrides, configPath });
    expect(config.connectionString).toBe('postgres://staging-rds.example.com/staging_db');
  });
});
