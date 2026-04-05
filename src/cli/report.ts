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
}

export function reportMigrationResult(options: ReportOptions): void {
  const { result, operations, mode, write } = options;

  // Quiet mode: nothing on zero changes
  if (mode === 'quiet' && result.executed === 0 && result.preScriptsRun === 0 && result.postScriptsRun === 0) {
    return;
  }

  // Default and verbose: show per-operation change lines
  if (mode === 'default' || mode === 'verbose') {
    for (const op of operations) {
      write(`  ${formatOperationMessage(op)}`);
    }
  }

  // Summary line
  write(`Migration complete: ${result.executed} operations executed`);

  // Script counts
  if (result.preScriptsRun > 0) {
    write(`  Pre-scripts: ${result.preScriptsRun}`);
  }
  if (result.postScriptsRun > 0) {
    write(`  Post-scripts: ${result.postScriptsRun}`);
  }
  if (result.skippedScripts > 0) {
    write(`  Skipped (unchanged): ${result.skippedScripts}`);
  }
}
