import { defineConfig } from 'vitest/config';

/** Integration tests against a shared database — see infrastructure/database's note. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    passWithNoTests: true,
    fileParallelism: false,
  },
});
