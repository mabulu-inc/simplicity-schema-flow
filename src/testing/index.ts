/**
 * Test helpers for @mabulu-inc/simplicity-schema.
 *
 * Provides utilities for creating isolated test environments with
 * their own PostgreSQL schemas and temp directories.
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
  /** Run the migration pipeline against this test project */
  migrate: (opts?: { allowDestructive?: boolean }) => Promise<ExecuteResult>;
  /** Run drift detection against this test project */
  drift: () => Promise<DriftReport>;
  /** Clean up: drop schema and remove temp dir */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test project with its own PG schema and temp directory.
 */
export async function useTestProject(connectionString: string): Promise<TestProject> {
  const id = crypto.randomBytes(8).toString('hex');
  const schema = `test_${id}`;
  const dir = fs.mkdtempSync('/tmp/simplicity-test-');

  // Create the PG schema
  const pool = getPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    client.release();
  }

  const config = resolveConfig({
    connectionString,
    baseDir: dir,
    pgSchema: schema,
    allowDestructive: false,
  });

  const logger = createLogger({ verbose: false, quiet: true, json: false });

  async function migrate(opts?: { allowDestructive?: boolean }): Promise<ExecuteResult> {
    const migrationConfig = {
      ...config,
      allowDestructive: opts?.allowDestructive ?? false,
    };
    return runPipeline(migrationConfig, logger);
  }

  async function drift(): Promise<DriftReport> {
    const desired = await parseDesiredState(dir, logger);
    const actual = await introspectActual(connectionString, schema);
    return detectDrift(desired, actual);
  }

  async function cleanup(): Promise<void> {
    const pool = getPool(connectionString);
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      client.release();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { schema, dir, config, migrate, drift, cleanup };
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
    const [tableNames, enumList, fnList, viewList, matViewList, roleList] = await Promise.all([
      getExistingTables(client, pgSchema),
      getExistingEnums(client, pgSchema),
      getExistingFunctions(client, pgSchema),
      getExistingViews(client, pgSchema),
      getExistingMaterializedViews(client, pgSchema),
      getExistingRoles(client),
    ]);

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
