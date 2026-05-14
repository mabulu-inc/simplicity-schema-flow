import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));

export function getHelpText(): string {
  return `schema-flow — Declarative PostgreSQL schema management

Usage: schema-flow <command> [options]

Commands:
  run                  Run full migration (pre → migrate → post)
  run pre              Run only pre-scripts
  run migrate          Run only schema migration phase
  run post             Run only post-scripts
  plan                 Dry-run — show planned operations without executing
  validate             Execute plan in a rollback transaction to verify SQL validity
  status               Show migration status (applied files, pending changes)
  backfill             Drain pending expand-column backfills
  contract             Complete expand/contract by dropping the old column
  expand-status        Show in-progress expand/contract migrations
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
  --per-tx-sql         SQL file injected at the start of every executor transaction (e.g. SET LOCAL for audit triggers)
  --verbose            Verbose output
  --quiet              Suppress non-error output
  --json               Output in JSON format
  --version            Show version
  --help               Show this help message`;
}

const COMMON_DB_FLAGS = `  --connection-string  PostgreSQL connection string
  --db                 Alias for --connection-string
  --dir                Root schema directory (default: ./schema)
  --schema             Target PostgreSQL schema (default: public)
  --env                Config file environment to use
  --verbose            Verbose output
  --quiet              Suppress non-error output
  --json               Output in JSON format
  --help               Show this help message`;

const EXECUTION_FLAGS = `  --lock-timeout       Lock acquisition timeout in ms (default: 5000)
  --statement-timeout  Statement execution timeout in ms (default: 30000)
  --max-retries        Max retries on transient errors (default: 3)
  --per-tx-sql         SQL file injected at the start of every executor transaction (e.g. SET LOCAL for audit triggers)`;

const commandHelp: Record<string, string> = {
  run: `schema-flow run — Run full migration pipeline

Executes the complete migration pipeline: pre-scripts → schema migration → post-scripts.

Usage: schema-flow run [options]

Options:
  --dry-run            Plan only, don't execute
  --allow-destructive  Allow drops and destructive changes
  --skip-checks        Skip pre-migration checks
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow run
  schema-flow run --db postgres://localhost/mydb
  schema-flow run --dry-run --verbose`,

  'run pre': `schema-flow run pre — Run only pre-scripts

Executes only the pre-migration scripts phase.

Usage: schema-flow run pre [options]

Options:
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow run pre
  schema-flow run pre --db postgres://localhost/mydb`,

  'run migrate': `schema-flow run migrate — Run only schema migration

Executes only the schema migration phase (no pre/post scripts).

Usage: schema-flow run migrate [options]

Options:
  --dry-run            Plan only, don't execute
  --allow-destructive  Allow drops and destructive changes
  --skip-checks        Skip pre-migration checks
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow run migrate
  schema-flow run migrate --allow-destructive`,

  'run post': `schema-flow run post — Run only post-scripts

Executes only the post-migration scripts phase.

Usage: schema-flow run post [options]

Options:
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow run post
  schema-flow run post --db postgres://localhost/mydb`,

  plan: `schema-flow plan — Show planned operations

Performs a dry-run and displays the operations that would be executed without making any changes.

Usage: schema-flow plan [options]

Options:
  --allow-destructive  Include destructive operations in the plan
${COMMON_DB_FLAGS}

Examples:
  schema-flow plan
  schema-flow plan --db postgres://localhost/mydb --verbose`,

  validate: `schema-flow validate — Validate SQL in a rollback transaction

Executes the migration plan inside a transaction that is always rolled back, verifying that all generated SQL is valid.

Usage: schema-flow validate [options]

Options:
  --allow-destructive  Allow destructive operations in validation
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow validate
  schema-flow validate --db postgres://localhost/mydb`,

  status: `schema-flow status — Show migration status

Displays the current migration status including applied files and pending changes.

Usage: schema-flow status [options]

Options:
${COMMON_DB_FLAGS}

Examples:
  schema-flow status
  schema-flow status --db postgres://localhost/mydb --json`,

  init: `schema-flow init — Initialize a new schema project

Creates the standard schema directory structure with example files.

Usage: schema-flow init [options]

Options:
  --dir                Root schema directory (default: ./schema)
  --help               Show this help message

Examples:
  schema-flow init
  schema-flow init --dir my-schemas`,

  generate: `schema-flow generate — Generate YAML schemas from existing database

Introspects the live database and generates YAML schema files for all discovered objects.

Usage: schema-flow generate [options]

Options:
  --output, --output-dir  Output directory for generated files (default: schema dir)
  --seeds                 Include seed data in generated schemas
${COMMON_DB_FLAGS}

Examples:
  schema-flow generate --db postgres://localhost/mydb
  schema-flow generate --output ./generated --seeds
  schema-flow generate --db postgres://localhost/mydb --json`,

  sql: `schema-flow sql — Generate migration SQL

Produces the SQL that would be executed by a migration run, without executing it.

Usage: schema-flow sql [options]

Options:
  --output, --output-dir  Write SQL to a file instead of stdout
${COMMON_DB_FLAGS}

Examples:
  schema-flow sql --db postgres://localhost/mydb
  schema-flow sql --output migration.sql`,

  erd: `schema-flow erd — Generate entity-relationship diagram

Produces a Mermaid ERD from the YAML schema files.

Usage: schema-flow erd [options]

Options:
  --output, --output-dir  Write ERD to a file instead of stdout
  --dir                   Root schema directory (default: ./schema)
  --help                  Show this help message

Examples:
  schema-flow erd
  schema-flow erd --output schema.mmd`,

  drift: `schema-flow drift — Detect schema drift

Compares the declared YAML schemas against the live database and reports any differences.

Usage: schema-flow drift [options]

Options:
  --apply              Apply fixes to resolve detected drift
  --allow-destructive  Allow destructive fixes when using --apply
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow drift --db postgres://localhost/mydb
  schema-flow drift --apply --allow-destructive`,

  baseline: `schema-flow baseline — Record current state as baseline

Marks all current schema files as already applied without executing them. Useful when adopting schema-flow on an existing database.

Usage: schema-flow baseline [options]

Options:
${COMMON_DB_FLAGS}

Examples:
  schema-flow baseline --db postgres://localhost/mydb
  schema-flow baseline --verbose`,

  down: `schema-flow down — Roll back the last migration

Reverses the most recent migration by applying the stored rollback snapshot.

Usage: schema-flow down [options]

Options:
${EXECUTION_FLAGS}
${COMMON_DB_FLAGS}

Examples:
  schema-flow down --db postgres://localhost/mydb
  schema-flow down --verbose`,

  contract: `schema-flow contract — Run contract phase of expand/contract migration

By default, contracts every expanded column whose backfill is complete
(no rows where new_col IS DISTINCT FROM transform(old)). Rows that still
have divergence are skipped with a log line and reported in the summary —
run \`schema-flow backfill\` to drain them, then re-run contract.

To contract a single column during a careful rollout, pass --table and
--column. The same divergence gate applies.

Usage: schema-flow contract [options]

Options:
  --table <name>                Restrict to migrations on this table
  --column <tbl.col>            Restrict to this specific column
  --force                       Drop old columns even when rows still diverge
  --i-understand-data-loss      Required alongside --force (data-loss confirmation)
${COMMON_DB_FLAGS}

Examples:
  schema-flow contract --db postgres://localhost/mydb
  schema-flow contract --table users --column users.email_lower
  schema-flow contract --force --i-understand-data-loss
  schema-flow contract --json`,

  backfill: `schema-flow backfill — Drain pending expand-column backfills

Iterates expand_state rows with status='expanded' and copies forward via the
transform expression, in batches. Idempotent and resumable — re-runs pick up
where prior invocations left off. Foreground; background with the OS (e.g.
nohup, systemd, or a CI job).

Usage: schema-flow backfill [options]

Options:
  --table <name>        Only backfill columns belonging to this table
  --column <tbl.col>    Only backfill this specific column
  --concurrency N       Backfills to run in parallel (default 1)
${COMMON_DB_FLAGS}

Examples:
  schema-flow backfill
  schema-flow backfill --table users
  schema-flow backfill --concurrency 4
  nohup schema-flow backfill > backfill.log 2>&1 &`,

  'expand-status': `schema-flow expand-status — Show expand/contract migration status

Displays the current state of all expand/contract column migrations, including
the count of rows still pending backfill for expanded columns.

Usage: schema-flow expand-status [options]

Options:
${COMMON_DB_FLAGS}

Examples:
  schema-flow expand-status --db postgres://localhost/mydb
  schema-flow expand-status --json`,

  new: `schema-flow new — Scaffold a new pre-script, post-script, or mixin

Creates a new timestamped script or mixin file from a template.

Usage: schema-flow new <pre|post|mixin> --name <name> [options]

Options:
  --name               Name for the new script or mixin (required)
  --dir                Root schema directory (default: ./schema)
  --help               Show this help message

Examples:
  schema-flow new pre --name add-extension
  schema-flow new post --name backfill-data
  schema-flow new mixin --name timestamps`,

  lint: `schema-flow lint — Lint the migration plan

Analyzes the planned migration operations and reports potential issues or anti-patterns.

Usage: schema-flow lint [options]

Options:
${COMMON_DB_FLAGS}

Examples:
  schema-flow lint --db postgres://localhost/mydb
  schema-flow lint --json`,
};

export function getCommandHelpText(command: string, subcommand?: string): string {
  const key = subcommand ? `${command} ${subcommand}` : command;
  return commandHelp[key] ?? '';
}

export function getVersionText(): string {
  return pkg.version;
}
