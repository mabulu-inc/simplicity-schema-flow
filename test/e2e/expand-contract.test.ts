import { describe, it, expect, afterEach } from 'vitest';
import {
  useTestProject,
  writeSchema,
  runMigration,
  queryDb,
  assertTableExists,
  assertColumnExists,
} from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { getPool } from '../../src/core/db.js';
import { runContract, getExpandStatus, runBackfillAll, runBackfill } from '../../src/expand/index.js';

describe('E2E: Expand/contract lifecycle', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) expand column — new column + trigger created, state recorded, backfill is separate', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
`,
    });
    await runMigration(ctx);
    await assertTableExists(ctx, 'users');

    await queryDb(
      ctx,
      `INSERT INTO "${ctx.schema}".users (id, email) VALUES (1, 'Alice@Example.COM'), (2, 'BOB@test.org')`,
    );

    // Adding the expand column.
    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
`,
    });
    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    await assertColumnExists(ctx, 'users', 'email_lower');

    // Pre-existing rows are NOT backfilled by `run` — that's a separate step.
    const stillNull = await queryDb(
      ctx,
      `SELECT count(*)::int AS cnt FROM "${ctx.schema}".users WHERE email_lower IS NULL`,
    );
    expect(stillNull.rows[0].cnt).toBe(2);

    // Expand state row is recorded automatically by the migration.
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      const states = await getExpandStatus(client);
      const ours = states.filter((s) => s.table_name === `${ctx.schema}.users`);
      expect(ours.length).toBe(1);
      expect(ours[0].status).toBe('expanded');
    } finally {
      client.release();
    }

    // Dual-write trigger fires on new INSERT (only sets new when not provided).
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".users (id, email) VALUES (3, 'Charlie@NewDomain.IO')`);
    const newRow = await queryDb(
      ctx,
      `SELECT email_lower FROM "${ctx.schema}".users WHERE email = 'Charlie@NewDomain.IO'`,
    );
    expect(newRow.rows[0].email_lower).toBe('charlie@newdomain.io');

    // Dual-write trigger fires on UPDATE that changes the source column.
    await queryDb(ctx, `UPDATE "${ctx.schema}".users SET email = 'UPDATED@EXAMPLE.COM' WHERE id = 1`);
    const updated = await queryDb(ctx, `SELECT email_lower FROM "${ctx.schema}".users WHERE id = 1`);
    expect(updated.rows[0].email_lower).toBe('updated@example.com');
  });

  it('(2) backfill drains pre-existing rows then contract drops the old column', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
`,
    });
    await runMigration(ctx);
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".users (id, email) VALUES (1, 'A@X.com'), (2, 'B@y.com')`);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
`,
    });
    await runMigration(ctx);

    // Backfill drains the pre-existing rows.
    const backfilled = await runBackfillAll({
      connectionString: ctx.config.connectionString,
      pgSchema: ctx.schema,
    });
    expect(backfilled.processed).toBeGreaterThan(0);

    const after = await queryDb(ctx, `SELECT email_lower FROM "${ctx.schema}".users ORDER BY id`);
    expect(after.rows[0].email_lower).toBe('a@x.com');
    expect(after.rows[1].email_lower).toBe('b@y.com');

    // Now contract succeeds (no diverged rows).
    const contractResult = await runContract({
      connectionString: ctx.config.connectionString,
      tableName: 'users',
      newColumn: 'email_lower',
      pgSchema: ctx.schema,
    });
    expect(contractResult.dropped).toBe(true);
    expect(contractResult.rowsDiverged).toBe(0);

    // Old column is gone.
    const colResult = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
      [ctx.schema],
    );
    expect(colResult.rowCount).toBe(0);

    // Trigger is gone.
    const triggerResult = await queryDb(
      ctx,
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_schema = $1 AND event_object_table = 'users'`,
      [ctx.schema],
    );
    expect(triggerResult.rowCount).toBe(0);

    await assertColumnExists(ctx, 'users', 'email_lower');
  });

  it('(3) contract refuses when backfill is incomplete', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
`,
    });
    await runMigration(ctx);
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".users (id, email) VALUES (1, 'A@X.com'), (2, 'B@y.com')`);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
`,
    });
    await runMigration(ctx);

    // Skip backfill — contract should refuse.
    await expect(
      runContract({
        connectionString: ctx.config.connectionString,
        tableName: 'users',
        newColumn: 'email_lower',
        pgSchema: ctx.schema,
      }),
    ).rejects.toThrow(/row\(s\) still satisfy/);

    // Old column should still be present.
    const stillThere = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
      [ctx.schema],
    );
    expect(stillThere.rowCount).toBe(1);
  });

  it('(4) zero-downtime rename recipe — identity transform on a nullable source', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: middle_name
    type: text
`,
    });
    await runMigration(ctx);
    await queryDb(
      ctx,
      `INSERT INTO "${ctx.schema}".users (id, middle_name)
       VALUES (1, 'Quincy'), (2, NULL), (3, 'Ann')`,
    );

    // Add the new column as an identity-transform expand (the "rename" pattern).
    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: middle_name
    type: text
  - name: middle_name_v2
    type: text
    expand:
      from: middle_name
      transform: "middle_name"
`,
    });
    await runMigration(ctx);

    // Backfill: copies non-null values; rows where source is NULL satisfy
    // the invariant already (both NULL), so no infinite loop.
    const backfilled = await runBackfill({
      connectionString: ctx.config.connectionString,
      tableName: 'users',
      newColumn: 'middle_name_v2',
      transform: 'middle_name',
      pgSchema: ctx.schema,
    });
    expect(backfilled.rowsUpdated).toBe(2); // rows 1 and 3; row 2 already satisfied (both NULL)

    // Confirm the invariant holds across NULL and non-NULL rows.
    const diverged = await queryDb(
      ctx,
      `SELECT count(*)::int AS cnt FROM "${ctx.schema}".users
       WHERE middle_name_v2 IS DISTINCT FROM middle_name`,
    );
    expect(diverged.rows[0].cnt).toBe(0);

    // Contract drops the old column.
    const contractResult = await runContract({
      connectionString: ctx.config.connectionString,
      tableName: 'users',
      newColumn: 'middle_name_v2',
      pgSchema: ctx.schema,
    });
    expect(contractResult.dropped).toBe(true);

    const stillNullable = await queryDb(ctx, `SELECT middle_name_v2 FROM "${ctx.schema}".users ORDER BY id`);
    expect(stillNullable.rows[0].middle_name_v2).toBe('Quincy');
    expect(stillNullable.rows[1].middle_name_v2).toBeNull();
    expect(stillNullable.rows[2].middle_name_v2).toBe('Ann');
  });

  it('(5) expand with reverse transform — bidirectional dual-write', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: price_cents
    type: integer
    nullable: false
`,
    });
    await runMigration(ctx);
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".items (id, price_cents) VALUES (1, 1000), (2, 2500)`);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: price_cents
    type: integer
    nullable: false
  - name: price_dollars
    type: numeric
    expand:
      from: price_cents
      transform: "price_cents / 100.0"
      reverse: "price_dollars * 100"
`,
    });
    await runMigration(ctx);

    // Backfill the pre-existing rows.
    await runBackfill({
      connectionString: ctx.config.connectionString,
      tableName: 'items',
      newColumn: 'price_dollars',
      transform: 'price_cents / 100.0',
      pgSchema: ctx.schema,
    });
    const backfilled = await queryDb(ctx, `SELECT price_cents, price_dollars FROM "${ctx.schema}".items ORDER BY id`);
    expect(Number(backfilled.rows[0].price_dollars)).toBe(10);
    expect(Number(backfilled.rows[1].price_dollars)).toBe(25);

    // Forward dual-write on UPDATE of source column.
    await queryDb(ctx, `UPDATE "${ctx.schema}".items SET price_cents = 9999 WHERE id = 1`);
    const fwd = await queryDb(ctx, `SELECT price_dollars FROM "${ctx.schema}".items WHERE id = 1`);
    expect(Number(fwd.rows[0].price_dollars)).toBeCloseTo(99.99, 2);

    // Reverse dual-write on UPDATE of new column only.
    await queryDb(ctx, `UPDATE "${ctx.schema}".items SET price_dollars = 50 WHERE id = 2`);
    const rev = await queryDb(ctx, `SELECT price_cents, price_dollars FROM "${ctx.schema}".items WHERE id = 2`);
    expect(Number(rev.rows[0].price_cents)).toBe(5000);
    expect(Number(rev.rows[0].price_dollars)).toBe(50);
  });

  it('(6) expand-status reflects in-progress migration before contract', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: email
    type: text
    nullable: false
  - name: email_lower
    type: text
    expand:
      from: email
      transform: "lower(email)"
`,
    });
    await runMigration(ctx);

    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      const states = await getExpandStatus(client);
      const ours = states.filter((s) => s.table_name === `${ctx.schema}.users`);
      expect(ours.length).toBe(1);
      expect(ours[0].status).toBe('expanded');
      expect(ours[0].new_column).toBe('email_lower');
      expect(ours[0].old_column).toBe('email');
    } finally {
      client.release();
    }

    await runContract({
      connectionString: ctx.config.connectionString,
      tableName: 'users',
      newColumn: 'email_lower',
      pgSchema: ctx.schema,
    });

    const client2 = await pool.connect();
    try {
      const states = await getExpandStatus(client2);
      const ours = states.filter((s) => s.table_name === `${ctx.schema}.users`);
      expect(ours.length).toBe(1);
      expect(ours[0].status).toBe('contracted');
    } finally {
      client2.release();
    }
  });
});
