import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import pg from 'pg';
import { closePool } from './src/core/db.js';

/**
 * Per-test-file setup. Runs (and is awaited) before the test file is imported,
 * so the `const DATABASE_URL = process.env.DATABASE_URL!` reads at module top
 * level see this file's database.
 *
 * Each test file gets its own throwaway database carved from the shared
 * Testcontainers instance (admin URI provided by globalSetup). This isolates
 * the internal `_smplcty_schema_flow` schema — which is a singleton per
 * database and is dropped/recreated by the bootstrap tests — so files run
 * safely in parallel.
 */
const adminUrl = inject('adminUrl');
const dbName = `sf_test_${randomBytes(6).toString('hex')}`;

function urlWithDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const create = new pg.Pool({ connectionString: adminUrl, max: 1 });
try {
  await create.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await create.end();
}

process.env.DATABASE_URL = urlWithDatabase(adminUrl, dbName);

afterAll(async () => {
  // Close this file's cached pools, evict any straggler connections, then drop.
  await closePool();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
});
