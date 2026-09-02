import { defineConfig } from 'vitest/config';

/**
 * Package-local test config.
 *
 * Required because the root config's include globs are repo-root-relative: without
 * this, `pnpm --filter <pkg> test` resolves the root config, matches nothing, and
 * exits 1. The root config remains authoritative for whole-repo runs.
 *
 * `passWithNoTests` keeps a package that has not yet grown tests from failing the
 * build; the root run is what guarantees the suite is actually executed.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});