import { defineConfig } from 'vitest/config';

/**
 * Integration tests against a SHARED database, so files run one at a time.
 *
 * Vitest runs test files in parallel workers by default, and each of these files opens
 * its own connection pool. Against a managed Postgres that adds up fast: the suite
 * started exhausting connections, and the symptom was not an error but a LIE — one
 * file's connection probe failed, its `beforeAll` set `available = false`, and eleven
 * tests reported as "skipped" inside an otherwise green run. A gate that did not run
 * must never report green (TEST_STRATEGY), so the fix is to stop competing for
 * connections rather than to widen the pool.
 *
 * These suites are I/O-bound on a remote database; serialising them costs little.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    passWithNoTests: true,
    fileParallelism: false,
  },
});
