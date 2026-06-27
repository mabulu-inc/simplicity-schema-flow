import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { useTestProject, writeSchema } from '../testing/index.js';
import type { TestProject } from '../testing/index.js';

const TEST_URL = process.env.DATABASE_URL!;
let project: TestProject;

beforeAll(async () => {
  project = await useTestProject(TEST_URL);
});

afterAll(async () => {
  await project.cleanup();
});

// Issue #66 (remaining item): a generated policy expression carries a no-op
// cast `auth_in_tenant((tenant_id)::bigint)` where tenant_id is already bigint.
// PG stores it as `auth_in_tenant(tenant_id)`, so unless the desired form is
// normalized identically the policy drops+recreates on every plan/run.
describe('issue #66 — redundant no-op cast in policy expression', () => {
  it('a bigint column passed to a bigint-arg function converges to zero ops', async () => {
    writeSchema(project.dir, {
      'functions/auth_in_tenant.yaml': `
name: auth_in_tenant
language: sql
returns: boolean
args:
  - name: tid
    type: bigint
body: |
  SELECT $1 IS NOT NULL
`,
      'tables/tenants.yaml': `
table: tenants
columns:
  - name: tenant_id
    type: bigserial
    primary_key: true
  - name: name
    type: text
rls: true
policies:
  - name: tenants_select
    for: ALL
    to: public
    using: "auth_in_tenant((tenant_id)::bigint)"
`,
    });

    const result1 = await project.migrate();
    expect(result1.executed).toBeGreaterThan(0);

    // Second run — must be idempotent.
    const result2 = await project.migrate();
    expect(result2.executed).toBe(0);

    // And drift must agree.
    const report = await project.drift();
    const policyDrift = report.items.filter((i) => i.type === 'policy');
    expect(policyDrift).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('a plain bigint (non-serial) FK column converges to zero ops', async () => {
    const sub = await useTestProject(TEST_URL);
    try {
      writeSchema(sub.dir, {
        'functions/auth_can_admin_user.yaml': `
name: auth_can_admin_user
language: sql
returns: boolean
args:
  - name: uid
    type: bigint
body: |
  SELECT $1 IS NOT NULL
`,
        'tables/users.yaml': `
table: users
columns:
  - name: user_id
    type: bigint
    primary_key: true
  - name: email
    type: text
rls: true
policies:
  - name: users_update
    for: UPDATE
    to: public
    using: "auth_can_admin_user((user_id)::bigint)"
`,
      });

      expect((await sub.migrate()).executed).toBeGreaterThan(0);
      expect((await sub.migrate()).executed).toBe(0);
      const report = await sub.drift();
      expect(report.items.filter((i) => i.type === 'policy')).toEqual([]);
    } finally {
      await sub.cleanup();
    }
  });
});
