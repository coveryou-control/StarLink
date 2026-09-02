import { defineConfig } from 'vitest/config';

/**
 * Package-local test config. See the note in the packages' equivalents: the root
 * config's globs are repo-root-relative and match nothing from inside an app.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});