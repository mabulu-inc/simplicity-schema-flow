import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: no-change reapply produces zero plan ops (#26)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('a schema with multiple indexes, policies, checks, grants re-applies as a no-op', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // A schema deliberately exercising the shapes the issue called out:
    // multiple plain and multi-column indexes, an expression index, a
    // partial index with INCLUDE columns, an RLS policy, a check
    // constraint, and a grant. Reapply must produce zero operations.
    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
rls: true
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: tenant_id
    type: integer
    nullable: false
  - name: status
    type: text
    nullable: false
  - name: total
    type: numeric
  - name: notes
    type: text
checks:
  - name: orders_total_nonneg
    expression: total >= 0
indexes:
  - name: idx_orders_status
    columns: [status]
  - name: idx_orders_tenant_status
    columns: [tenant_id, status]
  - name: idx_orders_lower_notes
    columns:
      - expression: lower(notes)
  - name: idx_orders_active
    columns: [tenant_id]
    where: status <> 'archived'
    include: [total]
policies:
  - name: orders_tenant_isolation
    for: ALL
    to: PUBLIC
    using: tenant_id = current_setting('app.tenant_id')::int
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    // Pre-fix this would emit drop+recreate ops for the index, policy, and
    // check on every run because PG canonicalises expressions with extra
    // casts and parens that the planner saw as a diff. The combined
    // introspection + normalisation fixes produce zero ops on a no-change
    // re-apply.
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });

  it('regex check constraint (slug format) re-applies as a no-op', async () => {
    // Pulled directly from the issue body: `tenants_slug_format_check` was
    // one of the constraints dropped+re-added on every run. Regex literals
    // in CHECK expressions get a `::text` cast appended by Postgres.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/tenants.yaml': `
table: tenants
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: slug
    type: text
    nullable: false
checks:
  - name: tenants_slug_format_check
    expression: slug ~ '^[a-z0-9-]+$'
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });
});
