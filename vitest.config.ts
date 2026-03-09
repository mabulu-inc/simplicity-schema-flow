import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config();

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
