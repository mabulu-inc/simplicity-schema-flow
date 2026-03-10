/**
 * Shared E2E test setup and teardown.
 *
 * Provides the DATABASE_URL and pool cleanup for all E2E tests.
 */

import { afterAll } from 'vitest';
import { closePool } from '../../src/core/db.js';

export const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});
