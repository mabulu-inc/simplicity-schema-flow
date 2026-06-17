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

  // Default and verbose: show per-operation change lines.
  // In default mode, skip seed ops that wrote nothing — the line would
  // read "Seeded: X (N unchanged)" which is noise. Still shown in verbose.
  if (mode === 'default' || mode === 'verbose') {
    // When a bootstrap phase is present, label it and the main phase so the
    // two transactions read distinctly. Headers are skipped when there are no
    // bootstrap ops, keeping ordinary output unchanged.
    const hasBootstrap = operations.some((op) => op.bootstrap);
    let lastHeader: 'bootstrap' | 'main' | null = null;
    for (const op of operations) {
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

function isNoOpSeed(op: Operation): boolean {
  if (op.type !== 'seed_table') return false;
  if (!op.seedResult) return false;
  return op.seedResult.inserted === 0;
}
