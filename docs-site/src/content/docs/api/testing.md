---
title: Testing helpers
description: Isolated test environments with real PostgreSQL databases.
---

Import from `@smplcty/schema-flow/testing`.

## useTestProject

Provisions an isolated PostgreSQL **schema** inside the connection you hand it, plus a temp directory for YAML files. Each call gets a unique schema name (`test_<hex>`), and cleanup drops it with `CASCADE` — so two tests sharing the same database don't see each other's tables, and there is no admin connection, no `DROP DATABASE`, and no `pg_terminate_backend` dance.

Cluster-scoped objects (roles, extensions) are shared across schemas inside one Postgres instance. Tests that introduce roles should use unique names, and can call `registerRole` so they're dropped during cleanup.

```typescript
import { useTestProject, writeSchema } from '@smplcty/schema-flow/testing';

const project = await useTestProject(process.env.DATABASE_URL!);

writeSchema(project.dir, {
  'tables/users.yaml': `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`,
  'enums/status.yaml': `
name: status
values: [active, inactive]
`,
});

// Run migration — operates inside project.schema
const result = await project.migrate({ allowDestructive: false });

// Run drift detection
const drift = await project.drift();

// Register cluster-scoped roles for cleanup
project.registerRole('test_role');

// Clean up: DROP SCHEMA "<project.schema>" CASCADE + drop registered roles + remove temp dir
await project.cleanup();
```

## TestProject interface

```typescript
interface TestProject {
  /** Unique PostgreSQL schema name for this test (`test_<hex>`) */
  schema: string;
  /** Temp directory for YAML files */
  dir: string;
  /** Pre-configured config with `pgSchema` set to `schema` */
  config: SimplicitySchemaConfig;
  /** Connection string the harness was handed (shared across tests) */
  connectionString: string;
  /** Run migration pipeline against this schema */
  migrate: (opts?: { allowDestructive?: boolean }) => Promise<ExecuteResult>;
  /** Run drift detection */
  drift: () => Promise<DriftReport>;
  /** Register a cluster-scoped role for cleanup */
  registerRole: (name: string) => void;
  /** Drop the schema, drop registered roles, remove the temp dir */
  cleanup: () => Promise<void>;
}
```

## writeSchema

Writes YAML files to a directory, creating subdirectories as needed.

```typescript
import { writeSchema } from '@smplcty/schema-flow/testing';

writeSchema('/tmp/test-schema', {
  'tables/users.yaml': '...',
  'tables/orders.yaml': '...',
  'enums/status.yaml': '...',
  'extensions.yaml': '...',
  'mixins/timestamps.yaml': '...',
  'pre/001_cleanup.sql': '...',
});
```

## Example test (Vitest)

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema } from '@smplcty/schema-flow/testing';
import { withClient } from '@smplcty/schema-flow';

describe('users table', () => {
  let project: Awaited<ReturnType<typeof useTestProject>>;

  afterEach(async () => {
    await project?.cleanup();
  });

  it('creates table with columns', async () => {
    project = await useTestProject(process.env.DATABASE_URL!);

    writeSchema(project.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
    unique: true
`,
    });

    const result = await project.migrate();
    expect(result.success).toBe(true);

    // Always scope queries to project.schema — other tests share the database.
    await withClient(project.connectionString, async (client) => {
      const res = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'users'
         ORDER BY ordinal_position`,
        [project.schema],
      );
      expect(res.rows.map((r) => r.column_name)).toEqual(['id', 'email']);
    });
  });
});
```
