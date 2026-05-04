import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: index column ordering (#31)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('declares an index with explicit DESC and applies cleanly', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: created_at
    type: timestamptz
indexes:
  - name: idx_items_created_desc
    columns:
      - column: created_at
        order: DESC
`,
    });

    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    // Index exists with the expected ordering.
    const def = await queryDb(
      ctx,
      `SELECT pg_get_indexdef(c.oid, 0, true) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'idx_items_created_desc' AND n.nspname = $1`,
      [ctx.schema],
    );
    expect(def.rowCount).toBe(1);
    expect(def.rows[0].def).toMatch(/created_at\s+DESC/);
  });

  it('NULLS FIRST on an ASC column re-applies as a no-op', async () => {
    // Postgres default is NULLS LAST for ASC and NULLS FIRST for DESC. An
    // explicit NULLS FIRST on an ASC column is *not* the default — it must
    // round-trip without churn on re-apply.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
indexes:
  - name: idx_items_name_nulls_first
    columns:
      - column: name
        nulls: FIRST
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const def = await queryDb(
      ctx,
      `SELECT pg_get_indexdef(c.oid, 0, true) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'idx_items_name_nulls_first' AND n.nspname = $1`,
      [ctx.schema],
    );
    expect(def.rows[0].def).toMatch(/NULLS FIRST/);

    const second = await runMigration(ctx);
    expect(second.executed).toBe(0);
  });

  it('writing the default (ASC NULLS LAST) explicitly produces no churn', async () => {
    // Postgres elides ASC and NULLS LAST in pg_get_indexdef output, so an
    // author who writes them explicitly in YAML must still produce zero ops
    // on re-apply (the diff has to default-resolve both sides).
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
indexes:
  - name: idx_items_name_explicit_default
    columns:
      - column: name
        order: ASC
        nulls: LAST
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    expect(second.executed).toBe(0);
  });

  it('multi-column index with mixed orderings applies and round-trips', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/events.yaml': `
table: events
columns:
  - name: id
    type: integer
    primary_key: true
  - name: tenant_id
    type: integer
  - name: created_at
    type: timestamptz
indexes:
  - name: idx_events_tenant_created_desc
    columns:
      - column: tenant_id
      - column: created_at
        order: DESC
        nulls: LAST
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const def = await queryDb(
      ctx,
      `SELECT pg_get_indexdef(c.oid, 0, true) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'idx_events_tenant_created_desc' AND n.nspname = $1`,
      [ctx.schema],
    );
    // PG default for DESC is NULLS FIRST; explicit `nulls: LAST` is the
    // non-default and must appear.
    expect(def.rows[0].def).toMatch(/created_at\s+DESC\s+NULLS LAST/);

    const second = await runMigration(ctx);
    expect(second.executed).toBe(0);
  });
});
