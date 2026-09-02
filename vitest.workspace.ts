/**
 * One workspace so the root run and the per-package runs are the SAME run.
 *
 * They were not. The root config listed globs and applied its own settings, which meant
 * a package's `setupFiles` never loaded — `apps/employee-web` needs `fake-indexeddb`,
 * and without it eleven draft tests failed at the root while passing under
 * `pnpm --filter @starlink/employee-web test`. A root suite that disagrees with the
 * package suites is worse than no root suite: it teaches people to trust whichever one
 * is currently green.
 *
 * Each entry resolves that package's own `vitest.config.ts`, so there is exactly one
 * description of how a package's tests run. The workspace-hygiene guard
 * (`infrastructure/guards`) already fails the build if a package with a `test` script
 * has no config, so these globs cannot silently cover nothing.
 */
export default ['packages/*', 'adapters/*', 'infrastructure/*', 'apps/*'];
