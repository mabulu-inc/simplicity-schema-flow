import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
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
 * Built from `test/pg/Dockerfile` (postgres:16 + pg_partman + pg_cron) so the
 * partitioned-table maintenance path is exercised against the real extensions,
 * not mocked. The build is cached after the first run. `pg_cron` is loaded via
 * `shared_preload_libraries` and runs its jobs against the default `postgres`
 * database (`cron.database_name`'s default). A generous `max_connections`
 * covers the pools that parallel test files open at once.
 *
 * Requires a reachable Docker daemon (local Docker Desktop / colima; GitHub
 * `ubuntu-latest` and AWS CodeBuild/EC2 all provide one).
 */
let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  // Build (or reuse cached) the extension-bearing image, then run it through
  // PostgreSqlContainer for its readiness wait + connection-URI helpers.
  await GenericContainer.fromDockerfile('test/pg').build('schema-flow-pg:test', { deleteOnExit: false });

  container = await new PostgreSqlContainer('schema-flow-pg:test')
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'shared_preload_libraries=pg_cron'])
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
