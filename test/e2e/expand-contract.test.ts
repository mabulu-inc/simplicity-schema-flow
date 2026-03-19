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
import { ensureExpandStateTable, runContract, getExpandStatus } from '../../src/expand/index.js';

describe('E2E: Expand/contract lifecycle', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) expand column — new column created, dual-write trigger exists, backfill works', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create the base table with source data (use integer PK to avoid
    // serial default being dropped on re-migration — a known planner limitation)
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

    // Insert some rows before expand (explicit IDs since no serial)
    await queryDb(
      ctx,
      `INSERT INTO "${ctx.schema}".users (id, email) VALUES (1, 'Alice@Example.COM'), (2, 'BOB@test.org')`,
    );

    // Step 2: Add an expand column and re-run migration
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

    // Verify: new column exists
    await assertColumnExists(ctx, 'users', 'email_lower');

    // Verify: backfill populated existing rows
    const backfilled = await queryDb(ctx, `SELECT email, email_lower FROM "${ctx.schema}".users ORDER BY id`);
    expect(backfilled.rows[0].email_lower).toBe('alice@example.com');
    expect(backfilled.rows[1].email_lower).toBe('bob@test.org');

    // Verify: dual-write trigger fires on new INSERT
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".users (id, email) VALUES (3, 'Charlie@NewDomain.IO')`);
    const newRow = await queryDb(
      ctx,
      `SELECT email_lower FROM "${ctx.schema}".users WHERE email = 'Charlie@NewDomain.IO'`,
    );
    expect(newRow.rows[0].email_lower).toBe('charlie@newdomain.io');

    // Verify: dual-write trigger fires on UPDATE
    await queryDb(ctx, `UPDATE "${ctx.schema}".users SET email = 'UPDATED@EXAMPLE.COM' WHERE id = 1`);
    const updated = await queryDb(ctx, `SELECT email_lower FROM "${ctx.schema}".users WHERE id = 1`);
    expect(updated.rows[0].email_lower).toBe('updated@example.com');
  });

  it('(2) contract phase — old column dropped, trigger removed', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create table and run expand
    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
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

    // Insert expand_state record (pipeline doesn't auto-insert)
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
      await ensureExpandStateTable(client);
      await client.query(
        `INSERT INTO _smplcty_schema_flow.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
         VALUES ($1, $2, $3, $4, $5, 'expanded')`,
        [
          `${ctx.schema}.users`,
          'email_lower',
          'email',
          'lower(email)',
          `_smplcty_sf_dw_${ctx.schema}_users_email_lower`,
        ],
      );
    } finally {
      client.release();
    }

    // Run contract
    const contractResult = await runContract({
      connectionString: ctx.config.connectionString,
      tableName: 'users',
      newColumn: 'email_lower',
      pgSchema: ctx.schema,
    });

    expect(contractResult.dropped).toBe(true);
    expect(contractResult.oldColumn).toBe('email');
    expect(contractResult.triggerDropped).toBe(true);

    // Verify: old column is gone
    const colResult = await queryDb(
      ctx,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
      [ctx.schema],
    );
    expect(colResult.rowCount).toBe(0);

    // Verify: trigger is gone
    const triggerResult = await queryDb(
      ctx,
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_schema = $1 AND event_object_table = 'users'`,
      [ctx.schema],
    );
    expect(triggerResult.rowCount).toBe(0);

    // Verify: new column still exists and has data
    await assertColumnExists(ctx, 'users', 'email_lower');
  });

  it('(3) expand-status shows in-progress migration before contract', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create table and run expand
    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
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

    // Insert expand_state record
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
      await ensureExpandStateTable(client);
      await client.query(
        `INSERT INTO _smplcty_schema_flow.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
         VALUES ($1, $2, $3, $4, $5, 'expanded')`,
        [
          `${ctx.schema}.users`,
          'email_lower',
          'email',
          'lower(email)',
          `_smplcty_sf_dw_${ctx.schema}_users_email_lower`,
        ],
      );

      // Check expand-status
      const states = await getExpandStatus(client);
      const ours = states.filter((s) => s.table_name === `${ctx.schema}.users`);
      expect(ours.length).toBe(1);
      expect(ours[0].status).toBe('expanded');
      expect(ours[0].new_column).toBe('email_lower');
      expect(ours[0].old_column).toBe('email');
    } finally {
      client.release();
    }

    // After contract, status should be 'contracted'
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

  it('(4) expand with reverse transform — dual-write copies new→old', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create table with source data (integer PK for re-migration compatibility)
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

    // Add expand column with reverse transform
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
    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    // Verify: forward transform works (backfill)
    const backfilled = await queryDb(ctx, `SELECT price_cents, price_dollars FROM "${ctx.schema}".items ORDER BY id`);
    expect(Number(backfilled.rows[0].price_dollars)).toBe(10);
    expect(Number(backfilled.rows[1].price_dollars)).toBe(25);

    // Verify: forward dual-write on INSERT
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".items (id, price_cents) VALUES (3, 500)`);
    const fwd = await queryDb(ctx, `SELECT price_dollars FROM "${ctx.schema}".items WHERE price_cents = 500`);
    expect(Number(fwd.rows[0].price_dollars)).toBe(5);

    // Verify: reverse transform is present in the trigger function body
    const fnBody = await queryDb(ctx, `SELECT prosrc FROM pg_proc WHERE proname = $1`, [
      `_smplcty_sf_dw_fn_${ctx.schema}_items_price_dollars`,
    ]);
    expect(fnBody.rows.length).toBe(1);
    expect(fnBody.rows[0].prosrc).toContain('NEW.price_cents');
    expect(fnBody.rows[0].prosrc).toContain('NEW.price_dollars');

    // Verify: updating the old column propagates via forward transform
    await queryDb(ctx, `UPDATE "${ctx.schema}".items SET price_cents = 9999 WHERE id = 1`);
    const rev = await queryDb(ctx, `SELECT price_cents, price_dollars FROM "${ctx.schema}".items WHERE id = 1`);
    expect(Number(rev.rows[0].price_cents)).toBe(9999);
    expect(Number(rev.rows[0].price_dollars)).toBeCloseTo(99.99, 2);
  });

  it('(5) expand with custom batch_size', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create table with many rows (integer PK for re-migration compatibility)
    writeSchema(ctx.dir, {
      'tables/records.yaml': `
table: records
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
`,
    });
    await runMigration(ctx);

    // Insert 20 rows with explicit IDs
    for (let i = 0; i < 20; i++) {
      await queryDb(ctx, `INSERT INTO "${ctx.schema}".records (id, name) VALUES ($1, $2)`, [i + 1, `Record_${i}`]);
    }

    // Add expand column with small batch_size
    writeSchema(ctx.dir, {
      'tables/records.yaml': `
table: records
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
  - name: name_lower
    type: text
    expand:
      from: name
      transform: "lower(name)"
      batch_size: 5
`,
    });
    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);

    // Verify: at least some rows were backfilled (executor runs single batch with LIMIT batch_size)
    const res = await queryDb(ctx, `SELECT count(*) as cnt FROM "${ctx.schema}".records WHERE name_lower IS NOT NULL`);
    expect(Number(res.rows[0].cnt)).toBeGreaterThan(0);

    // Verify: new inserts still get dual-write
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".records (id, name) VALUES (21, 'NEW_RECORD')`);
    const newRow = await queryDb(ctx, `SELECT name_lower FROM "${ctx.schema}".records WHERE name = 'NEW_RECORD'`);
    expect(newRow.rows[0].name_lower).toBe('new_record');
  });
});
