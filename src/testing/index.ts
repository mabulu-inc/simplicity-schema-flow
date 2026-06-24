/**
 * Test helpers for @smplcty/schema-flow.
 *
 * Each `useTestProject` call provisions a fresh PostgreSQL **schema** (not a
 * fresh database) inside the existing connection. Migrations run against that
 * schema; cleanup drops it with `CASCADE`, which dissolves every contained
 * object in one statement and doesn't care about connected clients — so there
 * is no admin pool, no `pg_terminate_backend`, and no `DROP DATABASE` race.
 *
 * Cluster-wide state (roles, extensions) is intentionally shared across tests
 * inside the same Postgres instance. Tests that introduce cluster-scoped
 * objects use unique names so they don't collide; `registerRole` records role
 * names that should be dropped at cleanup so the cluster doesn't accumulate
 * them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getPool } from '../core/db.js';
import { resolveConfig } from '../core/config.js';
import type { SimplicitySchemaConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { runPipeline } from '../cli/pipeline.js';
import type { ExecuteResult } from '../executor/index.js';
import { discoverAllSources, resolveImportParams } from '../core/sources.js';
import { buildDesiredState } from '../schema/desired-state.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
  getPartitionMaintenance,
} from '../introspect/index.js';
import { detectDrift, hydrateActualSeeds } from '../drift/index.js';
import type { DriftReport } from '../drift/index.js';
import type { ActualState } from '../planner/index.js';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
} from '../schema/types.js';

export interface TestProject {
  /** Unique PostgreSQL schema name for this test */
  schema: string;
  /** Temp directory for YAML files */
  dir: string;
  /** Pre-configured config pointing to this test's schema and dir */
  config: SimplicitySchemaConfig;
  /** Connection string for this test (same DATABASE_URL the harness was given) */
  connectionString: string;
  /** Run the migration pipeline against this test project */
  migrate: (opts?: { allowDestructive?: boolean }) => Promise<ExecuteResult>;
  /** Run drift detection against this test project */
  drift: () => Promise<DriftReport>;
  /** Register a cluster-scoped role to be dropped during cleanup */
  registerRole: (roleName: string) => void;
  /** Clean up: drop the test schema, drop registered roles, remove temp dir */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test project backed by a fresh PostgreSQL schema.
 */
export async function useTestProject(connectionString: string): Promise<TestProject> {
  const id = crypto.randomBytes(8).toString('hex');
  const schema = `test_${id}`;
  const dir = fs.mkdtempSync('/tmp/simplicity-test-');

  const pool = getPool(connectionString);
  const setupClient = await pool.connect();
  try {
    await setupClient.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    setupClient.release();
  }

  const config = resolveConfig({
    connectionString,
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
    return runPipeline({ ...config, allowDestructive: opts?.allowDestructive ?? false }, logger);
  }

  async function drift(): Promise<DriftReport> {
    const discovered = await discoverAllSources(config);
    const desired = await buildDesiredState(discovered.schema, { importParams: resolveImportParams(config) });
    const actual = await introspectActual(connectionString, schema);

    const driftClient = await pool.connect();
    try {
      await hydrateActualSeeds(driftClient, desired.tables, actual.tables, schema);
    } finally {
      driftClient.release();
    }

    return detectDrift(desired, actual);
  }

  async function cleanup(): Promise<void> {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

      for (const role of rolesToCleanup) {
        await cleanupClient.query(`DROP OWNED BY "${role}"`).catch(() => {});
        await cleanupClient.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    } finally {
      cleanupClient.release();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { schema, dir, config, connectionString, migrate, drift, registerRole, cleanup };
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
    const partitionMaintenance = await getPartitionMaintenance(client);

    return {
      tables: tablesMap,
      enums: enumsMap,
      functions: functionsMap,
      views: viewsMap,
      materializedViews: matViewsMap,
      roles: rolesMap,
      extensions,
      partitionMaintenance,
    };
  } finally {
    client.release();
  }
}
