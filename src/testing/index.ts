/**
 * Test helpers for @mabulu-inc/simplicity-schema.
 *
 * Provides utilities for creating isolated test environments with
 * their own PostgreSQL databases and temp directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getPool, removePool } from '../core/db.js';
import { resolveConfig } from '../core/config.js';
import type { SimplicitySchemaConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { runPipeline } from '../cli/pipeline.js';
import type { ExecuteResult } from '../executor/index.js';
import { discoverSchemaFiles } from '../core/files.js';
import { parseSchemaFile } from '../schema/parser.js';
import { loadMixins, applyMixins } from '../schema/mixins.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
} from '../introspect/index.js';
import { detectDrift } from '../drift/index.js';
import type { DriftReport } from '../drift/index.js';
import type { DesiredState, ActualState } from '../planner/index.js';
import { readFile } from 'node:fs/promises';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ExtensionsSchema,
  MixinSchema,
} from '../schema/types.js';

export interface TestProject {
  /** Unique PostgreSQL schema name for this test */
  schema: string;
  /** Temp directory for YAML files */
  dir: string;
  /** Pre-configured config pointing to this test's schema and dir */
  config: SimplicitySchemaConfig;
  /** Connection string for this test's isolated database */
  connectionString: string;
  /** Run the migration pipeline against this test project */
  migrate: (opts?: { allowDestructive?: boolean }) => Promise<ExecuteResult>;
  /** Run drift detection against this test project */
  drift: () => Promise<DriftReport>;
  /** Register a role to be dropped during cleanup */
  registerRole: (roleName: string) => void;
  /** Clean up: drop database, registered roles, and remove temp dir */
  cleanup: () => Promise<void>;
}

/**
 * Build a connection string pointing to a different database.
 */
function replaceDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Create an isolated test project with its own PostgreSQL database and temp directory.
 */
export async function useTestProject(connectionString: string): Promise<TestProject> {
  const id = crypto.randomBytes(8).toString('hex');
  const dbName = `test_${id}`;
  const schema = 'public';
  const dir = fs.mkdtempSync('/tmp/simplicity-test-');

  // Create an isolated database using the admin connection
  const adminPool = getPool(connectionString);
  const adminClient = await adminPool.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    adminClient.release();
  }

  const testConnectionString = replaceDatabase(connectionString, dbName);

  const config = resolveConfig({
    connectionString: testConnectionString,
    baseDir: dir,
    pgSchema: schema,
    allowDestructive: false,
  });

  const logger = createLogger({ verbose: false, quiet: true, json: false });
  const rolesToCleanup: string[] = [];

  function registerRole(roleName: string): void {
    if (!rolesToCleanup.includes(roleName)) {
      rolesToCleanup.push(roleName);
    }
  }

  async function migrate(opts?: { allowDestructive?: boolean }): Promise<ExecuteResult> {
    const migrationConfig = {
      ...config,
      allowDestructive: opts?.allowDestructive ?? false,
    };
    return runPipeline(migrationConfig, logger);
  }

  async function drift(): Promise<DriftReport> {
    const desired = await parseDesiredState(dir, logger);
    const actual = await introspectActual(testConnectionString, schema);
    return detectDrift(desired, actual);
  }

  async function cleanup(): Promise<void> {
    // Close and remove the pool for this test database before dropping it
    await removePool(testConnectionString);

    const adminPool = getPool(connectionString);
    const adminClient = await adminPool.connect();
    try {
      // Terminate any remaining connections to the test database
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid != pg_backend_pid()`,
        [dbName],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);

      // Drop any roles registered for cleanup (roles are cluster-wide)
      for (const role of rolesToCleanup) {
        await adminClient.query(`DROP OWNED BY "${role}"`).catch(() => {});
        await adminClient.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    } finally {
      adminClient.release();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { schema, dir, config, connectionString: testConnectionString, migrate, drift, cleanup, registerRole };
}

/**
 * Write YAML files to a directory, creating subdirectories as needed.
 */
export function writeSchema(dir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
}

// ─── Internal helpers ──────────────────────────────────────────

async function parseDesiredState(baseDir: string, _logger: ReturnType<typeof createLogger>): Promise<DesiredState> {
  const discovered = await discoverSchemaFiles(baseDir);
  const tables: TableSchema[] = [];
  const enums: EnumSchema[] = [];
  const functions: FunctionSchema[] = [];
  const views: ViewSchema[] = [];
  const materializedViews: MaterializedViewSchema[] = [];
  const roles: RoleSchema[] = [];
  const mixinSchemas: MixinSchema[] = [];
  let extensions: ExtensionsSchema | null = null;

  for (const file of discovered.schema) {
    const content = await readFile(file.absolutePath, 'utf-8');
    const parsed = parseSchemaFile(content);
    switch (parsed.kind) {
      case 'table':
        tables.push(parsed.schema);
        break;
      case 'enum':
        enums.push(parsed.schema);
        break;
      case 'function':
        functions.push(parsed.schema);
        break;
      case 'view':
        views.push(parsed.schema);
        break;
      case 'materialized_view':
        materializedViews.push(parsed.schema);
        break;
      case 'role':
        roles.push(parsed.schema);
        break;
      case 'extensions':
        extensions = parsed.schema;
        break;
      case 'mixin':
        mixinSchemas.push(parsed.schema);
        break;
    }
  }

  if (mixinSchemas.length > 0) {
    const registry = loadMixins(mixinSchemas);
    for (let i = 0; i < tables.length; i++) {
      tables[i] = applyMixins(tables[i], registry);
    }
  }

  return { tables, enums, functions, views, materializedViews, roles, extensions };
}

async function introspectActual(connectionString: string, pgSchema: string): Promise<ActualState> {
  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    const tableNames = await getExistingTables(client, pgSchema);
    const enumList = await getExistingEnums(client, pgSchema);
    const fnList = await getExistingFunctions(client, pgSchema);
    const viewList = await getExistingViews(client, pgSchema);
    const matViewList = await getExistingMaterializedViews(client, pgSchema);
    const roleList = await getExistingRoles(client);

    const tablesMap = new Map<string, TableSchema>();
    for (const name of tableNames) {
      const table = await introspectTable(client, name, pgSchema);
      tablesMap.set(name, table);
    }

    const enumsMap = new Map<string, EnumSchema>();
    for (const e of enumList) enumsMap.set(e.name, e);

    const functionsMap = new Map<string, FunctionSchema>();
    for (const f of fnList) functionsMap.set(f.name, f);

    const viewsMap = new Map<string, ViewSchema>();
    for (const v of viewList) viewsMap.set(v.name, v);

    const matViewsMap = new Map<string, MaterializedViewSchema>();
    for (const mv of matViewList) matViewsMap.set(mv.name, mv);

    const rolesMap = new Map<string, RoleSchema>();
    for (const r of roleList) rolesMap.set(r.role, r);

    const extResult = await client.query("SELECT extname FROM pg_extension WHERE extname != 'plpgsql'");
    const extensions = extResult.rows.map((r: { extname: string }) => r.extname);

    return {
      tables: tablesMap,
      enums: enumsMap,
      functions: functionsMap,
      views: viewsMap,
      materializedViews: matViewsMap,
      roles: rolesMap,
      extensions,
    };
  } finally {
    client.release();
  }
}
