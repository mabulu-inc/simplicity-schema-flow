/**
 * Migration result reporting with verbosity modes.
 */

import type { Operation } from '../planner/index.js';
import type { ExecuteResult } from '../executor/index.js';
import { formatOperationMessage } from '../executor/format-operation.js';

export type VerbosityMode = 'quiet' | 'default' | 'verbose';

export interface ReportOptions {
  result: ExecuteResult;
  operations: Operation[];
  mode: VerbosityMode;
  write: (msg: string) => void;
  /**
   * Render as a plan preview rather than a completion summary: present-tense
   * verbs ("Create table" not "Created table"), a "Plan:" header, and SQL
   * dumped under each op in verbose mode for review.
   */
  dryRun?: boolean;
}

export function reportMigrationResult(options: ReportOptions): void {
  const { result, operations, mode, write, dryRun = false } = options;

  // Quiet mode: nothing on zero changes
  if (mode === 'quiet' && operations.length === 0 && result.preScriptsRun === 0 && result.postScriptsRun === 0) {
    return;
  }

  // Default and verbose: show per-step change lines in true execution order —
  // pre-scripts, the declarative apply, post-scripts, then the NOT NULL tighten
  // phase (which runs after post-scripts). The executor records only counts and
  // ordered lists on `result`; this renderer is the single place output is
  // formatted, so scripts and ops never interleave the way live logging would.
  if (mode === 'default' || mode === 'verbose') {
    const verb = dryRun ? 'Would run' : 'Ran';
    // tighten_not_null ops execute after post-scripts, so split them out and
    // print them last to keep the stream chronological.
    const applyOps = operations.filter((op) => op.type !== 'tighten_not_null');
    const tightenOps = operations.filter((op) => op.type === 'tighten_not_null');

    for (const path of result.executedPreScripts) {
      write(`  ${verb} pre-script: ${path}`);
    }
    renderOps(applyOps, mode, dryRun, write);
    for (const path of result.executedPostScripts) {
      write(`  ${verb} post-script: ${path}`);
    }
    renderOps(tightenOps, mode, dryRun, write);
  }

  // Summary line
  const opCount = operations.length;
  if (dryRun) {
    write(`Plan: ${opCount} operation${opCount === 1 ? '' : 's'} would execute`);
  } else {
    write(`Migration complete: ${result.executed} operations executed`);
  }

  // Script counts
  if (result.preScriptsRun > 0) {
    write(`  Pre-scripts: ${result.preScriptsRun}${dryRun ? ' (would run)' : ''}`);
  }
  if (result.postScriptsRun > 0) {
    write(`  Post-scripts: ${result.postScriptsRun}${dryRun ? ' (would run)' : ''}`);
  }
  if (result.skippedScripts > 0) {
    write(`  Skipped (unchanged): ${result.skippedScripts}`);
  }
}

/**
 * Render a run of operations with bootstrap/main phase headers. When a
 * bootstrap phase is present, label it and the main phase so the two
 * transactions read distinctly; headers are skipped when there are no
 * bootstrap ops, keeping ordinary output unchanged.
 */
function renderOps(ops: Operation[], mode: VerbosityMode, dryRun: boolean, write: (msg: string) => void): void {
  const hasBootstrap = ops.some((op) => op.bootstrap);
  let lastHeader: 'bootstrap' | 'main' | null = null;
  for (const op of ops) {
    // In default mode, skip seed ops that wrote nothing — the line would read
    // "Seeded: X (N unchanged)" which is noise. Still shown in verbose.
    if (mode === 'default' && isNoOpSeed(op)) continue;
    if (hasBootstrap) {
      const header = op.bootstrap ? 'bootstrap' : 'main';
      if (header !== lastHeader) {
        write(header === 'bootstrap' ? 'Bootstrap phase (separate transaction):' : 'Main phase:');
        lastHeader = header;
      }
    }
    write(`  ${formatOperationMessage(op, { dryRun })}`);
    if (dryRun && mode === 'verbose') {
      for (const line of op.sql.split('\n')) {
        write(`      ${line}`);
      }
    }
  }
}

function isNoOpSeed(op: Operation): boolean {
  if (op.type !== 'seed_table') return false;
  if (!op.seedResult) return false;
  return op.seedResult.inserted === 0;
}
