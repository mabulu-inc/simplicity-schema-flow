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
import { execute } from '../executor/index.js';
import type { ExecuteResult } from '../executor/index.js';
import { getPool } from '../core/db.js';
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
  logger.debug(`Discovered ${discovered.pre.length} pre, ${discovered.schema.length} schema, ${discovered.post.length} post files`);

  // If phase-filtered, skip irrelevant work
  const preScripts = phaseFilter === 'migrate' || phaseFilter === 'post' ? [] : discovered.pre;
  const postScripts = phaseFilter === 'pre' || phaseFilter === 'migrate' ? [] : discovered.post;
  const shouldMigrate = !phaseFilter || phaseFilter === 'migrate';

  let operations: ReturnType<typeof buildPlan>['operations'] = [];
  let blocked: ReturnType<typeof buildPlan>['blocked'] = [];

  if (shouldMigrate && discovered.schema.length > 0) {
    // 2. Parse YAML files
    const desired = await parseDesiredState(discovered.schema, config.baseDir, logger);

    // 3. Introspect database
    const actual = await introspectDatabase(config, logger);

    // 4. Build plan
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

  // 5. Execute
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
async function introspectDatabase(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<ActualState> {
  const pool = getPool(config.connectionString);
  const client = await pool.connect();

  try {
    const [tableNames, enumList, fnList, viewList, matViewList, roleList] = await Promise.all([
      getExistingTables(client, config.pgSchema),
      getExistingEnums(client, config.pgSchema),
      getExistingFunctions(client, config.pgSchema),
      getExistingViews(client, config.pgSchema),
      getExistingMaterializedViews(client, config.pgSchema),
      getExistingRoles(client),
    ]);

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
    const extResult = await client.query(
      "SELECT extname FROM pg_extension WHERE extname != 'plpgsql'",
    );
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
  const actual = await introspectDatabase(config, logger);
  return { desired, actual };
}

/**
 * Build a migration plan without executing.
 */
export async function getPlan(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<ReturnType<typeof buildPlan>> {
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
export async function runBaseline(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<BaselineResult> {
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

export async function getStatus(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<StatusResult> {
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
