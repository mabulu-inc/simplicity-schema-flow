import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

let counter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${counter++}`;
}

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

  it('exclusion-constraint-backed indexes are not seen as orphan on re-plan (#39)', async () => {
    // The introspector filters constraint-backed indexes for unique
    // constraints, but the same filter has to apply to exclusion
    // constraints too — otherwise the GiST index that backs an EXCLUDE
    // constraint looks orphan on every plan and gets queued for drop.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': 'extensions:\n  - btree_gist\n',
      'tables/bookings.yaml': `
table: bookings
columns:
  - name: id
    type: integer
    primary_key: true
  - name: room_id
    type: integer
    nullable: false
  - name: during
    type: int4range
    nullable: false
exclusion_constraints:
  - name: bookings_no_overlap
    using: gist
    elements:
      - column: room_id
        operator: '='
      - column: during
        operator: '&&'
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });

  it('grant_sequence is suppressed when the role already has USAGE+SELECT on the sequence', async () => {
    // Per-table sequence grants are auto-derived from each grant block with
    // a write privilege; without an existing-state check they re-emit every
    // plan even though the live ACL already carries USAGE+SELECT.
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('seq_grant');
    ctx.registerRole(roleName);
    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
grants:
  - to: ${roleName}
    privileges: [INSERT, SELECT, UPDATE]
`,
    });

    const first = await runMigration(ctx);
    const firstSeqOps = first.executedOperations.filter((o) => o.type === 'grant_sequence');
    expect(firstSeqOps.length).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    const secondSeqOps = second.executedOperations.filter((o) => o.type === 'grant_sequence');
    expect(secondSeqOps).toEqual([]);
  });

  it('seeds whose rows already exist verbatim re-apply as a no-op', async () => {
    // Idempotent INSERT/UPDATE makes seed re-application correct on the
    // executor side, but the planner emitted a seed_table op every plan
    // regardless. With pre-flight comparison via temp-table EXCEPT, the
    // op is suppressed when every seed row matches the live data.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/colors.yaml': `
table: colors
columns:
  - name: color_id
    type: integer
    primary_key: true
  - name: name
    type: text
    nullable: false
seeds:
  - color_id: 1
    name: red
  - color_id: 2
    name: green
  - color_id: 3
    name: blue
seeds_on_conflict: 'DO NOTHING'
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });

  it('seed_table is still emitted when YAML adds a new row', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/colors.yaml': `
table: colors
columns:
  - name: color_id
    type: integer
    primary_key: true
  - name: name
    type: text
    nullable: false
seeds:
  - color_id: 1
    name: red
seeds_on_conflict: 'DO NOTHING'
`,
    });

    await runMigration(ctx);

    // Add a second seed row — the planner must still emit the op.
    writeSchema(ctx.dir, {
      'tables/colors.yaml': `
table: colors
columns:
  - name: color_id
    type: integer
    primary_key: true
  - name: name
    type: text
    nullable: false
seeds:
  - color_id: 1
    name: red
  - color_id: 2
    name: green
seeds_on_conflict: 'DO NOTHING'
`,
    });

    const second = await runMigration(ctx);
    const seedOps = second.executedOperations.filter((o) => o.type === 'seed_table');
    expect(seedOps).toHaveLength(1);
  });

  it('self-qualified policy USING / CHECK / partial-index WHERE re-applies as a no-op (#32)', async () => {
    // Covers the common RLS pattern of writing `tablename.col` inside an
    // EXISTS subquery so the inner FROM disambiguates joined tables, and
    // the same shape inside CHECK and partial-index WHERE clauses.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/things.yaml': `
table: things
rls: true
columns:
  - name: thing_id
    type: integer
    primary_key: true
  - name: owner_id
    type: integer
    nullable: false
  - name: status
    type: text
    nullable: false
checks:
  - name: things_owner_positive
    expression: things.owner_id > 0
indexes:
  - name: idx_things_active_owner
    columns: [owner_id]
    where: things.status <> 'archived'
policies:
  - name: things_owner_visibility
    for: SELECT
    to: PUBLIC
    using: |-
      EXISTS (
        SELECT 1 FROM things t2
        WHERE t2.owner_id = things.owner_id
          AND t2.status = things.status
      )
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });
});
