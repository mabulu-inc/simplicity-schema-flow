import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { useTestProject, writeSchema } from '../testing/index.js';
import type { TestProject } from '../testing/index.js';
import { normalizePolicyExpressions } from '../planner/normalize-expression.js';
import { getPool } from '../core/db.js';
import type { TableSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
let project: TestProject;

beforeAll(async () => {
  project = await useTestProject(TEST_URL);
});

afterAll(async () => {
  await project.cleanup();
});

function makeTable(
  name: string,
  columns: { name: string; type: string }[],
  policies: TableSchema['policies'],
): TableSchema {
  return {
    table: name,
    columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: false })),
    policies,
    rls: true,
  };
}

describe('normalizePolicyExpressions', () => {
  it('normalizes a USING expression to match pg_get_expr output', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables: TableSchema[] = [
        makeTable(
          'test_norm',
          [
            { name: 'id', type: 'uuid' },
            { name: 'tenant_id', type: 'uuid' },
          ],
          [
            {
              name: 'tenant_isolation',
              for: 'ALL',
              to: 'public',
              using: "tenant_id = current_setting('app.current_tenant')::uuid",
            },
          ],
        ),
      ];

      await normalizePolicyExpressions(client, tables);

      // PG normalizes: wraps in parens, adds ::text to string literals, wraps function calls
      expect(tables[0].policies![0].using).toBe("(tenant_id = (current_setting('app.current_tenant'::text))::uuid)");
    } finally {
      client.release();
    }
  });

  it('normalizes a CHECK expression', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables: TableSchema[] = [
        makeTable(
          'test_check_norm',
          [
            { name: 'id', type: 'uuid' },
            { name: 'org_id', type: 'uuid' },
          ],
          [
            {
              name: 'org_insert',
              for: 'INSERT',
              to: 'public',
              check: "org_id = current_setting('app.org_id')::uuid",
            },
          ],
        ),
      ];

      await normalizePolicyExpressions(client, tables);

      expect(tables[0].policies![0].check).toBe("(org_id = (current_setting('app.org_id'::text))::uuid)");
    } finally {
      client.release();
    }
  });

  it('leaves tables without policies unchanged', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables: TableSchema[] = [makeTable('test_no_policies', [{ name: 'id', type: 'uuid' }], [])];

      await normalizePolicyExpressions(client, tables);
      expect(tables[0].policies).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('returns original expression when normalization fails (invalid SQL)', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables: TableSchema[] = [
        makeTable(
          'test_invalid',
          [{ name: 'id', type: 'uuid' }],
          [{ name: 'bad_policy', for: 'ALL', to: 'public', using: 'INVALID SQL %%% EXPR' }],
        ),
      ];

      await normalizePolicyExpressions(client, tables);
      // Falls back to original expression on error
      expect(tables[0].policies![0].using).toBe('INVALID SQL %%% EXPR');
    } finally {
      client.release();
    }
  });

  it('handles simple boolean expressions without modification', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables: TableSchema[] = [
        makeTable(
          'test_simple',
          [{ name: 'id', type: 'uuid' }],
          [{ name: 'allow_all', for: 'ALL', to: 'public', using: 'true' }],
        ),
      ];

      await normalizePolicyExpressions(client, tables);
      expect(tables[0].policies![0].using).toBe('true');
    } finally {
      client.release();
    }
  });
});

describe('RLS policy idempotent plan (E2E)', () => {
  it('produces 0 operations on second run for USING policy', async () => {
    writeSchema(project.dir, {
      'tables/tenants.yaml': `
table: tenants
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: tenant_id
    type: uuid
  - name: name
    type: text
rls: true
policies:
  - name: tenant_isolation
    for: ALL
    to: public
    using: "tenant_id = current_setting('app.current_tenant')::uuid"
`,
    });

    // First run — creates table, enables RLS, creates policy
    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    // Second run — should be idempotent (0 operations)
    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);
  });

  it('produces 0 operations for policies with both USING and CHECK', async () => {
    writeSchema(project.dir, {
      'tables/documents.yaml': `
table: documents
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: org_id
    type: uuid
  - name: title
    type: text
rls: true
policies:
  - name: org_read
    for: SELECT
    to: public
    using: "org_id = current_setting('app.org_id')::uuid"
  - name: org_insert
    for: INSERT
    to: public
    check: "org_id = current_setting('app.org_id')::uuid"
`,
    });

    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);
  });
});
