import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

/**
 * Unique role name helper to avoid collisions across parallel test runs.
 */
let counter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${counter++}`;
}

describe('E2E: Roles and Extensions', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // ─── Roles ──────────────────────────────────────────────────────

  it('creates a role with all attributes', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('app_service');
    ctx.registerRole(roleName);

    writeSchema(ctx.dir, {
      [`roles/${roleName}.yaml`]: `
role: ${roleName}
login: true
superuser: false
createdb: true
createrole: true
inherit: true
bypassrls: false
replication: false
connection_limit: 10
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolinherit, rolbypassrls, rolreplication, rolconnlimit
       FROM pg_roles WHERE rolname = $1`,
      [roleName],
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    expect(row.rolcanlogin).toBe(true);
    expect(row.rolsuper).toBe(false);
    expect(row.rolcreatedb).toBe(true);
    expect(row.rolcreaterole).toBe(true);
    expect(row.rolinherit).toBe(true);
    expect(row.rolbypassrls).toBe(false);
    expect(row.rolreplication).toBe(false);
    expect(row.rolconnlimit).toBe(10);
  });

  it('creates a role with group membership', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const groupName = uniqueRole('app_group');
    const memberName = uniqueRole('app_member');
    ctx.registerRole(memberName);
    ctx.registerRole(groupName);

    // Pre-create the group role so GRANT ... TO ... can reference it
    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${groupName}') THEN
          CREATE ROLE "${groupName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      [`roles/${memberName}.yaml`]: `
role: ${memberName}
login: true
in:
  - ${groupName}
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT r.rolname AS member, g.rolname AS group_name
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
       WHERE r.rolname = $1 AND g.rolname = $2`,
      [memberName, groupName],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].member).toBe(memberName);
    expect(result.rows[0].group_name).toBe(groupName);
  });

  it('orders role apply so a member_of parent is created before its child (#50)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const parentName = uniqueRole('app_user');
    const childName = uniqueRole('app_admin');
    ctx.registerRole(childName);
    ctx.registerRole(parentName);

    // Both roles are new and declared together. The child's GRANT references the
    // parent, so the apply must create the parent first — purely from member_of,
    // not file/alphabetical order.
    writeSchema(ctx.dir, {
      [`roles/${childName}.yaml`]: `
role: ${childName}
login: true
member_of:
  - ${parentName}
`,
      [`roles/${parentName}.yaml`]: `
role: ${parentName}
login: false
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT r.rolname AS member, g.rolname AS group_name
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
       WHERE r.rolname = $1 AND g.rolname = $2`,
      [childName, parentName],
    );
    expect(result.rowCount).toBe(1);
  });

  it('revokes a membership removed from member_of on the next apply (#50)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const parentName = uniqueRole('app_user');
    const childName = uniqueRole('app_admin');
    ctx.registerRole(childName);
    ctx.registerRole(parentName);

    const membershipCount = async () =>
      (
        await queryDb(
          ctx,
          `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.member
           JOIN pg_roles g ON g.oid = m.roleid
           WHERE r.rolname = $1 AND g.rolname = $2`,
          [childName, parentName],
        )
      ).rowCount;

    writeSchema(ctx.dir, {
      [`roles/${childName}.yaml`]: `\nrole: ${childName}\nlogin: true\nmember_of:\n  - ${parentName}\n`,
      [`roles/${parentName}.yaml`]: `\nrole: ${parentName}\nlogin: false\n`,
    });
    await runMigration(ctx);
    expect(await membershipCount()).toBe(1);

    // Remove the membership from the child's YAML — apply should REVOKE it.
    writeSchema(ctx.dir, {
      [`roles/${childName}.yaml`]: `\nrole: ${childName}\nlogin: true\nmember_of: []\n`,
      [`roles/${parentName}.yaml`]: `\nrole: ${parentName}\nlogin: false\n`,
    });
    await runMigration(ctx, { allowDestructive: true });
    expect(await membershipCount()).toBe(0);
  });

  it('sets a role comment', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('commented_role');
    ctx.registerRole(roleName);

    writeSchema(ctx.dir, {
      [`roles/${roleName}.yaml`]: `
role: ${roleName}
login: false
comment: 'Read-only application role'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT shobj_description(oid, 'pg_authid') AS comment
       FROM pg_roles WHERE rolname = $1`,
      [roleName],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Read-only application role');
  });

  it('alters a role when attributes change', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('mutable_role');
    ctx.registerRole(roleName);

    // First migration: login=false
    writeSchema(ctx.dir, {
      [`roles/${roleName}.yaml`]: `
role: ${roleName}
login: false
createdb: false
`,
    });
    await runMigration(ctx);

    let result = await queryDb(ctx, `SELECT rolcanlogin, rolcreatedb FROM pg_roles WHERE rolname = $1`, [roleName]);
    expect(result.rows[0].rolcanlogin).toBe(false);
    expect(result.rows[0].rolcreatedb).toBe(false);

    // Second migration: change login to true, createdb to true
    writeSchema(ctx.dir, {
      [`roles/${roleName}.yaml`]: `
role: ${roleName}
login: true
createdb: true
`,
    });
    await runMigration(ctx);

    result = await queryDb(ctx, `SELECT rolcanlogin, rolcreatedb FROM pg_roles WHERE rolname = $1`, [roleName]);
    expect(result.rows[0].rolcanlogin).toBe(true);
    expect(result.rows[0].rolcreatedb).toBe(true);
  });

  it('creates multiple roles with memberships', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const groupName = uniqueRole('team_group');
    const role1 = uniqueRole('team_member1');
    const role2 = uniqueRole('team_member2');
    ctx.registerRole(role1);
    ctx.registerRole(role2);
    ctx.registerRole(groupName);

    // Pre-create the group
    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${groupName}') THEN
          CREATE ROLE "${groupName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      [`roles/${role1}.yaml`]: `
role: ${role1}
login: true
in:
  - ${groupName}
`,
      [`roles/${role2}.yaml`]: `
role: ${role2}
login: false
in:
  - ${groupName}
`,
    });

    await runMigration(ctx);

    // Verify both roles exist
    const rolesResult = await queryDb(ctx, `SELECT rolname FROM pg_roles WHERE rolname IN ($1, $2) ORDER BY rolname`, [
      role1,
      role2,
    ]);
    expect(rolesResult.rowCount).toBe(2);

    // Verify both are members of the group
    const membersResult = await queryDb(
      ctx,
      `SELECT r.rolname AS member
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
       WHERE g.rolname = $1
       ORDER BY r.rolname`,
      [groupName],
    );
    expect(membersResult.rowCount).toBe(2);
    const members = membersResult.rows.map((r: { member: string }) => r.member);
    expect(members).toContain(role1);
    expect(members).toContain(role2);
  });

  // ─── Extensions ─────────────────────────────────────────────────

  it('creates an extension', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].extname).toBe('pgcrypto');
  });

  it('creates an extension with schema_grants', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('ext_user');
    ctx.registerRole(roleName);

    // Pre-create the role for the grant
    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
schema_grants:
  - to: ${roleName}
    schemas:
      - public
`,
    });

    await runMigration(ctx);

    // Verify the extension exists
    const extResult = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(extResult.rowCount).toBe(1);

    // Verify the schema grant
    const grantResult = await queryDb(
      ctx,
      `SELECT has_schema_privilege('${roleName}', 'public', 'USAGE') AS has_usage`,
    );
    expect(grantResult.rows[0].has_usage).toBe(true);
  });

  it('blocks extension drop without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First: create the extension
    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
`,
    });
    await runMigration(ctx);

    // Verify the extension exists
    let result = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(result.rowCount).toBe(1);

    // Second: remove the extensions.yaml file so extensions list is empty
    fs.unlinkSync(path.join(ctx.dir, 'extensions.yaml'));
    await runMigration(ctx);

    // Extension should still exist because drop was blocked
    result = await queryDb(ctx, `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    expect(result.rowCount).toBe(1);
  });
});
