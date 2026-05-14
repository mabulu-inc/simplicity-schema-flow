import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTestProject, writeSchema, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';

describe('E2E: --per-tx-sql', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('exposes SET LOCAL values to seeds and audit-style triggers in the same tx', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Prelude: SET LOCAL a session GUC the audit trigger reads.
    const perTxPath = path.join(ctx.dir, 'per-tx.sql');
    fs.writeFileSync(perTxPath, `SET LOCAL "app.user_id" = 'schema-flow:test-actor';`);

    writeSchema(ctx.dir, {
      // pre-script creates the audit-log table and a trigger that copies the
      // current GUC into the inserted row.
      'pre/01_audit.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}"."widgets_audit" (
          id serial PRIMARY KEY,
          label text NOT NULL,
          actor text NOT NULL
        );
        CREATE OR REPLACE FUNCTION "${ctx.schema}".log_widget() RETURNS trigger AS $$
        BEGIN
          INSERT INTO "${ctx.schema}"."widgets_audit" (label, actor)
          VALUES (NEW.label, current_setting('app.user_id', true));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: id
    type: serial
    primary_key: true
  - name: label
    type: text
    nullable: false
triggers:
  - name: widgets_after_insert
    timing: AFTER
    events: [INSERT]
    function: log_widget
seeds:
  - id: 1
    label: w1
`,
    });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    await runPipeline({ ...ctx.config, perTxSqlPath: perTxPath }, logger);

    const audit = await queryDb(ctx, `SELECT label, actor FROM "${ctx.schema}"."widgets_audit" ORDER BY id`);
    expect(audit.rows).toEqual([{ label: 'w1', actor: 'schema-flow:test-actor' }]);
  });

  it('throws when the file does not exist', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/anything.yaml': `
table: anything
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    await expect(
      runPipeline({ ...ctx.config, perTxSqlPath: '/tmp/does-not-exist-per-tx.sql' }, logger),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it('does nothing under --dry-run', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Bogus SQL — would error if it actually ran.
    const perTxPath = path.join(ctx.dir, 'per-tx.sql');
    fs.writeFileSync(perTxPath, `INSERT INTO "${ctx.schema}"."does_not_exist" VALUES (1);`);

    writeSchema(ctx.dir, {
      'tables/placeholder.yaml': `
table: placeholder
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    await runPipeline({ ...ctx.config, perTxSqlPath: perTxPath, dryRun: true }, logger);
    // No throw = success: the bogus SQL was logged but never executed.
  });
});
