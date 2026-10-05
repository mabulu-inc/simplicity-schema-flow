import { describe, it, expect, afterAll } from 'vitest';
import { useTestProject, writeSchema } from '../testing/index.js';
import { runPipeline, getStatus } from '../cli/pipeline.js';
import { reportMigrationResult } from '../cli/report.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

const TABLE = `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: n, type: integer }
`;

// `plan` listed pending pre/post scripts but not why they would run, and
// lumped every unchanged script into one "Skipped" count; `status` gave one
// "Applied files" total. Neither said which scripts were outstanding — the
// part of a migrate that rewrites data (issue #75).
describe('pre/post script visibility in plan and status (#75)', () => {
  it('plan names each script that would run, why, and per-phase counts', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': TABLE,
        'pre/a.sql': 'SELECT 1;',
        'post/b.sql': 'UPDATE t SET n = 1;',
        'post/c.sql': 'UPDATE t SET n = 2;',
      });
      await project.migrate();

      writeSchema(project.dir, {
        'post/b.sql': 'UPDATE t SET n = 10;',
        'post/d.sql': 'UPDATE t SET n = 3;',
      });

      const result = await runPipeline({ ...project.config, dryRun: true }, logger);
      expect(result.executedPreScripts).toEqual([]);
      expect(result.executedPostScripts).toEqual(['post/b.sql', 'post/d.sql']);
      expect(result.scriptChanges).toEqual({ 'post/b.sql': 'changed', 'post/d.sql': 'new' });
      expect(result.skippedPreScripts).toBe(1);
      expect(result.skippedPostScripts).toBe(1);

      const lines: string[] = [];
      reportMigrationResult({
        result,
        operations: result.executedOperations,
        mode: 'default',
        write: (l) => lines.push(l),
        dryRun: true,
      });
      expect(lines).toEqual([
        '  Would run post-script: post/b.sql (changed since applied)',
        '  Would run post-script: post/d.sql (never applied)',
        'Plan: 0 operations would execute',
        '  Pre-scripts: 0 would run, 1 already applied',
        '  Post-scripts: 2 would run, 1 already applied',
      ]);
    } finally {
      await project.cleanup();
    }
  });

  it('status breaks applied files down by phase and names what is pending', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/t.yaml': TABLE,
        'pre/a.sql': 'SELECT 1;',
        'post/b.sql': 'UPDATE t SET n = 1;',
      });
      await project.migrate();

      writeSchema(project.dir, {
        'post/b.sql': 'UPDATE t SET n = 10;',
        'post/c.sql': 'UPDATE t SET n = 2;',
      });

      const status = await getStatus(project.config, logger);
      expect(status.appliedFiles).toBe(3);
      expect(status.appliedByPhase).toEqual({ pre: 1, schema: 1, post: 1 });
      expect(status.pendingChanges).toBe(2);
      expect(status.pending).toEqual([
        { filePath: 'post/b.sql', phase: 'post', change: 'changed' },
        { filePath: 'post/c.sql', phase: 'post', change: 'new' },
      ]);
    } finally {
      await project.cleanup();
    }
  });
});
