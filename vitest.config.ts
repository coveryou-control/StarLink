import { defineConfig } from 'vitest/config';

/**
 * Root options for the whole workspace. Projects live in `vitest.workspace.ts`.
 *
 * ## Why this file exists: `fileParallelism` is a ROOT-ONLY option
 *
 * `infrastructure/database/vitest.config.ts` has set `fileParallelism: false` since the
 * connection-exhaustion incident, with a comment explaining that DB suites must not
 * compete for connections. That setting is honoured when the package config IS the root
 * config — `pnpm --filter @starlink/database test` — and **silently ignored** when the
 * same file is loaded as a workspace project. Vitest resolves `fileParallelism` once, for
 * the run, not per project.
 *
 * So for a root run the guarantee came from one place only: `test:verify` passing
 * `--no-file-parallelism` on the command line. That kept the real gate honest and left
 * every ad-hoc `pnpm exec vitest run <path>` unprotected — which is how a test that had
 * passed for weeks failed the moment two DB files overlapped (`admin-roles` asserting its
 * fixture appeared in a page of 100, while `claim-race` held a hundred principals open).
 *
 * A guarantee that holds only when you remember a CLI flag is not a guarantee. It now
 * lives here, so the root run, the gate and an ad-hoc run behave identically — which is
 * the same principle `vitest.workspace.ts` already states about per-package runs.
 *
 * ## Why globally, and not just for the database projects
 *
 * Eight of the twelve projects open a PostgreSQL pool: `infrastructure/{database,sweeps,
 * outbox-relay,guards}`, `adapters/{iam,employee-directory,work-orchestrator}` and
 * `apps/api`. A per-project setting — even one that worked — would serialise files
 * *within* a project and leave the projects themselves running concurrently, which is the
 * larger share of the contention. Against one managed database there is no useful
 * distinction between "two files in a project" and "two projects".
 *
 * The cost is real and accepted: pure unit suites that could run in parallel do not. It
 * is also already the cost of `test:verify`, which is the run that decides whether the
 * build is green — so this makes the fast path match the honest path rather than making
 * anything slower than the number we already live with.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
