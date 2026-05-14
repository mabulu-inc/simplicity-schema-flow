import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { getPlan } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';
import { lintPlan } from '../../src/lint/index.js';

/** Remove all YAML files from a test project directory so writeSchema starts fresh. */
function clearSchema(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      fs.unlinkSync(full);
    }
  }
}

const logger = createLogger({ verbose: false, quiet: true, json: false });

describe('E2E: Lint rules', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // ── 1. drop-table ─────────────────────────────────────────────

  it('(1) drop-table: plan that drops a table triggers warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
`,
      'tables/keeper.yaml': `
table: keeper
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await ctx.migrate();

    // Remove users table from YAML — creates a drop_table plan
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/keeper.yaml': `
table: keeper
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const plan = await getPlan({ ...ctx.config, allowDestructive: true }, logger);
    const result = lintPlan(plan);

    const dropTableWarnings = result.warnings.filter((w) => w.rule === 'drop-table');
    expect(dropTableWarnings).toHaveLength(1);
    expect(dropTableWarnings[0].severity).toBe('warning');
    expect(dropTableWarnings[0].objectName).toContain('users');
  });

  // ── 2. drop-column ────────────────────────────────────────────

  it('(2) drop-column: plan that drops a column triggers warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: serial
    primary_key: true
  - name: description
    type: text
`,
    });

    await ctx.migrate();

    // Remove description column
    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const plan = await getPlan({ ...ctx.config, allowDestructive: true }, logger);
    const result = lintPlan(plan);

    const dropColWarnings = result.warnings.filter((w) => w.rule === 'drop-column');
    expect(dropColWarnings).toHaveLength(1);
    expect(dropColWarnings[0].severity).toBe('warning');
    expect(dropColWarnings[0].objectName).toContain('products');
  });

  // ── 3. set-not-null-direct ────────────────────────────────────

  it('(3) set-not-null-direct: safe CHECK pattern does not trigger warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: true
`,
    });

    await ctx.migrate();

    // Change nullable to false — planner uses safe CHECK pattern (§8.3)
    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
`,
    });

    const plan = await getPlan(ctx.config, logger);

    // Verify the plan defers NOT NULL enforcement to a tighten_not_null op
    // (the multi-statement SQL still contains the IS NOT NULL CHECK).
    const tightenOps = plan.operations.filter((o) => o.type === 'tighten_not_null' && /IS\s+NOT\s+NULL/i.test(o.sql));
    expect(tightenOps.length).toBeGreaterThanOrEqual(1);

    const result = lintPlan(plan);

    // Safe pattern should NOT trigger set-not-null-direct
    const setNotNullWarnings = result.warnings.filter((w) => w.rule === 'set-not-null-direct');
    expect(setNotNullWarnings).toHaveLength(0);
  });

  // ── 4. add-column-with-default ────────────────────────────────

  it('(4) add-column-with-default: column with volatile default triggers warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/events.yaml': `
table: events
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    await ctx.migrate();

    // Add a column with a volatile default (now())
    writeSchema(ctx.dir, {
      'tables/events.yaml': `
table: events
columns:
  - name: id
    type: serial
    primary_key: true
  - name: created_at
    type: timestamptz
    default: now()
`,
    });

    const plan = await getPlan(ctx.config, logger);
    const result = lintPlan(plan);

    const volatileWarnings = result.warnings.filter((w) => w.rule === 'add-column-with-default');
    expect(volatileWarnings).toHaveLength(1);
    expect(volatileWarnings[0].severity).toBe('warning');
    expect(volatileWarnings[0].objectName).toContain('events');
  });

  // ── 5. type-narrowing ─────────────────────────────────────────

  it('(5) type-narrowing: text→varchar triggers warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/profiles.yaml': `
table: profiles
columns:
  - name: id
    type: serial
    primary_key: true
  - name: bio
    type: text
`,
    });

    await ctx.migrate();

    // Narrow text to varchar(255)
    writeSchema(ctx.dir, {
      'tables/profiles.yaml': `
table: profiles
columns:
  - name: id
    type: serial
    primary_key: true
  - name: bio
    type: varchar(255)
`,
    });

    const plan = await getPlan(ctx.config, logger);
    const result = lintPlan(plan);

    const narrowWarnings = result.warnings.filter((w) => w.rule === 'type-narrowing');
    expect(narrowWarnings).toHaveLength(1);
    expect(narrowWarnings[0].severity).toBe('warning');
    expect(narrowWarnings[0].objectName).toContain('profiles');
  });

  // ── 6. type-change ────────────────────────────────────────────

  it('(6) type-change: integer→bigint triggers warning', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/counters.yaml': `
table: counters
columns:
  - name: id
    type: serial
    primary_key: true
  - name: count
    type: integer
`,
    });

    await ctx.migrate();

    // Change type from integer to bigint
    writeSchema(ctx.dir, {
      'tables/counters.yaml': `
table: counters
columns:
  - name: id
    type: serial
    primary_key: true
  - name: count
    type: bigint
`,
    });

    const plan = await getPlan(ctx.config, logger);
    const result = lintPlan(plan);

    const typeChangeWarnings = result.warnings.filter((w) => w.rule === 'type-change');
    expect(typeChangeWarnings).toHaveLength(1);
    expect(typeChangeWarnings[0].severity).toBe('warning');
    expect(typeChangeWarnings[0].objectName).toContain('counters');
  });

  // ── 7. missing-fk-index ───────────────────────────────────────

  it('(7) missing-fk-index: FK column without index triggers info', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create parent and child tables — child has FK but no index
    writeSchema(ctx.dir, {
      'tables/parent.yaml': `
table: parent
columns:
  - name: id
    type: serial
    primary_key: true
`,
      'tables/child.yaml': `
table: child
columns:
  - name: id
    type: serial
    primary_key: true
  - name: parent_id
    type: integer
    references:
      table: parent
      column: id
`,
    });

    const plan = await getPlan(ctx.config, logger);
    const result = lintPlan(plan);

    const fkIndexWarnings = result.warnings.filter((w) => w.rule === 'missing-fk-index');
    expect(fkIndexWarnings).toHaveLength(1);
    expect(fkIndexWarnings[0].severity).toBe('info');
    expect(fkIndexWarnings[0].objectName).toContain('child');
  });

  // ── 8. rename-detection ───────────────────────────────────────

  it('(8) rename-detection: drop+add same type triggers info', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: old_name
    type: text
`,
    });

    await ctx.migrate();

    // Drop old_name, add new_name — same type
    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: new_name
    type: text
`,
    });

    const plan = await getPlan({ ...ctx.config, allowDestructive: true }, logger);
    const result = lintPlan(plan);

    const renameWarnings = result.warnings.filter((w) => w.rule === 'rename-detection');
    expect(renameWarnings).toHaveLength(1);
    expect(renameWarnings[0].severity).toBe('info');
    expect(renameWarnings[0].objectName).toContain('items');
  });

  // ── Lint result structure ─────────────────────────────────────

  it('lint result has correct structure and summary', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/struct_test.yaml': `
table: struct_test
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
`,
    });

    await ctx.migrate();

    // Remove a column (drop-column warning) and remove table file (drop-table if we remove it)
    clearSchema(ctx.dir);
    writeSchema(ctx.dir, {
      'tables/struct_test.yaml': `
table: struct_test
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const plan = await getPlan({ ...ctx.config, allowDestructive: true }, logger);
    const result = lintPlan(plan);

    // Verify structure
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('summary');
    expect(result.summary).toHaveProperty('total');
    expect(result.summary).toHaveProperty('bySeverity');
    expect(result.summary.bySeverity).toHaveProperty('warning');
    expect(result.summary.bySeverity).toHaveProperty('info');

    // Summary total should match warnings length
    expect(result.summary.total).toBe(result.warnings.length);

    // Each warning should have the required fields
    for (const w of result.warnings) {
      expect(w).toHaveProperty('rule');
      expect(w).toHaveProperty('severity');
      expect(w).toHaveProperty('objectName');
      expect(w).toHaveProperty('message');
      expect(w).toHaveProperty('sql');
    }
  });
});
