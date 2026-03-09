import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { parseArgs } from '../args.js';
import { runPipeline } from '../pipeline.js';
import { createLogger } from '../../core/logger.js';
import { closePool } from '../../core/db.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATABASE_URL = process.env.DATABASE_URL!;

describe('CLI argument parsing', () => {
  it('should parse "run" command with no subcommand', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run']);
    expect(result.command).toBe('run');
    expect(result.subcommand).toBeUndefined();
  });

  it('should parse "run pre" subcommand', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', 'pre']);
    expect(result.command).toBe('run');
    expect(result.subcommand).toBe('pre');
  });

  it('should parse "run migrate" subcommand', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', 'migrate']);
    expect(result.command).toBe('run');
    expect(result.subcommand).toBe('migrate');
  });

  it('should parse "run post" subcommand', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', 'post']);
    expect(result.command).toBe('run');
    expect(result.subcommand).toBe('post');
  });

  it('should parse "plan" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'plan']);
    expect(result.command).toBe('plan');
  });

  it('should parse "validate" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'validate']);
    expect(result.command).toBe('validate');
  });

  it('should parse "status" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'status']);
    expect(result.command).toBe('status');
  });

  it('should parse "init" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'init']);
    expect(result.command).toBe('init');
  });

  it('should default to "help" when no command given', () => {
    const result = parseArgs(['node', 'simplicity-schema']);
    expect(result.command).toBe('help');
  });

  it('should parse "help" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'help']);
    expect(result.command).toBe('help');
  });

  it('should parse --help flag as help command', () => {
    const result = parseArgs(['node', 'simplicity-schema', '--help']);
    expect(result.command).toBe('help');
  });

  it('should parse --version flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', '--version']);
    expect(result.command).toBe('version');
  });

  it('should parse --connection-string flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--connection-string', 'postgres://localhost/db']);
    expect(result.overrides.connectionString).toBe('postgres://localhost/db');
  });

  it('should parse --db flag as connectionString', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--db', 'postgres://localhost/db']);
    expect(result.overrides.connectionString).toBe('postgres://localhost/db');
  });

  it('should parse --dir flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--dir', './my-schema']);
    expect(result.overrides.baseDir).toBe('./my-schema');
  });

  it('should parse --schema flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--schema', 'myschema']);
    expect(result.overrides.pgSchema).toBe('myschema');
  });

  it('should parse --dry-run flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--dry-run']);
    expect(result.overrides.dryRun).toBe(true);
  });

  it('should parse --allow-destructive flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--allow-destructive']);
    expect(result.overrides.allowDestructive).toBe(true);
  });

  it('should parse --skip-checks flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--skip-checks']);
    expect(result.overrides.skipChecks).toBe(true);
  });

  it('should parse --verbose flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--verbose']);
    expect(result.overrides.verbose).toBe(true);
  });

  it('should parse --quiet flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--quiet']);
    expect(result.overrides.quiet).toBe(true);
  });

  it('should parse --json flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--json']);
    expect(result.overrides.json).toBe(true);
  });

  it('should parse --env flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--env', 'production']);
    expect(result.overrides.env).toBe('production');
  });

  it('should parse --lock-timeout flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--lock-timeout', '3000']);
    expect(result.overrides.lockTimeout).toBe(3000);
  });

  it('should parse --statement-timeout flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--statement-timeout', '60000']);
    expect(result.overrides.statementTimeout).toBe(60000);
  });

  it('should parse --max-retries flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'run', '--max-retries', '5']);
    expect(result.overrides.maxRetries).toBe(5);
  });

  it('should parse multiple flags together', () => {
    const result = parseArgs([
      'node', 'simplicity-schema', 'run',
      '--verbose', '--allow-destructive', '--dir', './schemas',
      '--connection-string', 'postgres://localhost/mydb',
    ]);
    expect(result.command).toBe('run');
    expect(result.overrides.verbose).toBe(true);
    expect(result.overrides.allowDestructive).toBe(true);
    expect(result.overrides.baseDir).toBe('./schemas');
    expect(result.overrides.connectionString).toBe('postgres://localhost/mydb');
  });

  it('should treat unknown commands as help', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'foobar']);
    expect(result.command).toBe('unknown');
    expect(result.unknownCommand).toBe('foobar');
  });
});

describe('CLI pipeline', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-cli-'));
  });

  afterAll(async () => {
    await closePool();
  });

  it('should run full pipeline with empty schema dir', async () => {
    // Create empty schema directory structure
    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const result = await runPipeline({
      connectionString: DATABASE_URL,
      baseDir: tmpDir,
      pgSchema: 'public',
      dryRun: false,
      allowDestructive: false,
      skipChecks: false,
      lockTimeout: 5000,
      statementTimeout: 30000,
      maxRetries: 3,
      historyTable: 'history',
      verbose: false,
      quiet: true,
      json: false,
    }, logger);

    expect(result.executed).toBe(0);
    expect(result.dryRun).toBe(false);
  });

  it('should run plan (dry-run) pipeline', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tables', 'test_cli_table.yaml'), `
table: test_cli_plan_table
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
    nullable: false
`);

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const result = await runPipeline({
      connectionString: DATABASE_URL,
      baseDir: tmpDir,
      pgSchema: 'public',
      dryRun: true,
      allowDestructive: false,
      skipChecks: false,
      lockTimeout: 5000,
      statementTimeout: 30000,
      maxRetries: 3,
      historyTable: 'history',
      verbose: false,
      quiet: true,
      json: false,
    }, logger);

    expect(result.dryRun).toBe(true);
  });

  it('should run validate pipeline', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tables', 'test_validate.yaml'), `
table: test_cli_validate_table
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`);

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const result = await runPipeline({
      connectionString: DATABASE_URL,
      baseDir: tmpDir,
      pgSchema: 'public',
      dryRun: false,
      allowDestructive: false,
      skipChecks: false,
      lockTimeout: 5000,
      statementTimeout: 30000,
      maxRetries: 3,
      historyTable: 'history',
      verbose: false,
      quiet: true,
      json: false,
    }, logger, { validateOnly: true });

    expect(result.validated).toBe(true);
  });

  it('should run pre-only pipeline', async () => {
    fs.mkdirSync(path.join(tmpDir, 'pre'), { recursive: true });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const result = await runPipeline({
      connectionString: DATABASE_URL,
      baseDir: tmpDir,
      pgSchema: 'public',
      dryRun: false,
      allowDestructive: false,
      skipChecks: false,
      lockTimeout: 5000,
      statementTimeout: 30000,
      maxRetries: 3,
      historyTable: 'history',
      verbose: false,
      quiet: true,
      json: false,
    }, logger, { phaseFilter: 'pre' });

    expect(result.executed).toBe(0);
  });

  it('should run init command to create directory structure', async () => {
    const initDir = path.join(tmpDir, 'new-project');
    const { initProject } = await import('../pipeline.js');
    initProject(initDir);

    expect(fs.existsSync(path.join(initDir, 'tables'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'enums'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'functions'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'views'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'roles'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'mixins'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'pre'))).toBe(true);
    expect(fs.existsSync(path.join(initDir, 'post'))).toBe(true);
  });

  it('should run status command', async () => {
    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const { getStatus } = await import('../pipeline.js');
    const status = await getStatus({
      connectionString: DATABASE_URL,
      baseDir: tmpDir,
      pgSchema: 'public',
      dryRun: false,
      allowDestructive: false,
      skipChecks: false,
      lockTimeout: 5000,
      statementTimeout: 30000,
      maxRetries: 3,
      historyTable: 'history',
      verbose: false,
      quiet: true,
      json: false,
    }, logger);

    expect(status).toBeDefined();
    expect(typeof status.appliedFiles).toBe('number');
    expect(typeof status.pendingChanges).toBe('number');
  });
});

describe('CLI help output', () => {
  it('should produce help text', async () => {
    const { getHelpText } = await import('../help.js');
    const text = getHelpText();
    expect(text).toContain('simplicity-schema');
    expect(text).toContain('run');
    expect(text).toContain('plan');
    expect(text).toContain('validate');
    expect(text).toContain('status');
    expect(text).toContain('init');
  });
});
