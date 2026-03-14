---
title: Testing helpers
description: Isolated test environments with real PostgreSQL databases.
---

Import from `@mabulu-inc/simplicity-schema/testing`.

## useTestProject

Creates an isolated PostgreSQL database for a test. Each call creates a unique database, so tests don't interfere with each other.

```typescript
import { useTestProject, writeSchema } from '@mabulu-inc/simplicity-schema/testing';

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

// Run migration
const result = await project.migrate({ allowDestructive: false });

// Run drift detection
const drift = await project.drift();

// Register roles for cleanup (roles are cluster-wide)
project.registerRole('test_role');

// Clean up: drops the test database, registered roles, and temp directory
await project.cleanup();
```

## TestProject interface

```typescript
interface TestProject {
  /** Unique PostgreSQL schema name */
  schema: string;
  /** Temp directory for YAML files */
  dir: string;
  /** Pre-configured config */
  config: SimplicitySchemaConfig;
  /** Connection string for isolated database */
  connectionString: string;
  /** Run migration pipeline */
  migrate: (opts?: { allowDestructive?: boolean }) => Promise<ExecuteResult>;
  /** Run drift detection */
  drift: () => Promise<DriftReport>;
  /** Register a role for cleanup */
  registerRole: (name: string) => void;
  /** Drop database, roles, and temp dir */
  cleanup: () => Promise<void>;
}
```

## writeSchema

Writes YAML files to a directory, creating subdirectories as needed.

```typescript
import { writeSchema } from '@mabulu-inc/simplicity-schema/testing';

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
import { useTestProject, writeSchema } from '@mabulu-inc/simplicity-schema/testing';
import { withClient } from '@mabulu-inc/simplicity-schema';

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

    await withClient(project.connectionString, async (client) => {
      const res = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position",
      );
      expect(res.rows.map((r) => r.column_name)).toEqual(['id', 'email']);
    });
  });
});
```
