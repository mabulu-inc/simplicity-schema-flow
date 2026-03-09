import type { ConfigOverrides } from '../core/config.js';

const VALID_COMMANDS = ['run', 'plan', 'validate', 'status', 'init', 'help'] as const;
const RUN_SUBCOMMANDS = ['pre', 'migrate', 'post'] as const;

export type Command = (typeof VALID_COMMANDS)[number] | 'version' | 'unknown';
export type RunSubcommand = (typeof RUN_SUBCOMMANDS)[number];

export interface ParsedArgs {
  command: Command;
  subcommand?: RunSubcommand;
  overrides: ConfigOverrides;
  unknownCommand?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node and script path
  const overrides: ConfigOverrides = {};
  let command: Command = 'help';
  let subcommand: RunSubcommand | undefined;
  let unknownCommand: string | undefined;

  let i = 0;

  // Check for --help or --version before command
  if (args.length === 0) {
    return { command: 'help', overrides };
  }

  // Find command (first non-flag arg)
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '--help' || args[i] === '-h') {
      return { command: 'help', overrides };
    }
    if (args[i] === '--version' || args[i] === '-v') {
      return { command: 'version', overrides };
    }
    // Skip flag + value
    i += flagTakesValue(args[i]) ? 2 : 1;
  }

  if (i < args.length) {
    const cmd = args[i];
    if (cmd === '--help' || cmd === '-h') {
      command = 'help';
    } else if (cmd === '--version' || cmd === '-v') {
      command = 'version';
    } else if ((VALID_COMMANDS as readonly string[]).includes(cmd)) {
      command = cmd as Command;
    } else {
      command = 'unknown';
      unknownCommand = cmd;
    }
    i++;
  }

  // Check for run subcommand
  if (command === 'run' && i < args.length && !args[i].startsWith('-')) {
    const sub = args[i];
    if ((RUN_SUBCOMMANDS as readonly string[]).includes(sub)) {
      subcommand = sub as RunSubcommand;
      i++;
    }
  }

  // Parse flags
  while (i < args.length) {
    const flag = args[i];
    switch (flag) {
      case '--connection-string':
      case '--db':
        overrides.connectionString = args[++i];
        break;
      case '--dir':
        overrides.baseDir = args[++i];
        break;
      case '--schema':
        overrides.pgSchema = args[++i];
        break;
      case '--env':
        overrides.env = args[++i];
        break;
      case '--lock-timeout':
        overrides.lockTimeout = parseInt(args[++i], 10);
        break;
      case '--statement-timeout':
        overrides.statementTimeout = parseInt(args[++i], 10);
        break;
      case '--max-retries':
        overrides.maxRetries = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        overrides.dryRun = true;
        break;
      case '--allow-destructive':
        overrides.allowDestructive = true;
        break;
      case '--skip-checks':
        overrides.skipChecks = true;
        break;
      case '--verbose':
        overrides.verbose = true;
        break;
      case '--quiet':
        overrides.quiet = true;
        break;
      case '--json':
        overrides.json = true;
        break;
      case '--help':
      case '-h':
        // Already handled above
        break;
      default:
        // Ignore unknown flags
        break;
    }
    i++;
  }

  const result: ParsedArgs = { command, overrides };
  if (subcommand) result.subcommand = subcommand;
  if (unknownCommand) result.unknownCommand = unknownCommand;
  return result;
}

function flagTakesValue(flag: string): boolean {
  return [
    '--connection-string', '--db', '--dir', '--schema', '--env',
    '--lock-timeout', '--statement-timeout', '--max-retries',
  ].includes(flag);
}
