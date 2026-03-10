#!/usr/bin/env node

/**
 * CLI entry point for simplicity-schema.
 */

import { parseArgs } from './args.js';
import { getHelpText, getVersionText } from './help.js';
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
import { runContract, getExpandStatus } from '../expand/index.js';
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

  if (parsed.command === 'unknown') {
    console.error(`Unknown command: ${parsed.unknownCommand}`);
    console.error('Run "simplicity-schema help" for usage information.');
    process.exitCode = 1;
    return;
  }

  if (parsed.command === 'docs') {
    console.log('Documentation: https://github.com/mabulu-inc/simplicity-schema');
    return;
  }

  // Resolve config
  const config = resolveConfig(parsed.overrides);
  const logger = createLogger({
    verbose: config.verbose,
    quiet: config.quiet,
    json: config.json,
  });

  try {
    switch (parsed.command) {
      case 'init': {
        initProject(config.baseDir);
        logger.info(`Initialized schema directory: ${config.baseDir}`);
        break;
      }

      case 'new': {
        if (!parsed.newSubcommand) {
          logger.error('Usage: simplicity-schema new <pre|post|mixin> --name <name>');
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
            logger.info(`Applied ${result.executed} fix operations`);
            if (config.json) {
              console.log(JSON.stringify(result, null, 2));
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
          const [tableNames, enumList, fnList, viewList, matViewList, roleList] = await Promise.all([
            getExistingTables(client, config.pgSchema),
            getExistingEnums(client, config.pgSchema),
            getExistingFunctions(client, config.pgSchema),
            getExistingViews(client, config.pgSchema),
            getExistingMaterializedViews(client, config.pgSchema),
            getExistingRoles(client),
          ]);
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
            parsed.output,
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
          const contractResult = await runContract({
            connectionString: config.connectionString,
            tableName: latest.table_name,
            newColumn: latest.new_column,
            pgSchema: config.pgSchema,
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
          if (config.json) {
            console.log(JSON.stringify(states, null, 2));
          } else {
            if (states.length === 0) {
              logger.info('No expand/contract migrations in progress');
            } else {
              for (const s of states) {
                logger.info(`  ${s.table_name}.${s.old_column} → ${s.new_column}: ${s.status}`);
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
          logger.info(`Migration complete: ${result.executed} operations executed`);
          if (result.preScriptsRun > 0) logger.info(`  Pre-scripts: ${result.preScriptsRun}`);
          if (result.postScriptsRun > 0) logger.info(`  Post-scripts: ${result.postScriptsRun}`);
          if (result.skippedScripts > 0) logger.info(`  Skipped (unchanged): ${result.skippedScripts}`);
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
