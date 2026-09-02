import { defineConfig } from 'vitest/config';

/**
 * Integration tests against a SHARED database.
 *
 * Vitest runs test files in parallel workers by default, and each of these files opens
 * its own connection pool. Against a managed Postgres that adds up fast: the suite
 * started exhausting connections, and the symptom was not an error but a LIE — one
 * file's connection probe failed, its `beforeAll` set `available = false`, and eleven
 * tests reported as "skipped" inside an otherwise green run. A gate that did not run
 * must never report green (TEST_STRATEGY), so the fix is to stop competing for
 * connections rather than to widen the pool.
 *
 * ## `fileParallelism` here only covers HALF the runs — see the root config
 *
 * This setting is honoured when this file is the ROOT config, which is what
 * `pnpm --filter @starlink/database test` does. When the same file is loaded as a
 * workspace project it is **silently ignored**: Vitest resolves `fileParallelism` once
 * per run, not per project.
 *
 * For a long time that left root runs unprotected, and the comment that used to sit here
 * claimed otherwise. `test:verify` happened to pass `--no-file-parallelism` on the
 * command line, so the gate stayed honest and nobody noticed — until two DB files
 * overlapped and `admin-roles` failed on a page of a hundred principals that
 * `claim-race` was holding open. Verified since, both ways: with the root config the two
 * files run strictly in sequence; without it they enter `beforeAll` in the same
 * millisecond.
 *
 * The workspace-wide guarantee now lives in `/vitest.config.ts`, and
 * `infrastructure/guards` fails the build if it is removed. This line stays because it
 * is the one that covers `--filter` runs.
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
