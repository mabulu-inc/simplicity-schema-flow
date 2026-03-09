export function getHelpText(): string {
  return `simplicity-schema — Declarative PostgreSQL schema management

Usage: simplicity-schema <command> [options]

Commands:
  run                  Run full migration (pre → migrate → post)
  run pre              Run only pre-scripts
  run migrate          Run only schema migration phase
  run post             Run only post-scripts
  plan                 Dry-run — show planned operations without executing
  validate             Execute plan in a rollback transaction to verify SQL validity
  status               Show migration status (applied files, pending changes)
  init                 Initialize a new schema project directory
  help                 Show this help message

Options:
  --connection-string  PostgreSQL connection string
  --db                 Alias for --connection-string
  --dir                Root schema directory (default: ./schema)
  --schema             Target PostgreSQL schema (default: public)
  --env                Config file environment to use
  --dry-run            Plan only, don't execute
  --allow-destructive  Allow drops and destructive changes
  --skip-checks        Skip pre-migration checks
  --lock-timeout       Lock acquisition timeout in ms (default: 5000)
  --statement-timeout  Statement execution timeout in ms (default: 30000)
  --max-retries        Max retries on transient errors (default: 3)
  --verbose            Verbose output
  --quiet              Suppress non-error output
  --json               Output in JSON format
  --version            Show version
  --help               Show this help message`;
}

export function getVersionText(): string {
  return '0.1.0';
}
