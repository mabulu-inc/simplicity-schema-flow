/**
 * CLI pipeline — wires up the full migration pipeline from config to execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SimplicitySchemaConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { discoverAllSources, resolveImportParams } from '../core/sources.js';
import { buildDesiredState } from '../schema/desired-state.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  getSequenceGrants,
  getFunctionDependents,
  introspectTable,
} from '../introspect/index.js';
import type { Operation } from '../planner/index.js';
import { buildPlan } from '../planner/index.js';
import type { DesiredState, ActualState } from '../planner/index.js';
import {
  normalizePolicyExpressions,
  normalizeCheckExpressions,
  normalizeIndexWhereClauses,
  normalizeColumnDefaults,
  normalizeViewBodies,
} from '../planner/normalize-expression.js';
import { filterUnchangedSeeds } from '../planner/filter-seeds.js';
import { execute } from '../executor/index.js';
import type { ExecuteResult } from '../executor/index.js';
import { acquireClient } from '../core/db.js';
import { hydrateActualSeeds } from '../drift/index.js';
import { ensureHistoryTable, getHistory, recordFile } from '../core/tracker.js';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
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

  // 1. Discover files (local schema + imported package schema)
  const discovered = await discoverAllSources(config);
  logger.debug(
    `Discovered ${discovered.pre.length} pre, ${discovered.schema.length} schema, ${discovered.post.length} post files`,
  );

  // If phase-filtered, skip irrelevant work
  const preScripts = phaseFilter === 'migrate' || phaseFilter === 'post' ? [] : discovered.pre;
  const postScripts = phaseFilter === 'pre' || phaseFilter === 'migrate' ? [] : discovered.post;
  const shouldMigrate = !phaseFilter || phaseFilter === 'migrate';

  let operations: ReturnType<typeof buildPlan>['operations'] = [];
  let blocked: ReturnType<typeof buildPlan>['blocked'] = []; // eslint-disable-line no-useless-assignment
  let desired: DesiredState | null = null;

  if (shouldMigrate && discovered.schema.length > 0) {
    // 2. Parse YAML files (merging imported sources + local schema)
    desired = await buildDesiredState(discovered.schema, { importParams: resolveImportParams(config) });

    // 3. Normalize SQL expressions via PG round-trip — policy USING/CHECK,
    //    table CHECK constraints, and partial-index WHERE clauses. Without
    //    this, every migrate would emit drop+recreate ops for objects whose
    //    source text differs only in PG's added casts and parens (issue #26).
    const normClient = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });
    try {
      await normalizePolicyExpressions(normClient, desired.tables);
      await normalizeCheckExpressions(normClient, desired.tables);
      await normalizeIndexWhereClauses(normClient, desired.tables);
      await normalizeColumnDefaults(normClient, desired.tables);
      await normalizeViewBodies(normClient, desired.views);
      await filterUnchangedSeeds(normClient, desired.tables, config.pgSchema);
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

    // In dry-run (plan) the report renders its own "Plan:" summary, so
    // skip this line to avoid two redundant "Plan:" headers.
    if (!config.dryRun) {
      logger.info(`Plan: ${operations.length} operations (${blocked.length} blocked)`);
    }

    // Surface what a planned `DROP FUNCTION … CASCADE` will take out before it
    // runs — declared dependents are recreated by the convergence re-plan, but
    // undeclared ones (an ad-hoc view/policy a consumer created) would be lost
    // silently. Warn so that's an explicit signal, not silent drift. (#62)
    if (operations.some((op) => op.type === 'drop_function')) {
      await warnCascadeFunctionDrops(config, logger, operations, desired);
    }
  }

  // Re-plan against the post-pre-script DB state. Pre-scripts can mutate the
  // DB in ways the original plan can't reflect (e.g. column renames the
  // planner cannot express declaratively). Without this, the apply phase
  // collides with state pre-scripts already established. (Issue #28.)
  const desiredForReplan = desired;
  const replanAfterPreScripts =
    shouldMigrate && desiredForReplan
      ? async () => {
          const actual = await introspectDatabase(config, logger);
          const plan = buildPlan(desiredForReplan, actual, {
            allowDestructive: config.allowDestructive,
            pgSchema: config.pgSchema,
          });
          return plan.operations;
        }
      : undefined;

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
    replanAfterPreScripts,
    perTxSqlPath: config.perTxSqlPath,
    bootstrapSession: config.bootstrapSession,
  });

  // 6b. Post-apply convergence. A CASCADE drop (e.g. a function return-type
  //     change) can drop declared policies/views the original plan — built
  //     from a pre-drop snapshot — didn't know to recreate. Re-plan against
  //     the post-apply DB, re-apply to recreate them, and warn on any residual
  //     so a single `run` converges instead of silently leaving drift. (#62)
  if (!config.dryRun && !validateOnly && shouldMigrate && desired) {
    await convergeAfterApply(config, logger, desired, result.executedOperations);
  }

  // 7. Record schema files in history after successful migration
  if (!config.dryRun && !validateOnly && shouldMigrate && discovered.schema.length > 0) {
    const client = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });
    try {
      await ensureHistoryTable(client);
      for (const file of discovered.schema) {
        await recordFile(client, file.relativePath, file.hash, file.phase, config.pgSchema);
      }
    } finally {
      client.release();
    }
  }

  return result;
}

/**
 * Introspect the live database to get the ActualState.
 */
async function introspectDatabase(config: SimplicitySchemaConfig, logger: Logger): Promise<ActualState> {
  const client = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });

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

    const sequenceGrants = await getSequenceGrants(client, config.pgSchema);

    logger.debug(`Introspected: ${tableNames.length} tables, ${enumList.length} enums, ${fnList.length} functions`);

    return {
      tables: tablesMap,
      enums: enumsMap,
      functions: functionsMap,
      views: viewsMap,
      materializedViews: matViewsMap,
      roles: rolesMap,
      extensions,
      sequenceGrants,
    };
  } finally {
    client.release();
  }
}

/**
 * Warn about objects a planned `DROP FUNCTION … CASCADE` will drop. Declared
 * dependents (in YAML) are logged at debug — the convergence re-plan recreates
 * them. Anything not in the declared set is a hard warning: CASCADE will drop
 * it and nothing will bring it back.
 */
async function warnCascadeFunctionDrops(
  config: SimplicitySchemaConfig,
  logger: Logger,
  operations: Operation[],
  desired: DesiredState,
): Promise<void> {
  const dropFns = operations.filter((op) => op.type === 'drop_function');
  if (dropFns.length === 0) return;

  const declaredViews = new Set<string>([
    ...desired.views.map((v) => v.name),
    ...desired.materializedViews.map((v) => v.name),
  ]);
  const declaredPolicies = new Set<string>(desired.tables.flatMap((t) => (t.policies ?? []).map((p) => p.name)));

  const client = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });
  try {
    for (const op of dropFns) {
      const dependents = await getFunctionDependents(client, config.pgSchema, op.objectName);
      for (const dep of dependents) {
        const isDeclared =
          ((dep.type === 'view' || dep.type === 'materialized view') && declaredViews.has(dep.name)) ||
          (dep.type === 'policy' && declaredPolicies.has(dep.name));
        if (isDeclared) {
          logger.debug(
            `CASCADE drop of function ${op.objectName} will drop declared ${dep.type} ${dep.identity} — it will be recreated`,
          );
        } else {
          logger.warn(
            `CASCADE drop of function ${op.objectName} will drop ${dep.type} ${dep.identity}, which is not declared in the schema — it will be lost and not recreated`,
          );
        }
      }
    }
  } finally {
    client.release();
  }
}

/**
 * After a CASCADE drop ran, re-plan against the live DB and re-apply so
 * declared dependents the snapshot-based plan couldn't recreate get rebuilt in
 * the same `run`. Warn on any residual operations that still don't converge.
 */
async function convergeAfterApply(
  config: SimplicitySchemaConfig,
  logger: Logger,
  desired: DesiredState,
  executedOperations: Operation[],
): Promise<void> {
  // Only the wide destructive case needs this — keep ordinary applies untouched.
  if (!executedOperations.some((op) => op.type === 'drop_function')) return;

  const replan = async (): Promise<Operation[]> => {
    const actual = await introspectDatabase(config, logger);
    return buildPlan(desired, actual, { allowDestructive: config.allowDestructive, pgSchema: config.pgSchema })
      .operations;
  };

  let residual = await replan();
  if (residual.length > 0) {
    logger.info(`Post-apply convergence: recreating ${residual.length} object(s) dropped by CASCADE`);
    await execute({
      connectionString: config.connectionString,
      operations: residual,
      pgSchema: config.pgSchema,
      lockTimeout: config.lockTimeout,
      statementTimeout: config.statementTimeout,
      perTxSqlPath: config.perTxSqlPath,
      logger,
    });
    residual = await replan();
  }

  if (residual.length > 0) {
    logger.warn(`Apply complete, but ${residual.length} operation(s) still pending — run \`plan\` to inspect.`);
  }
}

/**
 * Build desired and actual state for drift/lint/sql/erd use.
 */
export async function buildDesiredAndActual(
  config: SimplicitySchemaConfig,
  logger: Logger,
): Promise<{ desired: DesiredState; actual: ActualState }> {
  const discovered = await discoverAllSources(config);
  const desired = await buildDesiredState(discovered.schema, { importParams: resolveImportParams(config) });

  // Normalize policy expressions via PG round-trip + hydrate actual seeds
  const normClient = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });
  try {
    await normalizePolicyExpressions(normClient, desired.tables);
  } finally {
    normClient.release();
  }

  const actual = await introspectDatabase(config, logger);

  // Hydrate actual seed data from the database for drift comparison
  const seedClient = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });
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
  const client = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });

  try {
    await ensureHistoryTable(client);

    const discovered = await discoverAllSources(config);
    const allFiles = [...discovered.pre, ...discovered.schema, ...discovered.post];

    let recorded = 0;
    for (const file of allFiles) {
      await recordFile(client, file.relativePath, file.hash, file.phase, config.pgSchema);
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
  const client = await acquireClient(config.connectionString, { pgSchema: config.pgSchema });

  try {
    // Ensure history table exists (won't error on fresh DBs)
    await ensureHistoryTable(client);
    const history = await getHistory(client, config.pgSchema);

    // Discover current files
    const discovered = await discoverAllSources(config);
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
