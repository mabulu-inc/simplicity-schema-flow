import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * Vitest globalSetup — runs once per test run.
 *
 * Provisions PostgreSQL with **Testcontainers**: an ephemeral container that
 * Ryuk (testcontainers' reaper) tears down even on a hard crash, so there's no
 * shared instance to leak between runs and no `.env`/fixed port to collide
 * across projects. The admin connection URI (the default `postgres` database)
 * is handed to each test file via Vitest's `provide`/`inject` channel; the
 * per-file setup (`vitest.setup.ts`) then carves out a throwaway database from
 * it so files are fully isolated under parallelism.
 *
 * Per-file *database* isolation — not just per-schema — is required because a
 * handful of tests bootstrap or drop the internal `_smplcty_schema_flow`
 * schema, which lives once per database. Giving every file its own database
 * keeps those drops from racing the rest of the suite.
 *
 * Pinned to postgres:17. A generous `max_connections` covers the pools that
 * parallel test files open at once.
 *
 * Requires a reachable Docker daemon (local Docker Desktop / colima; GitHub
 * `ubuntu-latest` and AWS CodeBuild/EC2 all provide one).
 */
let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:17')
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();

  provide('adminUrl', container.getConnectionUri());

  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    adminUrl: string;
  }
}
