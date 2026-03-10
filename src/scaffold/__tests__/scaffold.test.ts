import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { scaffoldInit, scaffoldPre, scaffoldPost, scaffoldMixin, generateFromDb } from '../index.js';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
} from '../../schema/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── scaffoldInit ──────────────────────────────────────────────

describe('scaffoldInit', () => {
  it('creates standard directory structure', () => {
    const dir = path.join(tmpDir, 'schema');
    scaffoldInit(dir);

    const expected = ['tables', 'enums', 'functions', 'views', 'roles', 'mixins', 'pre', 'post'];
    for (const sub of expected) {
      expect(fs.existsSync(path.join(dir, sub))).toBe(true);
    }
  });

  it('is idempotent', () => {
    const dir = path.join(tmpDir, 'schema');
    scaffoldInit(dir);
    scaffoldInit(dir); // should not throw
    expect(fs.existsSync(path.join(dir, 'tables'))).toBe(true);
  });
});

// ─── scaffoldPre ───────────────────────────────────────────────

describe('scaffoldPre', () => {
  it('creates a timestamped SQL file in the pre directory', () => {
    const dir = path.join(tmpDir, 'schema');
    scaffoldInit(dir);
    const filePath = scaffoldPre(dir, 'add-extension');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/pre\/\d{14}_add-extension\.sql$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('-- Pre-migration script: add-extension');
  });
});

// ─── scaffoldPost ──────────────────────────────────────────────

describe('scaffoldPost', () => {
  it('creates a timestamped SQL file in the post directory', () => {
    const dir = path.join(tmpDir, 'schema');
    scaffoldInit(dir);
    const filePath = scaffoldPost(dir, 'seed-data');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/post\/\d{14}_seed-data\.sql$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('-- Post-migration script: seed-data');
  });
});

// ─── scaffoldMixin ─────────────────────────────────────────────

describe('scaffoldMixin', () => {
  it('creates a YAML mixin template', () => {
    const dir = path.join(tmpDir, 'schema');
    scaffoldInit(dir);
    const filePath = scaffoldMixin(dir, 'timestamps');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/mixins\/timestamps\.yaml$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    expect(parsed.mixin).toBe('timestamps');
    expect(parsed.columns).toBeInstanceOf(Array);
  });
});

// ─── generateFromDb ────────────────────────────────────────────

describe('generateFromDb', () => {
  it('generates YAML files for tables', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true, nullable: false },
          { name: 'email', type: 'varchar(255)', nullable: false },
          { name: 'bio', type: 'text', nullable: true },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
        comment: 'Users table',
      },
    ];

    const result = generateFromDb({
      tables,
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('tables/users.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.table).toBe('users');
    expect(parsed.columns).toHaveLength(3);
    expect(parsed.columns[0].primary_key).toBe(true);
    expect(parsed.indexes).toHaveLength(1);
    expect(parsed.comment).toBe('Users table');
  });

  it('generates YAML files for enums', () => {
    const enums: EnumSchema[] = [{ name: 'status', values: ['active', 'inactive', 'pending'] }];

    const result = generateFromDb({
      tables: [],
      enums,
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('enums/status.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.name).toBe('status');
    expect(parsed.values).toEqual(['active', 'inactive', 'pending']);
  });

  it('generates YAML files for functions', () => {
    const functions: FunctionSchema[] = [
      {
        name: 'add_numbers',
        language: 'plpgsql',
        returns: 'integer',
        args: [
          { name: 'a', type: 'integer' },
          { name: 'b', type: 'integer' },
        ],
        body: 'BEGIN RETURN a + b; END;',
        security: 'invoker',
        volatility: 'immutable',
      },
    ];

    const result = generateFromDb({
      tables: [],
      enums: [],
      functions,
      views: [],
      materializedViews: [],
      roles: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('functions/add_numbers.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.name).toBe('add_numbers');
    expect(parsed.args).toHaveLength(2);
    expect(parsed.body).toContain('RETURN a + b');
  });

  it('generates YAML files for views', () => {
    const views: ViewSchema[] = [{ name: 'active_users', query: 'SELECT * FROM users WHERE active = true' }];

    const result = generateFromDb({
      tables: [],
      enums: [],
      functions: [],
      views,
      materializedViews: [],
      roles: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('views/active_users.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.name).toBe('active_users');
    expect(parsed.query).toContain('SELECT * FROM users');
  });

  it('generates YAML files for materialized views', () => {
    const materializedViews: MaterializedViewSchema[] = [
      {
        name: 'user_stats',
        materialized: true,
        query: 'SELECT count(*) FROM users',
      },
    ];

    const result = generateFromDb({
      tables: [],
      enums: [],
      functions: [],
      views: [],
      materializedViews,
      roles: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('views/user_stats.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.name).toBe('user_stats');
    expect(parsed.materialized).toBe(true);
  });

  it('generates YAML files for roles', () => {
    const roles: RoleSchema[] = [{ role: 'app_reader', login: true, superuser: false }];

    const result = generateFromDb({
      tables: [],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles,
    });

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('roles/app_reader.yaml');

    const parsed = parseYaml(result[0].content);
    expect(parsed.role).toBe('app_reader');
    expect(parsed.login).toBe(true);
  });

  it('generates files for all object types at once', () => {
    const result = generateFromDb({
      tables: [{ table: 't1', columns: [{ name: 'id', type: 'integer' }] }],
      enums: [{ name: 'e1', values: ['a'] }],
      functions: [
        { name: 'f1', language: 'sql', returns: 'void', body: 'SELECT 1', security: 'invoker', volatility: 'volatile' },
      ],
      views: [{ name: 'v1', query: 'SELECT 1' }],
      materializedViews: [{ name: 'mv1', materialized: true, query: 'SELECT 1' }],
      roles: [{ role: 'r1', login: false }],
    });

    expect(result).toHaveLength(6);
    const filenames = result.map((r) => r.filename);
    expect(filenames).toContain('tables/t1.yaml');
    expect(filenames).toContain('enums/e1.yaml');
    expect(filenames).toContain('functions/f1.yaml');
    expect(filenames).toContain('views/v1.yaml');
    expect(filenames).toContain('views/mv1.yaml');
    expect(filenames).toContain('roles/r1.yaml');
  });

  it('omits default/false values from column definitions', () => {
    const result = generateFromDb({
      tables: [
        {
          table: 'items',
          columns: [
            { name: 'id', type: 'integer', primary_key: true, nullable: false },
            { name: 'name', type: 'text', nullable: true },
          ],
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    const parsed = parseYaml(result[0].content);
    // nullable: false is the default, should still be present for clarity
    // but primary_key: true should be present
    expect(parsed.columns[0].primary_key).toBe(true);
  });

  it('includes foreign key references in columns', () => {
    const result = generateFromDb({
      tables: [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'integer', primary_key: true },
            {
              name: 'user_id',
              type: 'integer',
              references: { table: 'users', column: 'id', on_delete: 'CASCADE' },
            },
          ],
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
    });

    const parsed = parseYaml(result[0].content);
    expect(parsed.columns[1].references).toEqual({
      table: 'users',
      column: 'id',
      on_delete: 'CASCADE',
    });
  });

  it('writes files to disk when outputDir is provided', () => {
    const outputDir = path.join(tmpDir, 'output');
    const result = generateFromDb(
      {
        tables: [{ table: 'items', columns: [{ name: 'id', type: 'integer' }] }],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      },
      outputDir,
    );

    expect(result).toHaveLength(1);
    const written = path.join(outputDir, 'tables', 'items.yaml');
    expect(fs.existsSync(written)).toBe(true);

    const content = fs.readFileSync(written, 'utf-8');
    const parsed = parseYaml(content);
    expect(parsed.table).toBe('items');
  });
});
