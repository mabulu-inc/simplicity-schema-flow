import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

async function query<T = Record<string, unknown>>(connStr: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: connStr });
  try {
    return (await pool.query(sql, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

/** Every index on the table except the primary key: name, definition, validity. */
async function indexes(connStr: string, schema: string, table: string) {
  return query<{ name: string; def: string; valid: boolean }>(
    connStr,
    `SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def, ix.indisvalid AS valid
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
     ORDER BY 1`,
    [schema, table],
  );
}

const TABLE = (key: string, extra = '') => `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - { name: code, type: text }
indexes:
  - { name: t_code_key, columns: [${key}], unique: true${extra} }
`;

async function planFor(project: Awaited<ReturnType<typeof useTestProject>>) {
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive: false, pgSchema: project.config.pgSchema });
}

// Redefining an index used to drop the old one, then build the new one
// concurrently. A failed build left no valid index under the name, and the
// invalid leftover was later counted as the declared index (issue #81).
describe('index redefinition builds before it drops (#81)', () => {
  it('keeps the old index when the new definition cannot be built, then converges', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    const conn = project.config.connectionString;
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE('code') });
      await project.migrate();
      await query(conn, `INSERT INTO "${s}".t (code) VALUES ('a@x.com'), ('A@x.com')`);

      writeSchema(project.dir, { 'tables/t.yaml': TABLE('{ expression: lower(code) }') });

      // A same-name redefinition of a plain index is not destructive.
      const plan = await planFor(project);
      expect(plan.blocked).toEqual([]);
      expect(plan.operations.map((o) => o.type)).toEqual(['replace_index']);

      // The duplicate makes the build fail; Postgres's DETAIL names the key.
      await expect(project.migrate()).rejects.toThrow(/DETAIL: Key \(lower\(code\)\)=\(a@x\.com\) is duplicated/);

      // Old definition still in place and valid; no half-built side index.
      const after = await indexes(conn, s, 't');
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ name: 't_code_key', valid: true });
      expect(after[0].def).toContain('(code)');
      expect(after[0].def).not.toContain('lower');

      // Remove the duplicate: the next run builds the new definition.
      await query(conn, `DELETE FROM "${s}".t WHERE code = 'A@x.com'`);
      await project.migrate();
      const fixed = await indexes(conn, s, 't');
      expect(fixed).toHaveLength(1);
      expect(fixed[0]).toMatchObject({ name: 't_code_key', valid: true });
      expect(fixed[0].def).toContain('lower(code)');

      // The name now enforces the new rule, and the plan has converged.
      await expect(query(conn, `INSERT INTO "${s}".t (code) VALUES ('A@X.COM')`)).rejects.toThrow(/"t_code_key"/);
      expect((await planFor(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('rebuilds an invalid index under a declared name instead of counting it as present', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    const conn = project.config.connectionString;
    try {
      // The state older versions left behind: a failed concurrent build.
      writeSchema(project.dir, { 'tables/t.yaml': TABLE('code') });
      await project.migrate();
      await query(conn, `DROP INDEX "${s}".t_code_key`);
      await query(conn, `INSERT INTO "${s}".t (code) VALUES ('a'), ('a')`);
      await expect(query(conn, `CREATE UNIQUE INDEX CONCURRENTLY t_code_key ON "${s}".t (code)`)).rejects.toThrow();
      expect(await indexes(conn, s, 't')).toMatchObject([{ name: 't_code_key', valid: false }]);

      const report = await project.drift();
      expect(report.items.some((i) => i.object === 't_code_key' && i.detail?.includes('invalid'))).toBe(true);

      await query(conn, `DELETE FROM "${s}".t WHERE id = (SELECT max(id) FROM "${s}".t)`);
      const plan = await planFor(project);
      expect(plan.operations.map((o) => o.type)).toEqual(['replace_index']);
      await project.migrate();

      expect(await indexes(conn, s, 't')).toMatchObject([{ name: 't_code_key', valid: true }]);
      expect((await planFor(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('keeps the index comment across the swap', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    const conn = project.config.connectionString;
    try {
      writeSchema(project.dir, { 'tables/t.yaml': TABLE('code', ', comment: one per code') });
      await project.migrate();
      writeSchema(project.dir, { 'tables/t.yaml': TABLE('{ expression: lower(code) }', ', comment: one per code') });
      await project.migrate();

      const [row] = await query<{ comment: string }>(
        conn,
        `SELECT obj_description(to_regclass($1), 'pg_class') AS comment`,
        [`"${s}".t_code_key`],
      );
      expect(row.comment).toBe('one per code');
      expect((await planFor(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });

  it('swaps in one transaction on a partitioned parent', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    const conn = project.config.connectionString;
    const parent = (key: string) => `
table: events
partition_by:
  strategy: list
  key: [kind]
columns:
  - { name: kind, type: text, nullable: false }
  - { name: code, type: text }
indexes:
  - { name: events_code_idx, columns: [${key}] }
`;
    try {
      writeSchema(project.dir, { 'tables/events.yaml': parent('code') });
      await project.migrate();
      writeSchema(project.dir, { 'tables/events.yaml': parent('{ expression: lower(code) }') });

      const plan = await planFor(project);
      expect(plan.operations.map((o) => o.type)).toEqual(['replace_index']);
      expect(plan.operations[0].concurrent).toBeFalsy();
      await project.migrate();

      const after = await indexes(conn, s, 'events');
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ name: 'events_code_idx', valid: true });
      expect(after[0].def).toContain('lower(code)');
      expect((await planFor(project)).operations).toEqual([]);
    } finally {
      await project.cleanup();
    }
  });
});
