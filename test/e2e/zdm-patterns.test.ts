import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists, getColumnInfo } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { generateSql } from '../../src/sql/index.js';
import { buildPlan } from '../../src/planner/index.js';
import type { DesiredState, ActualState } from '../../src/planner/index.js';
import type { TableSchema } from '../../src/schema/types.js';

describe('E2E: Zero-downtime patterns', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) Safe NOT NULL — 4-step pattern leaves column NOT NULL', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with a nullable column
    writeSchema(ctx.dir, {
      'tables/zdm_notnull.yaml': `
table: zdm_notnull
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: true
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'zdm_notnull');

    // Verify column is nullable
    const before = await getColumnInfo(ctx, 'zdm_notnull', 'email');
    expect(before.nullable).toBe(true);

    // Insert a row so validation has data to check
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".zdm_notnull (email) VALUES ('test@example.com')`);

    // Step 2: Change column to NOT NULL
    writeSchema(ctx.dir, {
      'tables/zdm_notnull.yaml': `
table: zdm_notnull
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Verify column is now NOT NULL
    const after = await getColumnInfo(ctx, 'zdm_notnull', 'email');
    expect(after.nullable).toBe(false);

    // Verify no leftover check constraint from the safe pattern
    const checks = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'c' AND n.nspname = $1 AND cls.relname = 'zdm_notnull'
         AND con.conname LIKE 'chk_%_not_null'`,
      [ctx.schema],
    );
    expect(checks.rowCount).toBe(0);
  });

  it('(2) Safe unique constraint — CONCURRENTLY index + USING INDEX', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table without unique constraint
    writeSchema(ctx.dir, {
      'tables/zdm_unique.yaml': `
table: zdm_unique
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
  - name: tenant_id
    type: uuid
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'zdm_unique');

    // Step 2: Add a unique constraint
    writeSchema(ctx.dir, {
      'tables/zdm_unique.yaml': `
table: zdm_unique
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
  - name: tenant_id
    type: uuid
indexes:
  - columns: [email, tenant_id]
    name: uq_zdm_email_tenant
    unique: true
    as_constraint: true
`,
    });

    await runMigration(ctx);

    // Verify the unique constraint exists in the database
    const result = await queryDb(
      ctx,
      `SELECT con.conname, array_agg(a.attname ORDER BY k.n) AS columns
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'u' AND ns.nspname = $1 AND cls.relname = 'zdm_unique'
       GROUP BY con.conname`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].conname).toBe('uq_zdm_email_tenant');
    expect(result.rows[0].columns).toEqual('{email,tenant_id}');
  });

  it('(3) CONCURRENTLY indexes are not wrapped in transactions', async () => {
    // Build a plan that adds an index to an existing table, then verify
    // the generated SQL places CONCURRENTLY ops outside the transaction block.
    const existingTable: TableSchema = {
      table: 'zdm_idx',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true, default: 'gen_random_uuid()' },
        { name: 'email', type: 'text' },
      ],
    };

    const desiredTable: TableSchema = {
      table: 'zdm_idx',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true, default: 'gen_random_uuid()' },
        { name: 'email', type: 'text' },
      ],
      indexes: [{ columns: ['email'], name: 'idx_zdm_email' }],
    };

    const desired: DesiredState = {
      tables: [desiredTable],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };

    const actual: ActualState = {
      tables: new Map([['zdm_idx', existingTable]]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };

    const plan = buildPlan(desired, actual, { pgSchema: 'public' });

    // Should have concurrent operations
    const concurrentOps = plan.operations.filter((op) => op.concurrent);
    expect(concurrentOps.length).toBeGreaterThan(0);
    expect(concurrentOps[0].sql).toContain('CONCURRENTLY');

    // Generate SQL with transaction wrapping
    const sql = generateSql(plan, { wrapInTransaction: true });

    // The CONCURRENTLY statement should appear AFTER the COMMIT
    // (i.e., outside the transaction block)
    const commitIndex = sql.indexOf('COMMIT;');
    const concurrentlyIndex = sql.indexOf('CONCURRENTLY');

    // If there are no transactional ops, there may be no COMMIT;
    // but the CONCURRENTLY ops should still not be inside BEGIN/COMMIT
    if (commitIndex >= 0) {
      expect(concurrentlyIndex).toBeGreaterThan(commitIndex);
    }

    // Verify the SQL contains the concurrent section comment
    expect(sql).toContain('concurrent, outside transaction');
    expect(sql).toContain('CREATE INDEX CONCURRENTLY');
  });

  it('(4) FK NOT VALID — added as NOT VALID then validated', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create only the parent table
    writeSchema(ctx.dir, {
      'tables/zdm_fk_parent.yaml': `
table: zdm_fk_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'zdm_fk_parent');

    // Step 2: Add child table WITH FK reference to existing parent
    writeSchema(ctx.dir, {
      'tables/zdm_fk_parent.yaml': `
table: zdm_fk_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: name
    type: text
`,
      'tables/zdm_fk_child.yaml': `
table: zdm_fk_child
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: zdm_fk_parent
      column: id
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'zdm_fk_child');

    // FK should exist and be fully validated (NOT VALID + VALIDATE pattern completed)
    const fkAfter = await queryDb(
      ctx,
      `SELECT con.conname, con.convalidated
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'zdm_fk_child'`,
      [ctx.schema],
    );

    expect(fkAfter.rowCount).toBe(1);
    expect(fkAfter.rows[0].convalidated).toBe(true);

    // Verify FK references the correct table and column
    const fkRef = await queryDb(
      ctx,
      `SELECT a.attname AS col, cf.relname AS ref_table, af.attname AS ref_col
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
       JOIN pg_class cf ON cf.oid = con.confrelid
       JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = ANY(con.confkey)
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'zdm_fk_child'`,
      [ctx.schema],
    );

    expect(fkRef.rows[0].col).toBe('parent_id');
    expect(fkRef.rows[0].ref_table).toBe('zdm_fk_parent');
    expect(fkRef.rows[0].ref_col).toBe('id');

    // Also verify the planner generates NOT VALID SQL for FK additions
    const fkTable: TableSchema = {
      table: 'zdm_fk_verify',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true, default: 'gen_random_uuid()' },
        {
          name: 'ref_id',
          type: 'uuid',
          references: { table: 'zdm_fk_parent', column: 'id' },
        },
      ],
    };

    const plan = buildPlan(
      {
        tables: [fkTable],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
        extensions: null,
      },
      {
        tables: new Map(),
        enums: new Map(),
        functions: new Map(),
        views: new Map(),
        materializedViews: new Map(),
        roles: new Map(),
        extensions: [],
      },
      { pgSchema: 'public' },
    );

    const fkOps = plan.operations.filter((op) => op.type === 'add_foreign_key_not_valid');
    expect(fkOps.length).toBe(1);
    expect(fkOps[0].sql).toContain('NOT VALID');

    const validateOps = plan.operations.filter(
      (op) => op.type === 'validate_constraint' && op.objectName.includes('fk_'),
    );
    expect(validateOps.length).toBe(1);
    expect(validateOps[0].sql).toContain('VALIDATE CONSTRAINT');
  });
});
