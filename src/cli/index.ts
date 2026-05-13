#!/usr/bin/env node

/**
 * CLI entry point for schema-flow.
 */

import { parseArgs } from './args.js';
import { getHelpText, getVersionText, getCommandHelpText } from './help.js';
import { reportMigrationResult, type VerbosityMode } from './report.js';
import { runPipeline, initProject, getStatus, runBaseline, buildDesiredAndActual, getPlan } from './pipeline.js';
import { resolveConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { testConnection, closePool, getPool } from '../core/db.js';
import { detectDrift } from '../drift/index.js';
import { buildPlan } from '../planner/index.js';
import { execute } from '../executor/index.js';
import { lintPlan } from '../lint/index.js';
import { generateSql } from '../sql/index.js';
import { generateErd } from '../erd/index.js';
import { generateFromDb } from '../scaffold/index.js';
import { scaffoldPre, scaffoldPost, scaffoldMixin } from '../scaffold/index.js';
import { runDown } from '../rollback/index.js';
import { runContract, getExpandStatus, runBackfillAll, checkBackfillComplete } from '../expand/index.js';
import * as fs from 'node:fs';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  // Handle help and version before config resolution
  if (parsed.command === 'help') {
    console.log(getHelpText());
    return;
  }

  if (parsed.command === 'version') {
    console.log(getVersionText());
    return;
  }

  if (parsed.helpRequested) {
    const helpText = getCommandHelpText(parsed.command, parsed.subcommand);
    console.log(helpText);
    return;
  }

  if (parsed.command === 'unknown') {
    console.error(`Unknown command: ${parsed.unknownCommand}`);
    console.error('Run "schema-flow help" for usage information.');
    process.exitCode = 1;
    return;
  }

  if (parsed.command === 'docs') {
    console.log('Documentation: https://github.com/mabulu-inc/schema-flow');
    return;
  }

  // Resolve config
  const config = resolveConfig(parsed.overrides);
  const logger = createLogger({
    verbose: config.verbose,
    quiet: config.quiet,
    json: config.json,
  });

  const verbosity: VerbosityMode = config.verbose ? 'verbose' : config.quiet ? 'quiet' : 'default';

  try {
    switch (parsed.command) {
      case 'init': {
        initProject(config.baseDir);
        logger.info(`Initialized schema directory: ${config.baseDir}`);
        break;
      }

      case 'new': {
        if (!parsed.newSubcommand) {
          logger.error('Usage: schema-flow new <pre|post|mixin> --name <name>');
          process.exitCode = 1;
          return;
        }
        const name = parsed.name || 'unnamed';
        let filePath: string;
        switch (parsed.newSubcommand) {
          case 'pre':
            filePath = scaffoldPre(config.baseDir, name);
            break;
          case 'post':
            filePath = scaffoldPost(config.baseDir, name);
            break;
          case 'mixin':
            filePath = scaffoldMixin(config.baseDir, name);
            break;
        }
        logger.info(`Created: ${filePath}`);
        break;
      }

      case 'status': {
        // Test connection first
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const status = await getStatus(config, logger);
        if (config.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          logger.info(`Applied files: ${status.appliedFiles}`);
          logger.info(`Pending changes: ${status.pendingChanges}`);
          if (status.history.length > 0 && config.verbose) {
            for (const entry of status.history) {
              logger.debug(`  ${entry.filePath} (${entry.phase}) — ${entry.appliedAt.toISOString()}`);
            }
          }
        }
        break;
      }

      case 'plan': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const result = await runPipeline({ ...config, dryRun: true }, logger);

        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'validate': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const result = await runPipeline(config, logger, { validateOnly: true });
        if (result.validated) {
          logger.info('Validation passed — all operations are valid SQL');
        }
        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'baseline': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const baselineResult = await runBaseline(config, logger);
        if (config.json) {
          console.log(JSON.stringify(baselineResult, null, 2));
        }
        break;
      }

      case 'drift': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const { desired, actual } = await buildDesiredAndActual(config, logger);
        const report = detectDrift(desired, actual);

        if (config.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          if (report.items.length > 0) {
            logger.warn(`Drift detected: ${report.summary.total} difference(s)`);
            for (const item of report.items) {
              logger.info(`  ${item.type}: ${item.object} [${item.status}]${item.detail ? ' — ' + item.detail : ''}`);
            }
          } else {
            logger.info('No drift detected');
          }
        }

        // --apply: generate fix operations and execute them
        if (parsed.apply && report.items.length > 0) {
          const plan = buildPlan(desired, actual, {
            allowDestructive: config.allowDestructive,
            pgSchema: config.pgSchema,
          });

          if (plan.blocked.length > 0) {
            for (const op of plan.blocked) {
              logger.warn(`Blocked (destructive): ${op.type} ${op.objectName} — use --allow-destructive to allow`);
            }
          }

          if (plan.operations.length > 0) {
            const result = await execute({
              connectionString: config.connectionString,
              operations: plan.operations,
              pgSchema: config.pgSchema,
              dryRun: config.dryRun,
              lockTimeout: config.lockTimeout,
              statementTimeout: config.statementTimeout,
              logger,
            });
            if (config.json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              reportMigrationResult({
                result,
                operations: result.executedOperations,
                mode: verbosity,
                write: (msg) => logger.info(msg),
              });
            }
          } else if (plan.blocked.length > 0) {
            logger.warn('No operations applied — all fixes are destructive. Use --allow-destructive to apply.');
          }
        }
        break;
      }

      case 'lint': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const plan = await getPlan(config, logger);
        const lintResult = lintPlan(plan);

        if (config.json) {
          console.log(JSON.stringify(lintResult, null, 2));
        } else {
          if (lintResult.warnings.length === 0) {
            logger.info('No lint warnings');
          } else {
            for (const w of lintResult.warnings) {
              logger.warn(`[${w.rule}] ${w.message}`);
            }
          }
        }
        break;
      }

      case 'generate': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const pool = getPool(config.connectionString);
        const client = await pool.connect();
        try {
          const {
            getExistingTables,
            getExistingEnums,
            getExistingFunctions,
            getExistingViews,
            getExistingMaterializedViews,
            getExistingRoles,
            introspectTable,
          } = await import('../introspect/index.js');
          const tableNames = await getExistingTables(client, config.pgSchema);
          const enumList = await getExistingEnums(client, config.pgSchema);
          const fnList = await getExistingFunctions(client, config.pgSchema);
          const viewList = await getExistingViews(client, config.pgSchema);
          const matViewList = await getExistingMaterializedViews(client, config.pgSchema);
          const roleList = await getExistingRoles(client);
          const tables = [];
          for (const name of tableNames) {
            tables.push(await introspectTable(client, name, config.pgSchema));
          }
          const files = generateFromDb(
            {
              tables,
              enums: enumList,
              functions: fnList,
              views: viewList,
              materializedViews: matViewList,
              roles: roleList,
            },
            parsed.output ?? config.baseDir,
          );
          if (config.json) {
            console.log(JSON.stringify(files, null, 2));
          } else {
            logger.info(`Generated ${files.length} files`);
          }
        } finally {
          client.release();
        }
        break;
      }

      case 'sql': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const sqlPlan = await getPlan(config, logger);
        const sql = generateSql(sqlPlan);

        if (parsed.output) {
          fs.writeFileSync(parsed.output, sql, 'utf-8');
          logger.info(`SQL written to ${parsed.output}`);
        } else {
          console.log(sql);
        }
        break;
      }

      case 'erd': {
        const { discoverSchemaFiles } = await import('../core/files.js');
        const { readFile } = await import('node:fs/promises');
        const { parseSchemaFile } = await import('../schema/parser.js');
        const { loadMixins, applyMixins } = await import('../schema/mixins.js');
        const discovered = await discoverSchemaFiles(config.baseDir);
        const tables = [];
        const mixinSchemas = [];
        for (const file of discovered.schema) {
          const content = await readFile(file.absolutePath, 'utf-8');
          const parsed2 = parseSchemaFile(content);
          if (parsed2.kind === 'table') tables.push(parsed2.schema);
          if (parsed2.kind === 'mixin') mixinSchemas.push(parsed2.schema);
        }
        if (mixinSchemas.length > 0) {
          const registry = loadMixins(mixinSchemas);
          for (let j = 0; j < tables.length; j++) {
            tables[j] = applyMixins(tables[j], registry);
          }
        }
        const mermaid = generateErd(tables);

        if (parsed.output) {
          fs.writeFileSync(parsed.output, mermaid, 'utf-8');
          logger.info(`ERD written to ${parsed.output}`);
        } else {
          console.log(mermaid);
        }
        break;
      }

      case 'down': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const downResult = await runDown(config.connectionString, { logger });
        if (config.json) {
          console.log(JSON.stringify(downResult, null, 2));
        } else {
          logger.info(`Rollback complete: ${downResult.executed} operations reversed`);
        }
        break;
      }

      case 'contract': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        if (parsed.force && !parsed.iUnderstandDataLoss) {
          logger.error(
            '`--force` requires `--i-understand-data-loss` (refusing to drop the old column with unbackfilled rows).',
          );
          process.exitCode = 1;
          return;
        }

        // Find the latest expanded migration and contract it
        const contractPool = getPool(config.connectionString);
        const contractClient = await contractPool.connect();
        try {
          const states = await getExpandStatus(contractClient);
          const expanded = states.filter((s) => s.status === 'expanded');
          if (expanded.length === 0) {
            logger.info('No expanded migrations to contract');
            break;
          }
          const latest = expanded[expanded.length - 1];
          // table_name is stored as "schema.table" — split for runContract.
          const tableOnly = latest.table_name.includes('.') ? latest.table_name.split('.').pop()! : latest.table_name;
          const schemaPrefix = latest.table_name.includes('.') ? latest.table_name.split('.')[0] : config.pgSchema;
          const contractResult = await runContract({
            connectionString: config.connectionString,
            tableName: tableOnly,
            newColumn: latest.new_column,
            pgSchema: schemaPrefix,
            force: parsed.force,
            logger,
          });
          if (config.json) {
            console.log(JSON.stringify(contractResult, null, 2));
          } else {
            logger.info('Contract phase complete');
          }
        } finally {
          contractClient.release();
        }
        break;
      }

      case 'backfill': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const backfillResult = await runBackfillAll({
          connectionString: config.connectionString,
          pgSchema: config.pgSchema,
          table: parsed.table,
          column: parsed.column,
          concurrency: parsed.concurrency,
          logger,
        });

        if (config.json) {
          console.log(JSON.stringify(backfillResult, null, 2));
        } else if (backfillResult.processed === 0) {
          logger.info('No expanded columns pending backfill');
        } else {
          logger.info(
            `Backfilled ${backfillResult.totalRowsUpdated} row(s) across ${backfillResult.processed} column(s)`,
          );
        }
        break;
      }

      case 'expand-status': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const pool = getPool(config.connectionString);
        const client = await pool.connect();
        try {
          const states = await getExpandStatus(client);

          // Augment expanded states with the row-divergence count so operators
          // can see backfill progress alongside status.
          type Augmented = (typeof states)[number] & { rows_remaining?: number };
          const augmented: Augmented[] = [];
          for (const s of states) {
            if (s.status === 'expanded') {
              try {
                const rows = await checkBackfillComplete(client, s);
                augmented.push({ ...s, rows_remaining: rows });
              } catch {
                augmented.push({ ...s, rows_remaining: undefined });
              }
            } else {
              augmented.push({ ...s });
            }
          }

          if (config.json) {
            console.log(JSON.stringify(augmented, null, 2));
          } else {
            if (augmented.length === 0) {
              logger.info('No expand/contract migrations in progress');
            } else {
              for (const s of augmented) {
                const tail =
                  s.status === 'expanded' && s.rows_remaining !== undefined
                    ? ` — ${s.rows_remaining} row(s) remaining`
                    : '';
                logger.info(`  ${s.table_name}.${s.old_column} → ${s.new_column}: ${s.status}${tail}`);
              }
            }
          }
        } finally {
          client.release();
        }
        break;
      }

      case 'run': {
        const connected = await testConnection(config.connectionString);
        if (!connected) {
          logger.error('Could not connect to database');
          process.exitCode = 1;
          return;
        }

        const result = await runPipeline(config, logger, {
          phaseFilter: parsed.subcommand,
        });

        if (config.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          reportMigrationResult({
            result,
            operations: result.executedOperations,
            mode: verbosity,
            write: (msg) => logger.info(msg),
          });
        }
        break;
      }
    }
  } catch (err) {
    logger.error((err as Error).message);
    if (config.verbose) {
      logger.error((err as Error).stack ?? '');
    }
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
