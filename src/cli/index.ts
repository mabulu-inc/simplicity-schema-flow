#!/usr/bin/env node

/**
 * CLI entry point for simplicity-schema.
 */

import { parseArgs } from './args.js';
import { getHelpText, getVersionText } from './help.js';
import { runPipeline, initProject, getStatus } from './pipeline.js';
import { resolveConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { testConnection, closePool } from '../core/db.js';

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

        const result = await runPipeline(
          { ...config, dryRun: true },
          logger,
        );

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
