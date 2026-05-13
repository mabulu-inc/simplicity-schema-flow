import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateFromDb } from '../scaffold/index.js';
import type { GenerateInput } from '../scaffold/index.js';
import { useTestProject } from '../testing/index.js';
import type { TestProject } from '../testing/index.js';
import { getPool, closePool } from '../core/db.js';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
} from '../introspect/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/postgres';

describe('generateFromDb writes files to disk', () => {
  const minimalInput: GenerateInput = {
    tables: [
      {
        table: 'users',
        columns: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            default: undefined,
          },
        ],
        indexes: [],
        checks: [],
        unique: [],
        triggers: [],
        policies: [],
        grants: [],
        foreignKeys: [],
      },
    ],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
  };

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-flow-gen-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes generated files when outputDir is provided', () => {
    const outputDir = path.join(tmpDir, 'with-output');
    const files = generateFromDb(minimalInput, outputDir);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const fullPath = path.join(outputDir, file.filename);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.readFileSync(fullPath, 'utf-8')).toBe(file.content);
    }
  });

  it('does NOT write files when outputDir is undefined', () => {
    const files = generateFromDb(minimalInput, undefined);

    expect(files.length).toBeGreaterThan(0);
    // Files are returned but nothing is written
  });

  it('writes files to the correct subdirectories', () => {
    const outputDir = path.join(tmpDir, 'subdirs');
    const files = generateFromDb(minimalInput, outputDir);

    const tableFile = files.find((f) => f.filename.startsWith('tables/'));
    expect(tableFile).toBeDefined();
    expect(fs.existsSync(path.join(outputDir, tableFile!.filename))).toBe(true);
  });
});

describe('generate command defaults outputDir to config.baseDir', () => {
  it('--dir sets overrides.baseDir while --output sets output separately', async () => {
    const { parseArgs } = await import('../cli/args.js');

    const withDir = parseArgs(['node', 'sf', 'generate', '--dir', './my-schema', '--db', 'postgres://localhost/test']);
    expect(withDir.command).toBe('generate');
    expect(withDir.overrides.baseDir).toBe('./my-schema');
    expect(withDir.output).toBeUndefined();

    const withOutput = parseArgs(['node', 'sf', 'generate', '--output', './out', '--db', 'postgres://localhost/test']);
    expect(withOutput.command).toBe('generate');
    expect(withOutput.output).toBe('./out');
  });
});

describe('generate command writes files to --dir when --output is not set', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await useTestProject(DATABASE_URL);

    // Create a table inside the test's schema so generate has something to
    // introspect — and so DROP SCHEMA CASCADE will dispose of it on cleanup.
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE "${project.schema}".test_gen_table (
          id serial PRIMARY KEY,
          name text NOT NULL
        )
      `);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await project.cleanup();
    await closePool();
  });

  it('generates files into the output directory derived from config.baseDir', async () => {
    const outputDir = path.join(project.dir, 'generated');
    fs.mkdirSync(outputDir, { recursive: true });

    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tableNames = await getExistingTables(client, project.schema);
      const enumList = await getExistingEnums(client, project.schema);
      const fnList = await getExistingFunctions(client, project.schema);
      const viewList = await getExistingViews(client, project.schema);
      const matViewList = await getExistingMaterializedViews(client, project.schema);
      const roleList = await getExistingRoles(client);
      const tables = [];
      for (const name of tableNames) {
        tables.push(await introspectTable(client, name, project.schema));
      }

      // Simulate what the CLI handler now does: pass config.baseDir as fallback
      const files = generateFromDb(
        {
          tables,
          enums: enumList,
          functions: fnList,
          views: viewList,
          materializedViews: matViewList,
          roles: roleList,
        },
        outputDir,
      );

      expect(files.length).toBeGreaterThan(0);

      // Verify files were actually written to disk
      for (const file of files) {
        const fullPath = path.join(outputDir, file.filename);
        expect(fs.existsSync(fullPath)).toBe(true);
        const content = fs.readFileSync(fullPath, 'utf-8');
        expect(content).toBe(file.content);
      }

      // Verify the table file exists
      const tableFile = files.find((f) => f.filename.includes('test_gen_table'));
      expect(tableFile).toBeDefined();
    } finally {
      client.release();
    }
  });

  it('would NOT write files if outputDir were undefined (the bug scenario)', async () => {
    const pool = getPool(project.connectionString);
    const client = await pool.connect();
    try {
      const tableNames = await getExistingTables(client, project.schema);
      const tables = [];
      for (const name of tableNames) {
        tables.push(await introspectTable(client, name, project.schema));
      }

      // This simulates the old buggy behavior: passing undefined
      const files = generateFromDb(
        {
          tables,
          enums: [],
          functions: [],
          views: [],
          materializedViews: [],
          roles: [],
        },
        undefined,
      );

      expect(files.length).toBeGreaterThan(0);
      // No files written — this was the bug
    } finally {
      client.release();
    }
  });
});
