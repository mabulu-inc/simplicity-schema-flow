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

  // ─── Missing command parsing tests (T-030) ─────────────────────

  it('should parse "drift" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'drift']);
    expect(result.command).toBe('drift');
  });

  it('should parse "drift" with --apply flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'drift', '--apply']);
    expect(result.command).toBe('drift');
    expect(result.apply).toBe(true);
  });

  it('should parse "lint" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'lint']);
    expect(result.command).toBe('lint');
  });

  it('should parse "generate" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'generate']);
    expect(result.command).toBe('generate');
  });

  it('should parse "generate" with --output-dir flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'generate', '--output-dir', './out']);
    expect(result.command).toBe('generate');
    expect(result.output).toBe('./out');
  });

  it('should parse "generate" with --seeds flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'generate', '--seeds']);
    expect(result.command).toBe('generate');
    expect(result.seeds).toBe(true);
  });

  it('should parse "sql" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'sql']);
    expect(result.command).toBe('sql');
  });

  it('should parse "sql" with --output flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'sql', '--output', 'migration.sql']);
    expect(result.command).toBe('sql');
    expect(result.output).toBe('migration.sql');
  });

  it('should parse "erd" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'erd']);
    expect(result.command).toBe('erd');
  });

  it('should parse "erd" with --output flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'erd', '--output', 'schema.mmd']);
    expect(result.command).toBe('erd');
    expect(result.output).toBe('schema.mmd');
  });

  it('should parse "new pre" with --name flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'new', 'pre', '--name', 'add_indexes']);
    expect(result.command).toBe('new');
    expect(result.newSubcommand).toBe('pre');
    expect(result.name).toBe('add_indexes');
  });

  it('should parse "new post" with --name flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'new', 'post', '--name', 'seed_data']);
    expect(result.command).toBe('new');
    expect(result.newSubcommand).toBe('post');
    expect(result.name).toBe('seed_data');
  });

  it('should parse "new mixin" with --name flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'new', 'mixin', '--name', 'timestamps']);
    expect(result.command).toBe('new');
    expect(result.newSubcommand).toBe('mixin');
    expect(result.name).toBe('timestamps');
  });

  it('should parse "down" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'down']);
    expect(result.command).toBe('down');
  });

  it('should parse "contract" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'contract']);
    expect(result.command).toBe('contract');
  });

  it('should parse "expand-status" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'expand-status']);
    expect(result.command).toBe('expand-status');
  });

  it('should parse "docs" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'docs']);
    expect(result.command).toBe('docs');
  });

  it('should parse "generate" with --output-dir and --seeds together', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'generate', '--output-dir', './generated', '--seeds']);
    expect(result.command).toBe('generate');
    expect(result.output).toBe('./generated');
    expect(result.seeds).toBe(true);
  });

  it('should parse "drift" with --json flag', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'drift', '--json']);
    expect(result.command).toBe('drift');
    expect(result.overrides.json).toBe(true);
  });

  it('should parse "new" without subcommand', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'new']);
    expect(result.command).toBe('new');
    expect(result.newSubcommand).toBeUndefined();
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

describe('CLI baseline command', () => {
  it('should parse "baseline" command', () => {
    const result = parseArgs(['node', 'simplicity-schema', 'baseline']);
    expect(result.command).toBe('baseline');
  });

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-baseline-'));
  });

  afterAll(async () => {
    await closePool();
  });

  it('should record all schema files without running migrations', async () => {
    // Create schema files
    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'enums'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tables', 'users.yaml'), `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`);
    fs.writeFileSync(path.join(tmpDir, 'enums', 'status.yaml'), `
enum: status
values:
  - active
  - inactive
`);

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const { runBaseline } = await import('../pipeline.js');
    const result = await runBaseline({
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

    expect(result.filesRecorded).toBe(2);

    // Verify files are recorded in history — status should show 0 pending
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

    expect(status.appliedFiles).toBeGreaterThanOrEqual(2);
    expect(status.pendingChanges).toBe(0);
  });

  it('should record pre and post scripts in baseline', async () => {
    fs.mkdirSync(path.join(tmpDir, 'pre'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'post'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pre', '001_setup.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(tmpDir, 'post', '001_cleanup.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(tmpDir, 'tables', 'items.yaml'), `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
`);

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const { runBaseline } = await import('../pipeline.js');
    const result = await runBaseline({
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

    expect(result.filesRecorded).toBe(3);
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
