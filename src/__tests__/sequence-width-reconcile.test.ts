import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { useTestProject, writeSchema } from '../testing/index.js';
import { buildPlan } from '../planner/index.js';
import { buildDesiredAndActual } from '../cli/pipeline.js';
import { execute } from '../executor/index.js';
import { createLogger } from '../core/logger.js';
import { closePool } from '../core/db.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });
const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

// Reproduces the productionnow-staging bug: a `bigserial` PK widened in place via
// `ALTER COLUMN ... TYPE bigint` leaves the owned sequence at `integer`, which
// overflows at 2.1B. The column type reads as bigint (== bigserial normalized),
// so neither plan nor drift looked at the sequence. Now they do. (issue #66)
describe('serial sequence-width reconciliation (#66 follow-up)', () => {
  async function withClient<T>(connStr: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const pool = new pg.Pool({ connectionString: connStr });
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
      await pool.end();
    }
  }

  it('emits ALTER SEQUENCE for a bigserial column backed by an integer sequence', async () => {
    const project = await useTestProject(DATABASE_URL);
    const s = project.config.pgSchema;
    try {
      // Build the exact drift state by hand: a bigint column whose owned
      // sequence is still integer (what the in-place widening produces).
      await withClient(project.config.connectionString, async (c) => {
        await c.query(`CREATE TABLE "${s}"."thing" ("id" bigint PRIMARY KEY)`);
        await c.query(`CREATE SEQUENCE "${s}"."thing_id_seq" AS integer OWNED BY "${s}"."thing"."id"`);
        await c.query(`ALTER TABLE "${s}"."thing" ALTER COLUMN "id" SET DEFAULT nextval('"${s}"."thing_id_seq"')`);
      });

      // YAML declares it as bigserial (the source of truth).
      writeSchema(project.dir, {
        'tables/thing.yaml': `
table: thing
columns:
  - name: id
    type: bigserial
    primary_key: true
`,
      });

      // drift sees the sequence-width divergence...
      const before = await project.drift();
      expect(before.items.some((i) => i.object === 'thing.id' && i.detail?.includes('sequence type'))).toBe(true);

      // ...and plan emits exactly an alter_sequence (and NOT an alter_column,
      // since bigint ≡ bigserial for the column type).
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, { allowDestructive: false, pgSchema: s });
      expect(plan.operations.some((o) => o.type === 'alter_sequence')).toBe(true);
      expect(plan.operations.some((o) => o.type === 'alter_column')).toBe(false);

      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: s,
        logger,
      });

      // The sequence is now bigint.
      const seqType = await withClient(project.config.connectionString, async (c) => {
        const r = await c.query(
          `SELECT seq.seqtypid::regtype::text AS t
           FROM pg_sequence seq JOIN pg_class cl ON cl.oid = seq.seqrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE cl.relname = 'thing_id_seq' AND n.nspname = $1`,
          [s],
        );
        return r.rows[0].t as string;
      });
      expect(seqType).toBe('bigint');

      // Converged + idempotent: re-plan has no sequence op, and drift is clean.
      const re = await buildDesiredAndActual(project.config, logger);
      const replan = buildPlan(re.desired, re.actual, { allowDestructive: false, pgSchema: s });
      expect(replan.operations.some((o) => o.type === 'alter_sequence')).toBe(false);

      const after = await project.drift();
      expect(after.items.some((i) => i.detail?.includes('sequence type'))).toBe(false);
    } finally {
      await project.cleanup();
    }
  });
});
