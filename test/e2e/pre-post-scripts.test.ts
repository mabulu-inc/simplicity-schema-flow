import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Pre/post scripts', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('pre-script runs before schema migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'pre/01_setup.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}"."helpers" (
          "key" text PRIMARY KEY,
          "value" text NOT NULL
        );
        INSERT INTO "${ctx.schema}"."helpers" ("key", "value")
        VALUES ('init', 'true');
      `,
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: label
    type: text
    nullable: false
`,
    });

    const result = await runMigration(ctx);
    expect(result.preScriptsRun).toBe(1);

    await assertTableExists(ctx, 'helpers');
    await assertTableExists(ctx, 'items');

    const rows = await queryDb(ctx, `SELECT "value" FROM "${ctx.schema}"."helpers" WHERE "key" = 'init'`);
    expect(rows.rows[0].value).toBe('true');
  });

  it('post-script runs after schema migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
`,
      'post/01_seed.sql': `
        INSERT INTO "${ctx.schema}"."products" ("name")
        VALUES ('Widget'), ('Gadget');
      `,
    });

    const result = await runMigration(ctx);
    expect(result.postScriptsRun).toBe(1);

    const rows = await queryDb(ctx, `SELECT "name" FROM "${ctx.schema}"."products" ORDER BY "name"`);
    expect(rows.rows.map((r: { name: string }) => r.name)).toEqual(['Gadget', 'Widget']);
  });

  it('scripts run in alphabetical order', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'pre/01_first.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}"."run_order" (
          "seq" serial PRIMARY KEY,
          "step" text NOT NULL
        );
        INSERT INTO "${ctx.schema}"."run_order" ("step") VALUES ('first');
      `,
      'pre/02_second.sql': `
        INSERT INTO "${ctx.schema}"."run_order" ("step") VALUES ('second');
      `,
      'tables/placeholder.yaml': `
table: placeholder
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const result = await runMigration(ctx);
    expect(result.preScriptsRun).toBe(2);

    const rows = await queryDb(ctx, `SELECT "step" FROM "${ctx.schema}"."run_order" ORDER BY "seq"`);
    expect(rows.rows.map((r: { step: string }) => r.step)).toEqual(['first', 'second']);
  });

  it('unchanged scripts skipped on re-run', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'pre/01_setup.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}"."tracker" (
          "id" serial PRIMARY KEY,
          "note" text NOT NULL
        );
        INSERT INTO "${ctx.schema}"."tracker" ("note") VALUES ('run');
      `,
    });

    const first = await runMigration(ctx);
    expect(first.preScriptsRun).toBe(1);
    expect(first.skippedScripts).toBe(0);

    const second = await runMigration(ctx);
    expect(second.preScriptsRun).toBe(0);
    expect(second.skippedScripts).toBe(1);

    const rows = await queryDb(ctx, `SELECT count(*)::int AS cnt FROM "${ctx.schema}"."tracker"`);
    expect(rows.rows[0].cnt).toBe(1);
  });

  it('changed script content triggers re-run', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'pre/01_setup.sql': `
        CREATE TABLE IF NOT EXISTS "${ctx.schema}"."versions" (
          "id" serial PRIMARY KEY,
          "ver" text NOT NULL
        );
        INSERT INTO "${ctx.schema}"."versions" ("ver") VALUES ('v1');
      `,
    });

    const first = await runMigration(ctx);
    expect(first.preScriptsRun).toBe(1);

    writeSchema(ctx.dir, {
      'pre/01_setup.sql': `
        INSERT INTO "${ctx.schema}"."versions" ("ver") VALUES ('v2');
      `,
    });

    const second = await runMigration(ctx);
    expect(second.preScriptsRun).toBe(1);
    expect(second.skippedScripts).toBe(0);

    const rows = await queryDb(ctx, `SELECT "ver" FROM "${ctx.schema}"."versions" ORDER BY "id"`);
    expect(rows.rows.map((r: { ver: string }) => r.ver)).toEqual(['v1', 'v2']);
  });
});
