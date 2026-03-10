import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { ensureExpandStateTable, planExpandColumn, runBackfill, runContract, getExpandStatus } from '../index.js';
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
    it('should create _simplicity.expand_state table', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureExpandStateTable(client);

        const res = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = '_simplicity' AND table_name = 'expand_state'`,
        );
        expect(res.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    it('should be idempotent', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureExpandStateTable(client);
        await ensureExpandStateTable(client);
        // No error means idempotent
      } finally {
        client.release();
      }
    });
  });

  describe('planExpandColumn', () => {
    it('should produce expand operations (add column, trigger, backfill)', () => {
      const ops = planExpandColumn('users', 'email_lower', 'text', {
        from: 'email',
        transform: 'lower(email)',
      });

      expect(ops.length).toBe(3);

      // First op: add the new column
      expect(ops[0].type).toBe('expand_column');
      expect(ops[0].objectName).toBe('users.email_lower');
      expect(ops[0].sql).toContain('ADD COLUMN');
      expect(ops[0].sql).toContain('email_lower');
      expect(ops[0].sql).toContain('text');

      // Second op: create dual-write trigger
      expect(ops[1].type).toBe('create_dual_write_trigger');
      expect(ops[1].sql).toContain('CREATE OR REPLACE FUNCTION');
      expect(ops[1].sql).toContain('lower(NEW.email)');
      expect(ops[1].sql).toContain('TRIGGER');

      // Third op: backfill
      expect(ops[2].type).toBe('backfill_column');
      expect(ops[2].sql).toContain('UPDATE');
      expect(ops[2].sql).toContain('lower(email)');
    });

    it('should handle simple rename (identity transform)', () => {
      const ops = planExpandColumn('orders', 'new_status', 'text', {
        from: 'status',
        transform: 'status',
      });

      expect(ops.length).toBe(3);
      expect(ops[2].sql).toContain('status');
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
        // Insert test data
        await client.query(`INSERT INTO ${testSchema}.users (email) VALUES ('FOO@BAR.COM'), ('hello@world.com')`);
        await client.query('CREATE SCHEMA IF NOT EXISTS _simplicity');
        await ensureExpandStateTable(client);
      } finally {
        client.release();
      }
    });

    it('should execute expand phase: add column, create trigger, backfill', async () => {
      const pool = getPool(DATABASE_URL);

      // Plan and execute expand operations
      const ops = planExpandColumn(
        'users',
        'email_lower',
        'text',
        {
          from: 'email',
          transform: 'lower(email)',
        },
        testSchema,
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const op of ops) {
          await client.query(op.sql);
        }

        // Record expand state
        await client.query(
          `INSERT INTO _simplicity.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'expanded')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_simplicity_dw_${testSchema}_users_email_lower`,
          ],
        );
        await client.query('COMMIT');

        // Verify column exists
        const colRes = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email_lower'`,
          [testSchema],
        );
        expect(colRes.rows.length).toBe(1);

        // Verify backfill happened
        const dataRes = await client.query(`SELECT email_lower FROM ${testSchema}.users ORDER BY id`);
        expect(dataRes.rows[0].email_lower).toBe('foo@bar.com');
        expect(dataRes.rows[1].email_lower).toBe('hello@world.com');

        // Verify dual-write trigger works
        await client.query(`INSERT INTO ${testSchema}.users (email) VALUES ('NEW@TEST.COM')`);
        const triggerRes = await client.query(
          `SELECT email_lower FROM ${testSchema}.users WHERE email = 'NEW@TEST.COM'`,
        );
        expect(triggerRes.rows[0].email_lower).toBe('new@test.com');
      } finally {
        client.release();
      }
    });

    it('should run backfill in batches', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        // Add more data
        for (let i = 0; i < 50; i++) {
          await client.query(`INSERT INTO ${testSchema}.users (email) VALUES ($1)`, [`user${i}@test.com`]);
        }

        // Add column manually
        await client.query(`ALTER TABLE ${testSchema}.users ADD COLUMN email_lower text`);

        // Run backfill with small batch size
        const result = await runBackfill({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'email_lower',
          transform: 'lower(email)',
          batchSize: 10,
          pgSchema: testSchema,
          logger,
        });

        expect(result.rowsUpdated).toBe(52); // 2 original + 50 new

        // All rows should be backfilled
        const res = await client.query(`SELECT count(*) as cnt FROM ${testSchema}.users WHERE email_lower IS NULL`);
        expect(Number(res.rows[0].cnt)).toBe(0);
      } finally {
        client.release();
      }
    });

    it('should get expand status', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        // No expand state initially
        const emptyStatus = await getExpandStatus(client);
        const filtered = emptyStatus.filter((s) => s.table_name.includes(testSchema));
        expect(filtered.length).toBe(0);

        // Insert a state record
        await client.query(
          `INSERT INTO _simplicity.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'expanded')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_simplicity_dw_${testSchema}_users_email_lower`,
          ],
        );

        const status = await getExpandStatus(client);
        const relevant = status.filter((s) => s.table_name.includes(testSchema));
        expect(relevant.length).toBe(1);
        expect(relevant[0].status).toBe('expanded');
        expect(relevant[0].new_column).toBe('email_lower');
        expect(relevant[0].old_column).toBe('email');
      } finally {
        client.release();
      }
    });

    it('should contract: drop old column and trigger', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        // First do the expand phase
        const ops = planExpandColumn(
          'users',
          'email_lower',
          'text',
          {
            from: 'email',
            transform: 'lower(email)',
          },
          testSchema,
        );

        await client.query('BEGIN');
        for (const op of ops) {
          await client.query(op.sql);
        }
        await client.query(
          `INSERT INTO _simplicity.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'expanded')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_simplicity_dw_${testSchema}_users_email_lower`,
          ],
        );
        await client.query('COMMIT');

        // Now contract
        const result = await runContract({
          connectionString: DATABASE_URL,
          tableName: 'users',
          newColumn: 'email_lower',
          pgSchema: testSchema,
          logger,
        });

        expect(result.dropped).toBe(true);
        expect(result.oldColumn).toBe('email');
        expect(result.triggerDropped).toBe(true);

        // Old column should be gone
        const colRes = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email'`,
          [testSchema],
        );
        expect(colRes.rows.length).toBe(0);

        // New column should still exist
        const newColRes = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email_lower'`,
          [testSchema],
        );
        expect(newColRes.rows.length).toBe(1);

        // Trigger function should be gone
        const funcRes = await client.query(
          `SELECT routine_name FROM information_schema.routines
           WHERE routine_schema = $1 AND routine_name LIKE '%dw%email_lower%'`,
          [testSchema],
        );
        expect(funcRes.rows.length).toBe(0);

        // Expand state should be 'contracted'
        const stateRes = await client.query(
          `SELECT status FROM _simplicity.expand_state
           WHERE table_name = $1 AND new_column = 'email_lower'`,
          [`${testSchema}.users`],
        );
        expect(stateRes.rows[0].status).toBe('contracted');
      } finally {
        client.release();
      }
    });

    it('should reject contract when no expand state found', async () => {
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

    it('should reject contract when already contracted', async () => {
      const pool = getPool(DATABASE_URL);
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO _simplicity.expand_state (table_name, new_column, old_column, transform, trigger_name, status)
           VALUES ($1, $2, $3, $4, $5, 'contracted')`,
          [
            `${testSchema}.users`,
            'email_lower',
            'email',
            'lower(email)',
            `_simplicity_dw_${testSchema}_users_email_lower`,
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
