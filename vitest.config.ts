import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './vitest.global-setup.ts',
    setupFiles: './vitest.setup.ts',
    globals: true,
    // Test files isolate via their own managed schema, and the internal
    // history table is keyed per schema, so a single shared container is safe
    // to hit from parallel files.
    fileParallelism: true,
    testTimeout: 30_000,
    // The container start + first image pull happens inside globalSetup, but
    // give hooks room too since per-file schema setup talks to a cold pool.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
