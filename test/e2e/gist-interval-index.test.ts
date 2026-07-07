import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, getColumnInfo } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

/**
 * Issue #72 — declarative GiST index support for interval / validity tables.
 *
 * Models entity history as half-open validity intervals `[valid_from, valid_to)`
 * and serves point-in-time reads with a composite GiST index
 * `gist (tenant_id, state_range)`, resolved via the range containment operator
 * `state_range @> $T`. The scalar `tenant_id` shares the GiST index with the
 * range via the `btree_gist` extension.
 *
 * Two ways to key the range are exercised: a STORED generated column, and an
 * expression index over `tstzrange(valid_from, valid_to)`. Both must apply,
 * function under the containment operator, and re-apply as a no-op (no churn).
 */
describe('E2E: GiST interval / validity indexes (#72)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function indexMethod(table: string, indexName: string): Promise<string | undefined> {
    const result = await queryDb(
      ctx,
      `SELECT am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 AND i.relname = $3`,
      [ctx.schema, table, indexName],
    );
    return result.rows[0]?.method;
  }

  it('composite GiST over a STORED generated tstzrange column + btree_gist scalar key', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `extensions:\n  - btree_gist\n`,
      'tables/entity_state.yaml': `
table: entity_state
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: tenant_id
    type: bigint
    nullable: false
  - name: valid_from
    type: timestamptz
    nullable: false
  - name: valid_to
    type: timestamptz
  - name: state_range
    type: tstzrange
    generated: tstzrange(valid_from, valid_to)
indexes:
  - name: idx_entity_state_range
    method: gist
    columns: [tenant_id, state_range]
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    // The generated column exists and is STORED.
    const col = await getColumnInfo(ctx, 'entity_state', 'state_range');
    expect(col.generated).toContain('tstzrange');

    // The index is genuinely GiST.
    expect(await indexMethod('entity_state', 'idx_entity_state_range')).toBe('gist');

    // Point-in-time read via range containment returns exactly one row per
    // entity per instant. Seed two non-overlapping intervals for one tenant.
    await queryDb(
      ctx,
      `INSERT INTO "${ctx.schema}".entity_state (tenant_id, valid_from, valid_to) VALUES
         (1, '2020-01-01T00:00:00Z', '2020-06-01T00:00:00Z'),
         (1, '2020-06-01T00:00:00Z', NULL)`,
    );

    const hit = await queryDb(
      ctx,
      `SELECT id FROM "${ctx.schema}".entity_state
       WHERE tenant_id = 1 AND state_range @> $1::timestamptz`,
      ['2020-03-15T00:00:00Z'],
    );
    expect(hit.rowCount).toBe(1);

    const current = await queryDb(
      ctx,
      `SELECT id FROM "${ctx.schema}".entity_state
       WHERE tenant_id = 1 AND state_range @> $1::timestamptz`,
      ['2025-01-01T00:00:00Z'],
    );
    expect(current.rowCount).toBe(1);

    // Re-apply is a clean no-op — no phantom drift, no drop+recreate churn.
    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);

    const report = await ctx.drift();
    expect(report.summary.total).toBe(0);
  });

  it('composite GiST expression index over tstzrange(valid_from, valid_to)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `extensions:\n  - btree_gist\n`,
      'tables/entity_state_expr.yaml': `
table: entity_state_expr
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: tenant_id
    type: bigint
    nullable: false
  - name: valid_from
    type: timestamptz
    nullable: false
  - name: valid_to
    type: timestamptz
indexes:
  - name: idx_entity_state_expr_range
    method: gist
    columns:
      - tenant_id
      - expression: tstzrange(valid_from, valid_to)
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    expect(await indexMethod('entity_state_expr', 'idx_entity_state_expr_range')).toBe('gist');

    // Re-apply is a clean no-op — the expression key must round-trip through
    // pg_get_indexdef normalization without churn.
    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);

    const report = await ctx.drift();
    expect(report.summary.total).toBe(0);
  });
});
