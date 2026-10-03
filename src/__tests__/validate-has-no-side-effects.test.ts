/**
 * `validate` executes the plan in a rolled-back transaction — it must leave the
 * database exactly as it found it. Pre-scripts commit in their own transaction,
 * so validate skips them (as it skips post-scripts): a pending pre-script must
 * neither change the schema nor be recorded as applied.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../executor/index.js';
import type { SchemaFile } from '../core/files.js';
import { hashFile } from '../core/files.js';
import { createLogger } from '../core/logger.js';
import { closePool, getPool } from '../core/db.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

let n = 0;
const uniqueSchema = () => `validate_no_side_effects_${Date.now()}_${n++}`;

describe('validate has no side effects', () => {
  let testSchema: string;

  beforeEach(async () => {
    testSchema = uniqueSchema();
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`CREATE SCHEMA "${testSchema}"`);
    } finally {
      client.release();
    }
  });
  afterEach(async () => {
    const client = await getPool(DATABASE_URL).connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await closePool();
  });

  it('does not run or record a pending pre-script', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'validate-pre-'));
    const prePath = join(tmpDir, 'make.sql');
    await writeFile(prePath, `CREATE TABLE "${testSchema}"."from_pre" (id integer);`);
    const preRel = `pre/${testSchema}_make.sql`;
    const preScripts: SchemaFile[] = [
      { relativePath: preRel, absolutePath: prePath, phase: 'pre', hash: await hashFile(prePath) },
    ];

    const result = await execute({
      connectionString: DATABASE_URL,
      operations: [],
      preScripts,
      pgSchema: testSchema,
      validateOnly: true,
      logger,
    });
    expect(result.preScriptsRun).toBe(0);

    const c = await getPool(DATABASE_URL).connect();
    try {
      const exists = await c.query(`SELECT to_regclass($1) AS reg`, [`"${testSchema}"."from_pre"`]);
      expect(exists.rows[0].reg).toBeNull();
      const hist = await c.query(`SELECT count(*)::int AS cnt FROM _smplcty_schema_flow.history WHERE file_path = $1`, [
        preRel,
      ]);
      expect(hist.rows[0].cnt).toBe(0);
    } finally {
      c.release();
    }
    await rm(tmpDir, { recursive: true });
  });
});
