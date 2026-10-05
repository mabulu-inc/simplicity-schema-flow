import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTestProject, writeSchema, type TestProject } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

function table(type: string, using?: string): string {
  return `
table: t
columns:
  - { name: id, type: bigserial, primary_key: true }
  - name: c
    type: ${type}${using ? `\n    using: "${using}"` : ''}
`;
}

async function planTypeChange(project: TestProject, to: string, using?: string) {
  writeSchema(project.dir, { 'tables/t.yaml': table(to, using) });
  const { desired, actual } = await buildDesiredAndActual(project.config, logger);
  return buildPlan(desired, actual, { allowDestructive: false, pgSchema: project.schema });
}

// A bare type change used to be non-destructive whatever the cast did, so a
// cast that silently changes data — resolved against the session TimeZone,
// rounded, or truncated — ran without a prompt (issue #74). Without `using:`
// such a change is now destructive; a `using:` states the conversion and
// lifts the block.
describe('type changes that can silently change data (#74)', () => {
  const cases: { from: string; to: string; lossy: boolean }[] = [
    // Depends on the session TimeZone.
    { from: 'timestamptz', to: 'date', lossy: true },
    { from: 'timestamptz', to: 'timestamp', lossy: true },
    { from: 'timestamp', to: 'timestamptz', lossy: true },
    { from: 'date', to: 'timestamptz', lossy: true },
    { from: 'timestamptz', to: 'time', lossy: true },
    // Drops the time of day, or the date.
    { from: 'timestamp', to: 'date', lossy: true },
    { from: 'timestamp', to: 'time', lossy: true },
    // Rounds.
    { from: 'numeric(10,2)', to: 'integer', lossy: true },
    { from: 'double precision', to: 'bigint', lossy: true },
    { from: 'double precision', to: 'real', lossy: true },
    { from: 'numeric(10,4)', to: 'numeric(10,2)', lossy: true },
    { from: 'numeric', to: 'numeric(12,2)', lossy: true },
    { from: 'double precision', to: 'numeric(12,2)', lossy: true },
    // Truncates: an explicit cast to varchar(n) cuts the value instead of failing.
    { from: 'text', to: 'varchar(5)', lossy: true },
    { from: 'varchar(20)', to: 'varchar(5)', lossy: true },
    { from: 'integer', to: 'varchar(3)', lossy: true },
    { from: 'varchar(5)', to: 'char', lossy: true },
    // Widening or exact — never blocked.
    { from: 'integer', to: 'bigint', lossy: false },
    { from: 'varchar(5)', to: 'varchar(20)', lossy: false },
    { from: 'varchar(5)', to: 'text', lossy: false },
    { from: 'numeric(10,2)', to: 'numeric(12,2)', lossy: false },
    { from: 'integer', to: 'numeric(12,2)', lossy: false },
    { from: 'date', to: 'timestamp', lossy: false },
    { from: 'real', to: 'double precision', lossy: false },
    { from: 'text', to: 'jsonb', lossy: false },
  ];

  it.each(cases)('$from → $to is destructive: $lossy', async ({ from, to, lossy }) => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table(from) });
      await project.migrate();

      const plan = await planTypeChange(project, to);
      const target = lossy ? plan.blocked : plan.operations;
      expect(target.map((o) => o.type)).toEqual(['alter_column']);

      // A declared `using:` is the operator saying how; never blocked.
      const withUsing = await planTypeChange(project, to, `c::${to}`);
      expect(withUsing.blocked).toEqual([]);
      expect(withUsing.operations.map((o) => o.type)).toEqual(['alter_column']);
    } finally {
      await project.cleanup();
    }
  });

  it('timestamptz → date with using: gives the same day whatever the session TimeZone', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, { 'tables/t.yaml': table('timestamptz') });
      await project.migrate();
      const pool = new pg.Pool({ connectionString: project.config.connectionString });
      try {
        await pool.query(`INSERT INTO "${project.schema}".t (c) VALUES ('2026-07-31T00:00:00Z')`);

        // Apply from a session whose TimeZone puts that instant on July 30.
        const perTx = join(project.dir, 'per-tx.sql');
        writeFileSync(perTx, "SET LOCAL TimeZone = 'America/New_York';");
        project.config.perTxSqlPath = perTx;

        writeSchema(project.dir, { 'tables/t.yaml': table('date', "(c AT TIME ZONE 'UTC')::date") });
        await project.migrate();

        const r = await pool.query(`SELECT c::text AS c FROM "${project.schema}".t`);
        expect(r.rows[0].c).toBe('2026-07-31');
      } finally {
        await pool.end();
      }
    } finally {
      await project.cleanup();
    }
  });
});
