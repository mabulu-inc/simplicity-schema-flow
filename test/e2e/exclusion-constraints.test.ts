import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: EXCLUDE constraints (#30)', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('declares and applies a single-element exclusion constraint', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `extensions:\n  - btree_gist\n`,
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

    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    // Constraint exists and is of type 'x' (EXCLUDE).
    const rows = await queryDb(
      ctx,
      `SELECT con.conname, con.contype
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = 'bookings' AND con.conname = 'bookings_no_overlap'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].contype).toBe('x');

    // Functionally enforces overlap exclusion.
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".bookings (id, room_id, during) VALUES (1, 1, '[1,5)')`);
    let conflict: Error | null = null;
    try {
      await queryDb(ctx, `INSERT INTO "${ctx.schema}".bookings (id, room_id, during) VALUES (2, 1, '[3,7)')`);
    } catch (err) {
      conflict = err as Error;
    }
    expect(conflict).not.toBeNull();
    expect(conflict!.message).toMatch(/conflicting key value violates exclusion constraint/i);
  });

  it('a partial exclusion constraint (WHERE) re-applies as a no-op', async () => {
    // Mirrors the issue's primary use case: prevent overlapping geofences,
    // restricted to non-null values via WHERE. Re-running must produce zero
    // ops or every migrate would drop+recreate the constraint.
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/yards.yaml': `
table: yards
columns:
  - name: id
    type: integer
    primary_key: true
  - name: geofence
    type: int4range
exclusion_constraints:
  - name: yards_geofence_no_overlap
    elements:
      - column: geofence
        operator: '&&'
    where: geofence IS NOT NULL
    comment: |
      Two yards may not have overlapping geofences.
`,
    });

    const first = await runMigration(ctx);
    expect(first.executed).toBeGreaterThan(0);

    // Constraint must actually exist — pin this down so a regression where
    // the planner silently ignores `exclusion_constraints` is visible.
    const exists = await queryDb(
      ctx,
      `SELECT 1 FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = 'yards' AND con.conname = 'yards_geofence_no_overlap' AND con.contype = 'x'`,
    );
    expect(exists.rowCount).toBe(1);

    const second = await runMigration(ctx);
    expect(second.executedOperations).toEqual([]);
    expect(second.executed).toBe(0);
  });

  it('adds an exclusion constraint to an existing table on a later migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/zones.yaml': `
table: zones
columns:
  - name: id
    type: integer
    primary_key: true
  - name: bounds
    type: int4range
`,
    });
    await runMigration(ctx);

    // Add the exclusion constraint via a YAML edit — must reach the
    // alterTableOps path, not the create-table inline path.
    writeSchema(ctx.dir, {
      'tables/zones.yaml': `
table: zones
columns:
  - name: id
    type: integer
    primary_key: true
  - name: bounds
    type: int4range
exclusion_constraints:
  - name: zones_bounds_no_overlap
    elements:
      - column: bounds
        operator: '&&'
`,
    });

    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);
    const exists = await queryDb(
      ctx,
      `SELECT 1 FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = 'zones' AND con.conname = 'zones_bounds_no_overlap' AND con.contype = 'x'`,
    );
    expect(exists.rowCount).toBe(1);

    // No-churn re-apply.
    const second = await runMigration(ctx);
    expect(second.executed).toBe(0);
  });
});
