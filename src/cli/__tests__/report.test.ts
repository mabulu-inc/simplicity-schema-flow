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

  it('labels the bootstrap and main phases when bootstrap ops are present (#51)', () => {
    const ops: Operation[] = [
      { type: 'create_table', phase: 6, objectName: 'users', sql: 'CREATE ...', destructive: false, bootstrap: true },
      { type: 'create_table', phase: 6, objectName: 'events', sql: 'CREATE ...', destructive: false },
    ];
    const { write, lines } = capture();
    reportMigrationResult({
      result: emptyResult({ executed: 2, executedOperations: ops }),
      operations: ops,
      mode: 'default',
      write,
    });
    const bootstrapIdx = lines.findIndex((l) => l.startsWith('Bootstrap phase'));
    const mainIdx = lines.findIndex((l) => l === 'Main phase:');
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(bootstrapIdx);
    // The bootstrap header precedes the users op; the main header precedes events.
    expect(lines.findIndex((l) => l.includes('users'))).toBeGreaterThan(bootstrapIdx);
    expect(lines.findIndex((l) => l.includes('events'))).toBeGreaterThan(mainIdx);
  });

  it('omits phase headers when there are no bootstrap ops (#51)', () => {
    const ops: Operation[] = [
      { type: 'create_table', phase: 6, objectName: 'events', sql: 'CREATE ...', destructive: false },
    ];
    const { write, lines } = capture();
    reportMigrationResult({
      result: emptyResult({ executed: 1, executedOperations: ops }),
      operations: ops,
      mode: 'default',
      write,
    });
    expect(lines.some((l) => l.startsWith('Bootstrap phase') || l === 'Main phase:')).toBe(false);
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

  describe('dry-run mode', () => {
    it('renders present-tense verbs and a Plan: summary', () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: 'CREATE TABLE "users" ("id" uuid PRIMARY KEY)',
          destructive: false,
        },
        {
          type: 'add_column',
          phase: 7,
          objectName: 'users.email',
          sql: 'ALTER TABLE "users" ADD COLUMN "email" text',
          destructive: false,
        },
      ];
      const { write, lines } = capture();
      reportMigrationResult({
        result: emptyResult({ dryRun: true, executed: 2, executedOperations: ops }),
        operations: ops,
        mode: 'default',
        write,
        dryRun: true,
      });
      expect(lines.some((l) => l.includes('Create table: users'))).toBe(true);
      expect(lines.some((l) => l.includes('Add column: users.email'))).toBe(true);
      expect(lines.some((l) => l === 'Plan: 2 operations would execute')).toBe(true);
      // Default mode must not dump SQL bodies.
      expect(lines.some((l) => l.includes('CREATE TABLE'))).toBe(false);
    });

    it('singularizes the summary when only one op would run', () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: 'CREATE TABLE "users" ("id" uuid)',
          destructive: false,
        },
      ];
      const { write, lines } = capture();
      reportMigrationResult({
        result: emptyResult({ dryRun: true, executed: 1, executedOperations: ops }),
        operations: ops,
        mode: 'default',
        write,
        dryRun: true,
      });
      expect(lines).toContain('Plan: 1 operation would execute');
    });

    it('dumps SQL under each op in verbose mode', () => {
      const ops: Operation[] = [
        {
          type: 'create_table',
          phase: 6,
          objectName: 'users',
          sql: 'CREATE TABLE "users" (\n  "id" uuid PRIMARY KEY\n)',
          destructive: false,
        },
      ];
      const { write, lines } = capture();
      reportMigrationResult({
        result: emptyResult({ dryRun: true, executed: 1, executedOperations: ops }),
        operations: ops,
        mode: 'verbose',
        write,
        dryRun: true,
      });
      expect(lines.some((l) => l.includes('CREATE TABLE "users"'))).toBe(true);
      expect(lines.some((l) => l.includes('"id" uuid PRIMARY KEY'))).toBe(true);
    });

    it('labels pre/post script counts as "would run" and shows skipped counts', () => {
      const { write, lines } = capture();
      reportMigrationResult({
        result: emptyResult({
          dryRun: true,
          preScriptsRun: 2,
          postScriptsRun: 1,
          skippedScripts: 3,
        }),
        operations: [],
        mode: 'default',
        write,
        dryRun: true,
      });
      expect(lines).toContain('Plan: 0 operations would execute');
      expect(lines).toContain('  Pre-scripts: 2 (would run)');
      expect(lines).toContain('  Post-scripts: 1 (would run)');
      expect(lines).toContain('  Skipped (unchanged): 3');
    });

    it('quiet mode suppresses output when nothing would happen', () => {
      const { write, lines } = capture();
      reportMigrationResult({
        result: emptyResult({ dryRun: true }),
        operations: [],
        mode: 'quiet',
        write,
        dryRun: true,
      });
      expect(lines).toHaveLength(0);
    });
  });
});
