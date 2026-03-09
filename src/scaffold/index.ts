/**
 * Scaffold / generate — DB-to-YAML generation, project init, and template creation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type {
  TableSchema,
  EnumSchema,
  FunctionSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ColumnDef,
} from '../schema/types.js';

// ─── Types ─────────────────────────────────────────────────────

export interface GenerateInput {
  tables: TableSchema[];
  enums: EnumSchema[];
  functions: FunctionSchema[];
  views: ViewSchema[];
  materializedViews: MaterializedViewSchema[];
  roles: RoleSchema[];
}

export interface GeneratedFile {
  filename: string;
  content: string;
}

// ─── generateFromDb ────────────────────────────────────────────

/**
 * Convert introspected DB objects into YAML file representations.
 * If outputDir is provided, files are also written to disk.
 */
export function generateFromDb(input: GenerateInput, outputDir?: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const table of input.tables) {
    files.push({
      filename: `tables/${table.table}.yaml`,
      content: yamlStringify(buildTableYaml(table)),
    });
  }

  for (const e of input.enums) {
    files.push({
      filename: `enums/${e.name}.yaml`,
      content: yamlStringify(buildEnumYaml(e)),
    });
  }

  for (const fn of input.functions) {
    files.push({
      filename: `functions/${fn.name}.yaml`,
      content: yamlStringify(buildFunctionYaml(fn)),
    });
  }

  for (const view of input.views) {
    files.push({
      filename: `views/${view.name}.yaml`,
      content: yamlStringify(buildViewYaml(view)),
    });
  }

  for (const mv of input.materializedViews) {
    files.push({
      filename: `views/${mv.name}.yaml`,
      content: yamlStringify(buildMaterializedViewYaml(mv)),
    });
  }

  for (const role of input.roles) {
    files.push({
      filename: `roles/${role.role}.yaml`,
      content: yamlStringify(buildRoleYaml(role)),
    });
  }

  if (outputDir) {
    for (const file of files) {
      const fullPath = path.join(outputDir, file.filename);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf-8');
    }
  }

  return files;
}

// ─── YAML builders ─────────────────────────────────────────────

function buildTableYaml(table: TableSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { table: table.table };

  result.columns = table.columns.map((col) => {
    const c: Record<string, unknown> = { name: col.name, type: col.type };
    if (col.primary_key) c.primary_key = true;
    if (col.nullable !== undefined) c.nullable = col.nullable;
    if (col.default !== undefined) c.default = col.default;
    if (col.unique) c.unique = true;
    if (col.comment) c.comment = col.comment;
    if (col.references) {
      const ref: Record<string, unknown> = {
        table: col.references.table,
        column: col.references.column,
      };
      if (col.references.on_delete && col.references.on_delete !== 'NO ACTION') {
        ref.on_delete = col.references.on_delete;
      }
      if (col.references.on_update && col.references.on_update !== 'NO ACTION') {
        ref.on_update = col.references.on_update;
      }
      c.references = ref;
    }
    if (col.generated) c.generated = col.generated;
    return c;
  });

  if (table.primary_key) result.primary_key = table.primary_key;
  if (table.indexes && table.indexes.length > 0) result.indexes = table.indexes;
  if (table.checks && table.checks.length > 0) result.checks = table.checks;
  if (table.unique_constraints && table.unique_constraints.length > 0) {
    result.unique_constraints = table.unique_constraints;
  }
  if (table.triggers && table.triggers.length > 0) result.triggers = table.triggers;
  if (table.policies && table.policies.length > 0) result.policies = table.policies;
  if (table.grants && table.grants.length > 0) result.grants = table.grants;
  if (table.seeds && table.seeds.length > 0) result.seeds = table.seeds;
  if (table.comment) result.comment = table.comment;

  return result;
}

function buildEnumYaml(e: EnumSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { name: e.name, values: e.values };
  if (e.comment) result.comment = e.comment;
  return result;
}

function buildFunctionYaml(fn: FunctionSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: fn.name,
    language: fn.language,
    returns: fn.returns,
  };

  if (fn.args && fn.args.length > 0) {
    result.args = fn.args.map((a) => {
      const arg: Record<string, unknown> = { name: a.name, type: a.type };
      if (a.mode && a.mode !== 'IN') arg.mode = a.mode;
      if (a.default) arg.default = a.default;
      return arg;
    });
  }

  result.body = fn.body;

  if (fn.security && fn.security !== 'invoker') result.security = fn.security;
  if (fn.volatility && fn.volatility !== 'volatile') result.volatility = fn.volatility;
  if (fn.parallel && fn.parallel !== 'unsafe') result.parallel = fn.parallel;
  if (fn.strict) result.strict = true;
  if (fn.leakproof) result.leakproof = true;
  if (fn.comment) result.comment = fn.comment;

  return result;
}

function buildViewYaml(view: ViewSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { name: view.name, query: view.query };
  if (view.grants && view.grants.length > 0) result.grants = view.grants;
  if (view.comment) result.comment = view.comment;
  return result;
}

function buildMaterializedViewYaml(mv: MaterializedViewSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: mv.name,
    materialized: true,
    query: mv.query,
  };
  if (mv.indexes && mv.indexes.length > 0) result.indexes = mv.indexes;
  if (mv.grants && mv.grants.length > 0) result.grants = mv.grants;
  if (mv.comment) result.comment = mv.comment;
  return result;
}

function buildRoleYaml(role: RoleSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { role: role.role };
  if (role.login !== undefined) result.login = role.login;
  if (role.superuser !== undefined) result.superuser = role.superuser;
  if (role.createdb !== undefined) result.createdb = role.createdb;
  if (role.createrole !== undefined) result.createrole = role.createrole;
  if (role.inherit !== undefined) result.inherit = role.inherit;
  if (role.bypassrls !== undefined) result.bypassrls = role.bypassrls;
  if (role.replication !== undefined) result.replication = role.replication;
  if (role.connection_limit !== undefined && role.connection_limit !== -1) {
    result.connection_limit = role.connection_limit;
  }
  if (role.in && role.in.length > 0) result.in = role.in;
  if (role.comment) result.comment = role.comment;
  return result;
}

// ─── scaffoldInit ──────────────────────────────────────────────

/**
 * Create standard project directory structure.
 */
export function scaffoldInit(baseDir: string): void {
  const dirs = ['tables', 'enums', 'functions', 'views', 'roles', 'mixins', 'pre', 'post'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
  }
}

// ─── scaffoldPre / scaffoldPost ────────────────────────────────

function timestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, '').slice(0, 14);
}

/**
 * Create a timestamped pre-migration SQL template.
 */
export function scaffoldPre(baseDir: string, name: string): string {
  const filename = `${timestamp()}_${name}.sql`;
  const filePath = path.join(baseDir, 'pre', filename);
  const content = `-- Pre-migration script: ${name}\n-- This script runs BEFORE schema migrations.\n\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Create a timestamped post-migration SQL template.
 */
export function scaffoldPost(baseDir: string, name: string): string {
  const filename = `${timestamp()}_${name}.sql`;
  const filePath = path.join(baseDir, 'post', filename);
  const content = `-- Post-migration script: ${name}\n-- This script runs AFTER schema migrations.\n\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ─── scaffoldMixin ─────────────────────────────────────────────

/**
 * Create a mixin YAML template.
 */
export function scaffoldMixin(baseDir: string, name: string): string {
  const filePath = path.join(baseDir, 'mixins', `${name}.yaml`);
  const template = {
    mixin: name,
    columns: [
      { name: 'example_column', type: 'text', nullable: true },
    ],
  };
  fs.writeFileSync(filePath, yamlStringify(template), 'utf-8');
  return filePath;
}
