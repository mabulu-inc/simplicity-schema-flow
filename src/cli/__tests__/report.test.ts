import { describe, it, expect } from 'vitest';
import { reportMigrationResult } from '../report.js';
import type { Operation } from '../../planner/index.js';
import type { ExecuteResult } from '../../executor/index.js';

function emptyResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    executed: 0,
    skippedScripts: 0,
    preScriptsRun: 0,
    postScriptsRun: 0,
    dryRun: false,
    validated: false,
    executedOperations: [],
    ...overrides,
  };
}

function capture(): { write: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (m: string) => lines.push(m), lines };
}

describe('reportMigrationResult', () => {
  // Regression for mabulu-inc/simplicity-schema-flow#17 Issue 3:
  // "Seeded: timezones (418 unchanged)" used to log on every run even when
  // nothing was written. In default mode the line is noise; in verbose we
  // still show it for debugging.
  it('suppresses no-op seed ops in default mode', () => {
    const ops: Operation[] = [
      {
        type: 'seed_table',
        phase: 10,
        objectName: 'timezones',
        sql: 'INSERT ...',
        destructive: false,
        seedResult: { inserted: 0, updated: 0, unchanged: 418 },
      },
    ];
    const { write, lines } = capture();
    reportMigrationResult({
      result: emptyResult({ executed: 1, executedOperations: ops }),
      operations: ops,
      mode: 'default',
      write,
    });
    expect(lines.some((l) => l.includes('timezones'))).toBe(false);
  });

  it('still shows no-op seed ops in verbose mode', () => {
    const ops: Operation[] = [
      {
        type: 'seed_table',
        phase: 10,
        objectName: 'timezones',
        sql: 'INSERT ...',
        destructive: false,
        seedResult: { inserted: 0, updated: 0, unchanged: 418 },
      },
    ];
    const { write, lines } = capture();
    reportMigrationResult({
      result: emptyResult({ executed: 1, executedOperations: ops }),
      operations: ops,
      mode: 'verbose',
      write,
    });
    expect(lines.some((l) => l.includes('timezones') && l.includes('418 unchanged'))).toBe(true);
  });

  it('logs seed ops that actually wrote rows in default mode', () => {
    const ops: Operation[] = [
      {
        type: 'seed_table',
        phase: 10,
        objectName: 'api_types',
        sql: 'INSERT ...',
        destructive: false,
        seedResult: { inserted: 2, updated: 0, unchanged: 1 },
      },
    ];
    const { write, lines } = capture();
    reportMigrationResult({
      result: emptyResult({ executed: 1, executedOperations: ops }),
      operations: ops,
      mode: 'default',
      write,
    });
    expect(lines.some((l) => l.includes('api_types') && l.includes('2 inserted'))).toBe(true);
  });
});
