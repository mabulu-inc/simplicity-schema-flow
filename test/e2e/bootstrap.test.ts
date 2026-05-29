import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTestProject, writeSchema, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

/**
 * Bootstrap phase (#51): a table marked `bootstrap: true` (plus its seeds) is
 * applied in a transaction that COMMITS before the main apply tx, so per-tx
 * hooks opening the main tx can resolve the rows seeded here.
 */
describe('E2E: bootstrap phase', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('commits bootstrap rows before the main tx so the per-tx hook resolves them', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Lenient per-tx hook: if `users` exists, resolve the app-init service user
    // and stamp app.actor_id. On a fresh DB it's a no-op until users is seeded.
    const perTxPath = path.join(ctx.dir, 'per-tx.sql');
    fs.writeFileSync(
      perTxPath,
      `DO $$
       DECLARE aid int;
       BEGIN
         IF to_regclass('users') IS NOT NULL THEN
           SELECT user_id INTO aid FROM users WHERE name = 'app-init' LIMIT 1;
           IF aid IS NOT NULL THEN PERFORM set_config('app.actor_id', aid::text, true); END IF;
         END IF;
       END $$;`,
    );

    writeSchema(ctx.dir, {
      // Audit trigger function: stamp created_by from the per-tx actor GUC.
      'pre/01_audit.sql': `
        CREATE OR REPLACE FUNCTION "${ctx.schema}".audit_stamp() RETURNS trigger AS $$
        BEGIN
          NEW.created_by := nullif(current_setting('app.actor_id', true), '')::int;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      // Bootstrap table — created and seeded in the bootstrap tx.
      'tables/users.yaml': `
table: users
bootstrap: true
columns:
  - { name: user_id, type: serial, primary_key: true }
  - { name: name, type: varchar(100), nullable: false }
seeds:
  - { name: app-init }
`,
      // Main-phase table whose seed is audit-stamped by the trigger.
      'tables/events.yaml': `
table: events
columns:
  - { name: id, type: serial, primary_key: true }
  - { name: label, type: text, nullable: false }
  - { name: created_by, type: int }
triggers:
  - { name: events_stamp, timing: BEFORE, events: [INSERT], function: audit_stamp }
seeds:
  - { id: 1, label: e1 }
`,
    });

    await runPipeline({ ...ctx.config, perTxSqlPath: perTxPath }, logger);

    const users = await queryDb(ctx, `SELECT user_id FROM "${ctx.schema}".users WHERE name = 'app-init'`);
    const events = await queryDb(ctx, `SELECT created_by FROM "${ctx.schema}".events WHERE id = 1`);
    // The main-tx seed was stamped with the bootstrap-committed app-init id —
    // only possible if the bootstrap tx committed before the main tx's hook ran.
    expect(events.rows[0].created_by).not.toBeNull();
    expect(events.rows[0].created_by).toBe(users.rows[0].user_id);
  });

  it('sets smplcty.bootstrap and declared bootstrapSession GUCs during the bootstrap tx', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'pre/01_log.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}".guc_log (key text PRIMARY KEY, val text);
        CREATE OR REPLACE FUNCTION "${ctx.schema}".log_gucs() RETURNS trigger AS $$
        BEGIN
          INSERT INTO "${ctx.schema}".guc_log (key, val) VALUES
            ('smplcty.bootstrap', current_setting('smplcty.bootstrap', true)),
            ('app.audit_lenient', current_setting('app.audit_lenient', true))
          ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      'tables/users.yaml': `
table: users
bootstrap: true
columns:
  - { name: user_id, type: serial, primary_key: true }
  - { name: name, type: varchar(100), nullable: false }
triggers:
  - { name: users_log_gucs, timing: AFTER, events: [INSERT], function: log_gucs }
seeds:
  - { name: app-init }
`,
    });

    await runPipeline({ ...ctx.config, bootstrapSession: { 'app.audit_lenient': true } }, logger);

    const log = await queryDb(ctx, `SELECT key, val FROM "${ctx.schema}".guc_log ORDER BY key`);
    expect(log.rows).toEqual([
      { key: 'app.audit_lenient', val: 'true' },
      { key: 'smplcty.bootstrap', val: 'true' },
    ]);
  });

  it('rejects at plan time a bootstrap table with an FK to a non-bootstrap table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
bootstrap: true
columns:
  - { name: user_id, type: serial, primary_key: true }
  - { name: org_id, type: int, references: { table: orgs, column: id } }
`,
      'tables/orgs.yaml': `
table: orgs
columns:
  - { name: id, type: serial, primary_key: true }
`,
    });

    await expect(runPipeline({ ...ctx.config }, logger)).rejects.toThrow(
      /bootstrap table "users".*non-bootstrap table "orgs"/i,
    );
  });
});
