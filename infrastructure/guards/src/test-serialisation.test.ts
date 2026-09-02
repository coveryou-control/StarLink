/**
 * The DB suites must not run in parallel — enforced, not merely intended.
 *
 * Eight of the twelve workspace projects open a PostgreSQL pool against one shared
 * managed database. When their files run concurrently they exhaust its connections, and
 * the symptom is not an error: a file's connection probe fails, its `beforeAll` sets
 * `available = false`, and its tests report as *skipped* inside a green run. That is the
 * failure `pnpm test:verify` and the no-skips gate exist to catch, and it has happened.
 *
 * The setting that prevents it is `fileParallelism: false`, and it has one property that
 * makes it easy to get wrong: **Vitest resolves it once for the whole run, not per
 * project.** Setting it inside a package's config protects
 * `pnpm --filter <pkg> test` and does nothing at all for a root run. That is exactly the
 * state this repository was in — the package config said one thing, the comment above it
 * promised another, and only `test:verify`'s command-line flag was holding the line.
 *
 * So this guard checks the two places the guarantee actually comes from. It is a static
 * check of configuration rather than an observation of behaviour, which is a real
 * limitation — but the behaviour was verified by hand when the root config was added
 * (with it, two DB files run in strict sequence; without it, both enter `beforeAll` in
 * the same millisecond), and what regresses in practice is the configuration, not Vitest.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './source-scan.js';

/**
 * Comments stripped before matching, because this guard was satisfied by its own prose.
 *
 * `vitest.config.ts` explains at length WHY it sets `fileParallelism: false`, and that
 * explanation contains the words `fileParallelism: false`. A bare regex over the file text
 * therefore matched the docblock, and deleting the real setting on line 41 left this suite
 * green — the guard could not detect the single removal it exists to detect.
 *
 * That is worse here than almost anywhere else in the repo. What this protects is the
 * connection-exhaustion failure that once hid eleven unrun tests inside a green run, and a
 * guard that cannot fail is exactly the same class of thing: a control that reports safety
 * it has not checked.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The setting as CODE: a property at real indentation, not a mention in a sentence. */
const SETS_SERIAL = /^\s*fileParallelism\s*:\s*false\s*,?\s*$/m;

describe('test serialisation', () => {
  it('the ROOT vitest config disables file parallelism', () => {
    /**
     * The workspace-wide guarantee. Without this file, every root run — including the
     * ad-hoc `pnpm exec vitest run <path>` a developer reaches for while debugging —
     * runs DB suites concurrently and can report skips as green.
     */
    const rootConfig = join(REPO_ROOT, 'vitest.config.ts');

    expect(
      existsSync(rootConfig),
      'vitest.config.ts is missing from the repository root. It is the only thing that ' +
        'applies fileParallelism to a workspace run — a package-level setting is ' +
        'silently ignored when the package is loaded as a project.',
    ).toBe(true);

    const source = stripComments(readFileSync(rootConfig, 'utf8'));
    expect(
      SETS_SERIAL.test(source),
      'the root vitest config no longer sets fileParallelism: false. DB suites will run ' +
        'concurrently against one shared database, and connection exhaustion surfaces as ' +
        'SKIPPED tests inside a green run rather than as an error.',
    ).toBe(true);
  });

  it('the verification gate serialises on the command line too', () => {
    /**
     * Belt and braces, and deliberately so: `test:verify` is the run that decides whether
     * the build is green. Its flag predates the root config and is what kept the gate
     * honest while the package-level setting was inert. Keeping both means neither one
     * being removed silently changes what the gate proves.
     */
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const verify = manifest.scripts?.['test:verify'] ?? '';

    expect(verify, 'the test:verify script is missing').not.toBe('');
    expect(
      verify.includes('--no-file-parallelism'),
      'test:verify no longer passes --no-file-parallelism. The root config should still ' +
        'cover it, but the gate must not depend on a second file being correct.',
    ).toBe(true);
  });

  it('a package that opens a database pool keeps its own serialisation too', () => {
    /**
     * `pnpm --filter @starlink/database test` loads that package's config AS the root
     * config, so the root file above does not apply. The package-level setting is what
     * covers that path, and it is the one people run while working on a single package.
     */
    const dbConfig = join(REPO_ROOT, 'infrastructure', 'database', 'vitest.config.ts');
    const source = stripComments(readFileSync(dbConfig, 'utf8'));

    expect(
      SETS_SERIAL.test(source),
      'infrastructure/database must keep fileParallelism: false for --filter runs, where ' +
        'its own config is the root config and the repository root config is not read.',
    ).toBe(true);
  });
});
