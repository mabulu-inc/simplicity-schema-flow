import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfigFile, interpolateEnvVars } from '../config-file.js';

describe('interpolateEnvVars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('replaces ${VAR} with environment variable value', () => {
    process.env.MY_DB = 'postgres://localhost/test';
    expect(interpolateEnvVars('${MY_DB}')).toBe('postgres://localhost/test');
  });

  it('replaces multiple variables', () => {
    process.env.HOST = 'localhost';
    process.env.PORT = '5432';
    expect(interpolateEnvVars('${HOST}:${PORT}')).toBe('localhost:5432');
  });

  it('replaces missing variables with empty string', () => {
    delete process.env.MISSING_VAR;
    expect(interpolateEnvVars('prefix-${MISSING_VAR}-suffix')).toBe('prefix--suffix');
  });

  it('returns string unchanged if no variables', () => {
    expect(interpolateEnvVars('plain string')).toBe('plain string');
  });
});

describe('loadConfigFile', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = join(tmpdir(), `simplicity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when config file does not exist', () => {
    const result = loadConfigFile('/nonexistent/path.yaml');
    expect(result).toBeNull();
  });

  it('loads default section values', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, `
default:
  connectionString: postgres://localhost/mydb
  pgSchema: app
  lockTimeout: 3000
`);
    const result = loadConfigFile(configPath);
    expect(result).not.toBeNull();
    expect(result!.connectionString).toBe('postgres://localhost/mydb');
    expect(result!.pgSchema).toBe('app');
    expect(result!.lockTimeout).toBe(3000);
  });

  it('interpolates environment variables', () => {
    process.env.TEST_DB_URL = 'postgres://localhost/interpolated';
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, `
default:
  connectionString: \${TEST_DB_URL}
`);
    const result = loadConfigFile(configPath);
    expect(result!.connectionString).toBe('postgres://localhost/interpolated');
  });

  it('overlays environment-specific config on top of defaults', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, `
default:
  connectionString: postgres://localhost/default
  pgSchema: public
  lockTimeout: 5000

environments:
  staging:
    connectionString: postgres://staging/db
    lockTimeout: 3000
`);
    const result = loadConfigFile(configPath, 'staging');
    expect(result!.connectionString).toBe('postgres://staging/db');
    expect(result!.pgSchema).toBe('public'); // inherited from default
    expect(result!.lockTimeout).toBe(3000); // overridden by staging
  });

  it('returns default values when environment not found', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, `
default:
  pgSchema: myschema
`);
    const result = loadConfigFile(configPath, 'nonexistent');
    expect(result!.pgSchema).toBe('myschema');
  });

  it('handles empty config file', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, '');
    const result = loadConfigFile(configPath);
    expect(result).toBeNull();
  });

  it('parses boolean config values', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, `
default:
  dryRun: true
  allowDestructive: true
  verbose: false
`);
    const result = loadConfigFile(configPath);
    expect(result!.dryRun).toBe(true);
    expect(result!.allowDestructive).toBe(true);
    expect(result!.verbose).toBe(false);
  });
});
