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
import { runPipeline, buildDesiredAndActual } from '../cli/pipeline.js';
import type { ExecuteResult } from '../executor/index.js';
import { detectDrift } from '../drift/index.js';
import type { DriftReport } from '../drift/index.js';

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
    // Mirror the real `drift` CLI command exactly (cli/index.ts) — build desired
    // and actual through the shared pipeline so the test harness exercises the
    // same SQL-expression normalization the command applies. Reimplementing the
    // path here would let the harness mask drift-vs-plan divergence (issue #66).
    const { desired, actual } = await buildDesiredAndActual(config, logger);
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
