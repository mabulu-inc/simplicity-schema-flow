/**
 * CLI pipeline — wires up the full migration pipeline from config to execution.
 */

import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimplicitySchemaConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { discoverSchemaFiles } from '../core/files.js';
import { parseSchemaFile } from '../schema/parser.js';
import { loadMixins, applyMixins } from '../schema/mixins.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
} from '../introspect/index.js';
import { buildPlan } from '../planner/index.js';
import type { DesiredState, ActualState } from '../planner/index.js';
import { normalizePolicyExpressions } from '../planner/normalize-expression.js';
import { execute } from '../executor/index.js';
import type { ExecuteResult } from '../executor/index.js';
import { getPool } from '../core/db.js';
import { hydrateActualSeeds } from '../drift/index.js';
import { ensureHistoryTable, getHistory, recordFile } from '../core/tracker.js';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ExtensionsSchema,
  MixinSchema,
} from '../schema/types.js';

export interface PipelineOptions {
  /** Only run a specific phase */
  phaseFilter?: 'pre' | 'migrate' | 'post';
  /** Validate mode — execute in rolled-back transaction */
  validateOnly?: boolean;
}

/**
 * Run the full migration pipeline (or a phase subset).
 */
export async function runPipeline(
  config: SimplicitySchemaConfig,
  logger: Logger,
  options: PipelineOptions = {},
): Promise<ExecuteResult> {
  const { phaseFilter, validateOnly = false } = options;

  // 1. Discover files
  const discovered = await discoverSchemaFiles(config.baseDir);
  logger.debug(
    `Discovered ${discovered.pre.length} pre, ${discovered.schema.length} schema, ${discovered.post.length} post files`,
  );

  // If phase-filtered, skip irrelevant work
  const preScripts = phaseFilter === 'migrate' || phaseFilter === 'post' ? [] : discovered.pre;
  const postScripts = phaseFilter === 'pre' || phaseFilter === 'migrate' ? [] : discovered.post;
  const shouldMigrate = !phaseFilter || phaseFilter === 'migrate';

  let operations: ReturnType<typeof buildPlan>['operations'] = [];
  let blocked: ReturnType<typeof buildPlan>['blocked'] = []; // eslint-disable-line no-useless-assignment

  if (shouldMigrate && discovered.schema.length > 0) {
    // 2. Parse YAML files
    const desired = await parseDesiredState(discovered.schema, config.baseDir, logger);

    // 3. Normalize policy expressions via PG round-trip
    const pool = getPool(config.connectionString);
    const normClient = await pool.connect();
    try {
      await normalizePolicyExpressions(normClient, desired.tables);
    } finally {
      normClient.release();
    }

    // 4. Introspect database
    const actual = await introspectDatabase(config, logger);

    // 5. Build plan
    const plan = buildPlan(desired, actual, {
      allowDestructive: config.allowDestructive,
      pgSchema: config.pgSchema,
    });
    operations = plan.operations;
    blocked = plan.blocked;

    if (blocked.length > 0) {
      for (const op of blocked) {
        logger.warn(`Blocked (destructive): ${op.type} ${op.objectName} — use --allow-destructive to allow`);
      }
    }

    logger.info(`Plan: ${operations.length} operations (${blocked.length} blocked)`);
  }

  // 6. Execute
  const result = await execute({
    connectionString: config.connectionString,
    operations,
    preScripts: phaseFilter !== 'migrate' ? preScripts : undefined,
    postScripts: phaseFilter !== 'migrate' ? postScripts : undefined,
    pgSchema: config.pgSchema,
    dryRun: config.dryRun,
    validateOnly,
    lockTimeout: config.lockTimeout,
    statementTimeout: config.statementTimeout,
    logger,
  });

  // 7. Record schema files in history after successful migration
  if (!config.dryRun && !validateOnly && shouldMigrate && discovered.schema.length > 0) {
    const pool = getPool(config.connectionString);
    const client = await pool.connect();
    try {
      await ensureHistoryTable(client);
      for (const file of discovered.schema) {
        await recordFile(client, file.relativePath, file.hash, file.phase);
      }
    } finally {
      client.release();
    }
  }

  return result;
}

/**
 * Parse all discovered schema files into a DesiredState.
 */
async function parseDesiredState(
  schemaFiles: { absolutePath: string; relativePath: string }[],
  baseDir: string,
  logger: Logger,
): Promise<DesiredState> {
  const tables: TableSchema[] = [];
  const enums: EnumSchema[] = [];
  const functions: FunctionSchema[] = [];
  const views: ViewSchema[] = [];
  const materializedViews: MaterializedViewSchema[] = [];
  const roles: RoleSchema[] = [];
  const mixinSchemas: MixinSchema[] = [];
  let extensions: ExtensionsSchema | null = null;

  for (const file of schemaFiles) {
    const content = await readFile(file.absolutePath, 'utf-8');
    try {
      const parsed = parseSchemaFile(content);
      switch (parsed.kind) {
        case 'table':
          tables.push(parsed.schema);
          break;
        case 'enum':
          enums.push(parsed.schema);
          break;
        case 'function':
          functions.push(parsed.schema);
          break;
        case 'view':
          views.push(parsed.schema);
          break;
        case 'materialized_view':
          materializedViews.push(parsed.schema);
          break;
        case 'role':
          roles.push(parsed.schema);
          break;
        case 'extensions':
          extensions = parsed.schema;
          break;
        case 'mixin':
          mixinSchemas.push(parsed.schema);
          break;
      }
    } catch (err) {
      logger.error(`Failed to parse ${file.relativePath}: ${(err as Error).message}`);
      throw err;
    }
  }

  // Apply mixins to tables
  if (mixinSchemas.length > 0) {
    const registry = loadMixins(mixinSchemas);
    for (let i = 0; i < tables.length; i++) {
      tables[i] = applyMixins(tables[i], registry);
    }
  }

  return { tables, enums, functions, views, materializedViews, roles, extensions };
}

/**
 * Introspect the live database to get the ActualState.
 */
async function introspectDatabase(config: SimplicitySchemaConfig, logger: Logger): Promise<ActualState> {
  const pool = getPool(config.connectionString);
  const client = await pool.connect();

  try {
    const tableNames = await getExistingTables(client, config.pgSchema);
    const enumList = await getExistingEnums(client, config.pgSchema);
    const fnList = await getExistingFunctions(client, config.pgSchema);
    const viewList = await getExistingViews(client, config.pgSchema);
    const matViewList = await getExistingMaterializedViews(client, config.pgSchema);
    const roleList = await getExistingRoles(client);

    // Introspect each table
    const tablesMap = new Map<string, TableSchema>();
    for (const name of tableNames) {
      const table = await introspectTable(client, name, config.pgSchema);
      tablesMap.set(name, table);
    }

    const enumsMap = new Map<string, EnumSchema>();
    for (const e of enumList) enumsMap.set(e.name, e);

    const functionsMap = new Map<string, FunctionSchema>();
    for (const f of fnList) functionsMap.set(f.name, f);

    const viewsMap = new Map<string, ViewSchema>();
    for (const v of viewList) viewsMap.set(v.name, v);

    const matViewsMap = new Map<string, MaterializedViewSchema>();
    for (const mv of matViewList) matViewsMap.set(mv.name, mv);

    const rolesMap = new Map<string, RoleSchema>();
    for (const r of roleList) rolesMap.set(r.role, r);

    // Get installed extensions
    const extResult = await client.query("SELECT extname FROM pg_extension WHERE extname != 'plpgsql'");
    const extensions = extResult.rows.map((r: { extname: string }) => r.extname);

    logger.debug(`Introspected: ${tableNames.length} tables, ${enumList.length} enums, ${fnList.length} functions`);

    return {
      tables: tablesMap,
      enums: enumsMap,
      functions: functionsMap,
      views: viewsMap,
      materializedViews: matViewsMap,
      roles: rolesMap,
      extensions,
    };
  } finally {
    client.release();
  }
}

/**
 * Build desired and actual state for drift/lint/sql/erd use.
 */
export async function buildDesiredAndActual(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<{ desired: DesiredState; actual: ActualState }> {
  const discovered = await discoverSchemaFiles(config.baseDir);
  const desired = await parseDesiredState(discovered.schema, config.baseDir, logger);

  // Normalize policy expressions via PG round-trip + hydrate actual seeds
  const pool = getPool(config.connectionString);
  const normClient = await pool.connect();
  try {
    await normalizePolicyExpressions(normClient, desired.tables);
  } finally {
    normClient.release();
  }

  const actual = await introspectDatabase(config, logger);

  // Hydrate actual seed data from the database for drift comparison
  const seedClient = await pool.connect();
  try {
    await hydrateActualSeeds(seedClient, desired.tables, actual.tables, config.pgSchema);
  } finally {
    seedClient.release();
  }

  return { desired, actual };
}

/**
 * Build a migration plan without executing.
 */
export async function getPlan(config: SimplicitySchemaConfig, logger: Logger): Promise<ReturnType<typeof buildPlan>> {
  const { desired, actual } = await buildDesiredAndActual(config, logger);
  return buildPlan(desired, actual, {
    allowDestructive: config.allowDestructive,
    pgSchema: config.pgSchema,
  });
}

/**
 * Initialize a new schema project directory.
 */
export function initProject(baseDir: string): void {
  const dirs = ['tables', 'enums', 'functions', 'views', 'roles', 'mixins', 'pre', 'post'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
  }
}

/**
 * Baseline result.
 */
export interface BaselineResult {
  filesRecorded: number;
}

/**
 * Mark the current DB state as baseline by recording all current schema files
 * in the history table without running any migrations.
 */
export async function runBaseline(config: SimplicitySchemaConfig, logger: Logger): Promise<BaselineResult> {
  const pool = getPool(config.connectionString);
  const client = await pool.connect();

  try {
    await ensureHistoryTable(client);

    const discovered = await discoverSchemaFiles(config.baseDir);
    const allFiles = [...discovered.pre, ...discovered.schema, ...discovered.post];

    let recorded = 0;
    for (const file of allFiles) {
      await recordFile(client, file.relativePath, file.hash, file.phase);
      recorded++;
      logger.debug(`Recorded: ${file.relativePath} (${file.phase})`);
    }

    logger.info(`Baseline complete: ${recorded} files recorded`);
    return { filesRecorded: recorded };
  } finally {
    client.release();
  }
}

/**
 * Get migration status — applied files and pending changes.
 */
export interface StatusResult {
  appliedFiles: number;
  pendingChanges: number;
  history: { filePath: string; phase: string; appliedAt: Date }[];
}

/**
 * Pipeline convenience: run all phases.
 */
export async function runAll(config: SimplicitySchemaConfig, logger: Logger): Promise<ExecuteResult> {
  return runPipeline(config, logger);
}

/**
 * Pipeline convenience: run only pre scripts.
 */
export async function runPre(config: SimplicitySchemaConfig, logger: Logger): Promise<ExecuteResult> {
  return runPipeline(config, logger, { phaseFilter: 'pre' });
}

/**
 * Pipeline convenience: run only migrate phase.
 */
export async function runMigrate(config: SimplicitySchemaConfig, logger: Logger): Promise<ExecuteResult> {
  return runPipeline(config, logger, { phaseFilter: 'migrate' });
}

/**
 * Pipeline convenience: run only post scripts.
 */
export async function runPost(config: SimplicitySchemaConfig, logger: Logger): Promise<ExecuteResult> {
  return runPipeline(config, logger, { phaseFilter: 'post' });
}

/**
 * Pipeline convenience: validate mode (rolled-back transaction).
 */
export async function runValidate(config: SimplicitySchemaConfig, logger: Logger): Promise<ExecuteResult> {
  return runPipeline(config, logger, { validateOnly: true });
}

export async function getStatus(config: SimplicitySchemaConfig, _logger: Logger): Promise<StatusResult> {
  const pool = getPool(config.connectionString);
  const client = await pool.connect();

  try {
    // Ensure history table exists (won't error on fresh DBs)
    await ensureHistoryTable(client);
    const history = await getHistory(client);

    // Discover current files
    const discovered = await discoverSchemaFiles(config.baseDir);
    const allFiles = [...discovered.pre, ...discovered.schema, ...discovered.post];

    // Count files that differ from recorded hashes
    const historyMap = new Map(history.map((h) => [h.filePath, h.fileHash]));
    let pendingChanges = 0;

    for (const file of allFiles) {
      const recordedHash = historyMap.get(file.relativePath);
      if (!recordedHash || recordedHash !== file.hash) {
        pendingChanges++;
      }
    }

    return {
      appliedFiles: history.length,
      pendingChanges,
      history: history.map((h) => ({
        filePath: h.filePath,
        phase: h.phase,
        appliedAt: h.appliedAt,
      })),
    };
  } finally {
    client.release();
  }
}
