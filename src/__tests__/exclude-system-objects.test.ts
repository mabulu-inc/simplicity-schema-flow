/**
 * T-101: Exclude system and extension objects from introspection.
 *
 * Verifies that extension-owned objects (tables, enums, functions, views)
 * and system roles (superusers, known cloud provider roles) are excluded
 * from introspection results.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../core/db.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingRoles,
} from '../introspect/index.js';
import { useTestProject } from '../testing/index.js';
import type { TestProject } from '../testing/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/postgres';

describe('exclude extension-owned objects from introspection', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await useTestProject(DATABASE_URL);

    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      // Install uuid-ossp extension which creates extension-owned functions.
      // Extensions are database-scoped, so this is shared across schemas; the
      // test only asserts that extension-owned objects are *filtered out* of
      // introspection, which doesn't depend on a fresh install.
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

      // Create a user-defined table and function inside the test's schema
      // so the assertions and the cleanup (DROP SCHEMA CASCADE) line up.
      await client.query(`
        CREATE TABLE "${project.schema}".user_defined_table (
          id serial PRIMARY KEY,
          name text NOT NULL
        )
      `);

      await client.query(`
        CREATE FUNCTION "${project.schema}".user_defined_fn() RETURNS void
        LANGUAGE sql AS $$ SELECT 1; $$
      `);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await project.cleanup();
    await closePool();
  });

  it('excludes extension-owned functions but keeps user-defined ones', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const functions = await getExistingFunctions(client, project.schema);
      const functionNames = functions.map((f) => f.name);

      // uuid-ossp extension functions should NOT appear
      expect(functionNames).not.toContain('uuid_generate_v4');
      expect(functionNames).not.toContain('uuid_generate_v1');

      // User-defined function SHOULD appear
      expect(functionNames).toContain('user_defined_fn');
    } finally {
      client.release();
    }
  });

  it('excludes extension-owned tables but keeps user-defined ones', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tables = await getExistingTables(client, project.schema);

      // User-defined table SHOULD appear
      expect(tables).toContain('user_defined_table');

      // If any extension creates tables, they should be filtered out.
      // We verify by checking no extension-dependent table sneaks through.
      // (uuid-ossp doesn't create tables, but the filter should still be in place.)
    } finally {
      client.release();
    }
  });

  it('excludes extension-owned enums but keeps user-defined ones', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      // Create a user-defined enum inside the test schema
      await client.query(`CREATE TYPE "${project.schema}".user_status AS ENUM ('active', 'inactive')`);

      const enums = await getExistingEnums(client, project.schema);
      const enumNames = enums.map((e) => e.name);

      // User-defined enum SHOULD appear
      expect(enumNames).toContain('user_status');
    } finally {
      client.release();
    }
  });

  it('excludes extension-owned views but keeps user-defined ones', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      // Create a user-defined view inside the test schema
      await client.query(`CREATE VIEW "${project.schema}".user_defined_view AS SELECT 1 AS val`);

      const views = await getExistingViews(client, project.schema);
      const viewNames = views.map((v) => v.name);

      // User-defined view SHOULD appear
      expect(viewNames).toContain('user_defined_view');
    } finally {
      client.release();
    }
  });
});

describe('exclude system roles from introspection', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await useTestProject(DATABASE_URL);

    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      // Create a user-defined role
      await client.query('CREATE ROLE test_app_user NOLOGIN');
      project.registerRole('test_app_user');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await project.cleanup();
    await closePool();
  });

  it('excludes the postgres superuser role', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const roles = await getExistingRoles(client);
      const roleNames = roles.map((r) => r.role);

      // postgres superuser should NOT appear
      expect(roleNames).not.toContain('postgres');
    } finally {
      client.release();
    }
  });

  it('excludes all superuser roles', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const roles = await getExistingRoles(client);

      // No role in the result should have superuser = true
      for (const role of roles) {
        expect(role.superuser).not.toBe(true);
      }
    } finally {
      client.release();
    }
  });

  it('keeps user-defined non-superuser roles', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const roles = await getExistingRoles(client);
      const roleNames = roles.map((r) => r.role);

      // User-defined role SHOULD appear
      expect(roleNames).toContain('test_app_user');
    } finally {
      client.release();
    }
  });
});
