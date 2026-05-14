import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import {
  ensureExpandStateTable,
  planExpandColumn,
  runBackfill,
  runBackfillAll,
  runContract,
  runContractAll,
  recordExpandState,
  checkBackfillComplete,
  getExpandStatus,
  type ExpandState,
} from '../index.js';
import { closePool, getPool } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let schemaCount = 0;
function uniqueSchema(): string {
  return `expand_test_${Date.now()}_${schemaCount++}`;
}

describe('Expand/Contract', () => {
  afterAll(async () => {
    await closePool();
  });

  describe('ensureExpandStateTable', () => {
    it('creates _smplcty_schema_flow.expand_state table', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
        await ensureExpandStateTable(client);

        const res = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '_smplcty_schema_flow' AND table_name = 'expand_state'`,
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('is idempotent and adds the unique constraint', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
        await ensureExpandStateTable(client);
        await ensureExpandStateTable(client);

        const res = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_expand_state_table_col'`);
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  describe('planExpandColumn', () => {
    it('emits 2 operations: add column + dual-write trigger (no inline backfill)', () => {
      const ops = planExpandColumn('users', 'email_lower', 'text', {
        from: 'email',
        transform: 'lower(email)',
      });

      expect(ops.length).toBe(2);
      expect(ops[0].type).toBe('expand_column');
      expect(ops[0].sql).toContain('ADD COLUMN IF NOT EXISTS');
      expect(ops[0].sql).toContain('email_lower');
      expect(ops[0].expandMeta?.oldColumn).toBe('email');

      expect(ops[1].type).toBe('create_dual_write_trigger');
      expect(ops[1].sql).toContain('CREATE OR REPLACE FUNCTION');
      expect(ops[1].sql).toContain('lower(NEW.email)');
      expect(ops[1].sql).toContain('TRIGGER');
      expect(ops[1].expandMeta?.transform).toBe('lower(email)');
    });

    it('handles identity-transform rename (forward branch references the source column)', () => {
      const ops = planExpandColumn('orders', 'new_status', 'text', {
        from: 'status',
        transform: 'status',
      });

      expect(ops.length).toBe(2);
      // Forward expr becomes NEW.status
      expect(ops[1].sql).toContain('NEW.new_status := NEW.status');
    });

    it('guards the trigger so direct writes to the new column are not clobbered', () => {
      const ops = planExpandColumn('users', 'email_lower', 'text', {
        from: 'email',
        transform: 'lower(email)',
      });
      const triggerSql = ops[1].sql;

      // On INSERT, only mirror when new is NULL.
      expect(triggerSql).toContain("TG_OP = 'INSERT'");
      expect(triggerSql).toContain('NEW.email_lower IS NULL');
      // On UPDATE, only mirror when the source actually changed.
      expect(triggerSql).toContain('NEW.email IS DISTINCT FROM OLD.email');
    });

    it('includes a guarded reverse branch when reverse is set', () => {
      const ops = planExpandColumn('users', 'email_lower', 'text', {
        from: 'email',
        transform: 'lower(email)',
        reverse: 'email_lower',
      });

      expect(ops.length).toBe(2);
      const triggerSql = ops[1].sql;
      expect(triggerSql).toContain('NEW.email :=');
      expect(triggerSql).toContain('NEW.email_lower IS DISTINCT FROM OLD.email_lower');
    });

    it('omits reverse branch when reverse is not specified', () => {
      const ops = planExpandColumn('users', 'email_lower', 'text', {
        from: 'email',
        transform: 'lower(email)',
      });
      const triggerSql = ops[1].sql;
      expect(triggerSql).not.toContain('NEW.email :=');
    });
  });

  describe('full expand/contract lifecycle', () => {
    let testSchema: string;

    beforeEach(async () => {
      testSchema = uniqueSchema();
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA ${testSchema}`);
        await client.query(`SET search_path TO ${testSchema}`);
        await client.query(`
          CREATE TABLE ${testSchema}.users (
            id serial PRIMARY KEY,
            email text NOT NULL
          )
        `);
        await client.query(`INSERT INTO ${testSchema}.users (email) VALUES ('FOO@BAR.COM'), ('hello@world.com')`);
        await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
        await ensureExpandStateTable(client);
      } finally {
        client.release();
      }
    });

    it('applies the 2-op plan, then backfill is a separate step', async () => {
      const pool = getPool(DATABASE_URL);

      const ops = planExpandColumn(
        'users',
        'email_lower',
        'text',
        { from: 'email', transform: 'lower(email)' },
        testSchema,
      );

      const client = await pool.connect();
      try {
        for (const op of ops) {
          await client.query(op.sql);
        }
        // After the migration plan runs, pre-existing rows are NOT backfilled.
        // (Backfill is the operator's separate step.)
        const beforeBackfill = await client.query(
          `SELECT count(*) AS cnt FROM ${testSchema}.users WHERE email_lower IS NULL`,
        );
        expect(Number(beforeBackfill.rows[0].cnt)).toBe(2);

        // New inserts get dual-write trigger applied immediately.
        await client.query(`INSERT INTO ${testSchema}.users (email) VALUES ('NEW@TEST.COM')`);
        const inserted = await client.query(`SELECT email_lower FROM ${testSchema}.users WHERE email = 'NEW@TEST.COM'`);
        expect(inserted.rows[0].email_lower).toBe('new@test.com');

        // Now run backfill — populates pre-existing rows.
        await runBackfill({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'email_lower',
          transform: 'lower(email)',
          pgSchema: testSchema,
          logger,
        });
        const after = await client.query(`SELECT email, email_lower FROM ${testSchema}.users ORDER BY id`);
        expect(after.rows[0].email_lower).toBe('foo@bar.com');
        expect(after.rows[1].email_lower).toBe('hello@world.com');
      } finally {
        client.release();
      }
    });

    it('backfill on a nullable source column terminates (regression: previously infinite-looped)', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`ALTER TABLE ${testSchema}.users ADD COLUMN nickname text`);
        await client.query(`UPDATE ${testSchema}.users SET nickname = NULL`);
        await client.query(`ALTER TABLE ${testSchema}.users ADD COLUMN nickname_new text`);

        // Identity rename of a fully-NULL source column. Old predicate
        // (WHERE new IS NULL) would update 2 rows to NULL forever.
        const result = await runBackfill({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'nickname_new',
          transform: 'nickname',
          pgSchema: testSchema,
          logger,
        });
        expect(result.rowsUpdated).toBe(0); // nothing to do — invariant already holds
      } finally {
        client.release();
      }
    });

    it('trigger preserves direct writes to the new column (no clobber)', async () => {
      const pool = getPool(DATABASE_URL);
      const ops = planExpandColumn(
        'users',
        'email_lower',
        'text',
        { from: 'email', transform: 'lower(email)' },
        testSchema,
      );

      const client = await pool.connect();
      try {
        for (const op of ops) await client.query(op.sql);

        // Direct INSERT writing both columns: trigger must NOT overwrite email_lower.
        await client.query(
          `INSERT INTO ${testSchema}.users (email, email_lower) VALUES ('SOURCE@X.COM', 'direct-write')`,
        );
        const inserted = await client.query(`SELECT email_lower FROM ${testSchema}.users WHERE email = 'SOURCE@X.COM'`);
        expect(inserted.rows[0].email_lower).toBe('direct-write');

        // UPDATE that only touches the new column: trigger must NOT overwrite it.
        await client.query(`UPDATE ${testSchema}.users SET email_lower = 'manual' WHERE email = 'SOURCE@X.COM'`);
        const updated = await client.query(`SELECT email_lower FROM ${testSchema}.users WHERE email = 'SOURCE@X.COM'`);
        expect(updated.rows[0].email_lower).toBe('manual');
      } finally {
        client.release();
      }
    });

    it('checkBackfillComplete reports diverged rows accurately', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`ALTER TABLE ${testSchema}.users ADD COLUMN email_lower text`);
        const state: ExpandState = {
          id: 0,
          table_name: `${testSchema}.users`,
          new_column: 'email_lower',
          old_column: 'email',
          transform: 'lower(email)',
          trigger_name: `_smplcty_sf_dw_${testSchema}_users_email_lower`,
          status: 'expanded',
          created_at: new Date(),
        };
        const before = await checkBackfillComplete(client, state);
        expect(before).toBe(2);

        await client.query(`UPDATE ${testSchema}.users SET email_lower = lower(email)`);
        const after = await checkBackfillComplete(client, state);
        expect(after).toBe(0);
      } finally {
        client.release();
      }
    });

    it('contract refuses when backfill is incomplete', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of ops) await client.query(op.sql);
        await recordExpandState(client, ops[1].expandMeta!);
        // Pre-existing rows still satisfy the divergence predicate.
      } finally {
        client.release();
      }

      await expect(
        runContract({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'email_lower',
          pgSchema: testSchema,
          logger,
        }),
      ).rejects.toThrow(/row\(s\) still satisfy/);
    });

    it('contract --force drops the old column even with diverged rows', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of ops) await client.query(op.sql);
        await recordExpandState(client, ops[1].expandMeta!);
      } finally {
        client.release();
      }

      const result = await runContract({
        connectionString: DATABASE_URL,
        tableName: 'users',
        newColumn: 'email_lower',
        pgSchema: testSchema,
        force: true,
        logger,
      });
      expect(result.dropped).toBe(true);
      expect(result.forced).toBe(true);
      expect(result.rowsDiverged).toBeGreaterThan(0);
    });

    it('contract succeeds after backfill completes', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of ops) await client.query(op.sql);
        await recordExpandState(client, ops[1].expandMeta!);
      } finally {
        client.release();
      }

      await runBackfill({
        connectionString: DATABASE_URL,
        tableName: 'users',
        newColumn: 'email_lower',
        transform: 'lower(email)',
        pgSchema: testSchema,
        logger,
      });

      const result = await runContract({
        connectionString: DATABASE_URL,
        tableName: 'users',
        newColumn: 'email_lower',
        pgSchema: testSchema,
        logger,
      });
      expect(result.dropped).toBe(true);
      expect(result.forced).toBe(false);
      expect(result.rowsDiverged).toBe(0);

      const pool2 = getPool(DATABASE_URL);
      const client2 = await pool2.connect();
      try {
        const colRes = await client2.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
          [testSchema],
        );
        expect(colRes.rows.length).toBe(0);
      } finally {
        client2.release();
      }
    });

    it('recordExpandState is idempotent', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const meta = {
          tableName: 'users',
          newColumn: 'email_lower',
          oldColumn: 'email',
          transform: 'lower(email)',
          triggerName: `_smplcty_sf_dw_${testSchema}_users_email_lower`,
          pgSchema: testSchema,
        };
        await recordExpandState(client, meta);
        await recordExpandState(client, meta);
        await recordExpandState(client, meta);

        const res = await client.query(
          `SELECT count(*)::int AS cnt FROM _smplcty_schema_flow.expand_state
           WHERE table_name = $1 AND new_column = $2`,
          [`${testSchema}.users`, 'email_lower'],
        );
        expect(res.rows[0].cnt).toBe(1);
      } finally {
        client.release();
      }
    });

    it('runBackfillAll drains multiple pending states', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE ${testSchema}.items (
            id serial PRIMARY KEY,
            name text NOT NULL
          )
        `);
        await client.query(`INSERT INTO ${testSchema}.items (name) VALUES ('A'), ('B')`);

        const usersOps = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of usersOps) await client.query(op.sql);
        await recordExpandState(client, usersOps[1].expandMeta!);

        const itemsOps = planExpandColumn(
          'items',
          'name_lower',
          'text',
          { from: 'name', transform: 'lower(name)' },
          testSchema,
        );
        for (const op of itemsOps) await client.query(op.sql);
        await recordExpandState(client, itemsOps[1].expandMeta!);
      } finally {
        client.release();
      }

      const result = await runBackfillAll({
        connectionString: DATABASE_URL,
        pgSchema: testSchema,
        logger,
      });
      // Both tables processed (other test schemas' states are filtered by qualifier).
      const ours = result.perState.filter((p) => p.table.startsWith(`${testSchema}.`));
      expect(ours.length).toBe(2);
    });

    it('getExpandStatus returns state rows', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO _smplcty_schema_flow.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'expanded')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_smplcty_sf_dw_${testSchema}_users_email_lower`,
          ],
        );
        const states = await getExpandStatus(client);
        const ours = states.filter((s) => s.table_name === `${testSchema}.users`);
        expect(ours.length).toBe(1);
        expect(ours[0].new_column).toBe('email_lower');
      } finally {
        client.release();
      }
    });

    it('rejects contract when no expand state found', async () => {
      await expect(
        runContract({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'nonexistent',
          pgSchema: testSchema,
          logger,
        }),
      ).rejects.toThrow('No expand state found');
    });

    it('runContractAll drops every backfilled column in one invocation', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE ${testSchema}.items (
            id serial PRIMARY KEY,
            name text NOT NULL
          )
        `);
        await client.query(`INSERT INTO ${testSchema}.items (name) VALUES ('A'), ('B')`);

        const usersOps = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of usersOps) await client.query(op.sql);
        await recordExpandState(client, usersOps[1].expandMeta!);

        const itemsOps = planExpandColumn(
          'items',
          'name_lower',
          'text',
          { from: 'name', transform: 'lower(name)' },
          testSchema,
        );
        for (const op of itemsOps) await client.query(op.sql);
        await recordExpandState(client, itemsOps[1].expandMeta!);
      } finally {
        client.release();
      }

      // Drain both via the bulk backfill, then contract both via the bulk path.
      await runBackfillAll({ connectionString: DATABASE_URL, pgSchema: testSchema, logger });

      const result = await runContractAll({
        connectionString: DATABASE_URL,
        pgSchema: testSchema,
        logger,
      });

      expect(result.contracted.length).toBe(2);
      expect(result.skipped.length).toBe(0);
      expect(result.contracted.every((c) => c.rowsDiverged === 0)).toBe(true);

      // Both expand_state rows ended up contracted, and the old columns are gone.
      const verify = await pool.connect();
      try {
        const stateRes = await verify.query(
          `SELECT new_column, status FROM _smplcty_schema_flow.expand_state
           WHERE pg_schema = $1 ORDER BY new_column`,
          [testSchema],
        );
        expect(stateRes.rows.map((r) => r.status)).toEqual(['email_lower', 'name_lower'].map(() => 'contracted'));

        const colRes = await verify.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND column_name IN ('email', 'name')
           ORDER BY column_name`,
          [testSchema],
        );
        expect(colRes.rows.length).toBe(0);
      } finally {
        verify.release();
      }
    });

    it('runContractAll skips divergent rows and contracts ready ones', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE ${testSchema}.items (
            id serial PRIMARY KEY,
            name text NOT NULL
          )
        `);
        await client.query(`INSERT INTO ${testSchema}.items (name) VALUES ('A'), ('B')`);

        const usersOps = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of usersOps) await client.query(op.sql);
        await recordExpandState(client, usersOps[1].expandMeta!);

        const itemsOps = planExpandColumn(
          'items',
          'name_lower',
          'text',
          { from: 'name', transform: 'lower(name)' },
          testSchema,
        );
        for (const op of itemsOps) await client.query(op.sql);
        await recordExpandState(client, itemsOps[1].expandMeta!);

        // Backfill only the items table — users still has divergent rows.
        await client.query(`UPDATE ${testSchema}.items SET name_lower = lower(name)`);
      } finally {
        client.release();
      }

      const result = await runContractAll({
        connectionString: DATABASE_URL,
        pgSchema: testSchema,
        logger,
      });

      expect(result.contracted.length).toBe(1);
      expect(result.contracted[0].column).toBe('name_lower');
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0].column).toBe('email_lower');
      expect(result.skipped[0].rowsDiverged).toBeGreaterThan(0);
    });

    it('runContractAll --force drops divergent rows when explicitly asked', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        const ops = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of ops) await client.query(op.sql);
        await recordExpandState(client, ops[1].expandMeta!);
        // Don't backfill: pre-existing rows still diverge.
      } finally {
        client.release();
      }

      const result = await runContractAll({
        connectionString: DATABASE_URL,
        pgSchema: testSchema,
        force: true,
        logger,
      });

      expect(result.contracted.length).toBe(1);
      expect(result.skipped.length).toBe(0);
      expect(result.contracted[0].forced).toBe(true);
      expect(result.contracted[0].rowsDiverged).toBeGreaterThan(0);
    });

    it('runContractAll respects --table / --column filters', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE ${testSchema}.items (
            id serial PRIMARY KEY,
            name text NOT NULL
          )
        `);
        await client.query(`INSERT INTO ${testSchema}.items (name) VALUES ('A')`);

        const usersOps = planExpandColumn(
          'users',
          'email_lower',
          'text',
          { from: 'email', transform: 'lower(email)' },
          testSchema,
        );
        for (const op of usersOps) await client.query(op.sql);
        await recordExpandState(client, usersOps[1].expandMeta!);

        const itemsOps = planExpandColumn(
          'items',
          'name_lower',
          'text',
          { from: 'name', transform: 'lower(name)' },
          testSchema,
        );
        for (const op of itemsOps) await client.query(op.sql);
        await recordExpandState(client, itemsOps[1].expandMeta!);
      } finally {
        client.release();
      }

      await runBackfillAll({ connectionString: DATABASE_URL, pgSchema: testSchema, logger });

      const result = await runContractAll({
        connectionString: DATABASE_URL,
        pgSchema: testSchema,
        table: 'items',
        logger,
      });

      expect(result.contracted.length).toBe(1);
      expect(result.contracted[0].column).toBe('name_lower');
      expect(result.skipped.length).toBe(0);

      // The users expand_state row should remain in 'expanded' status.
      const verify = await pool.connect();
      try {
        const stateRes = await verify.query(
          `SELECT new_column, status FROM _smplcty_schema_flow.expand_state
           WHERE pg_schema = $1 AND new_column = $2`,
          [testSchema, 'email_lower'],
        );
        expect(stateRes.rows[0].status).toBe('expanded');
      } finally {
        verify.release();
      }
    });

    it('rejects contract when already contracted', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO _smplcty_schema_flow.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'contracted')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_smplcty_sf_dw_${testSchema}_users_email_lower`,
          ],
        );
      } finally {
        client.release();
      }

      await expect(
        runContract({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'email_lower',
          pgSchema: testSchema,
          logger,
        }),
      ).rejects.toThrow('already contracted');
    });
  });
});
