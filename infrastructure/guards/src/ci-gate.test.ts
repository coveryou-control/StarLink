/**
 * The merge gate must be the gate the repository actually built.
 *
 * ## The failure this exists to prevent recurring
 *
 * Every verification mechanism in this repository was present, correct, and *not wired to
 * CI*. `.github/workflows/ci.yml` ran `pnpm exec vitest run` — the command whose entire
 * documented weakness is that it reports "all tasks passed" over a report full of skips —
 * and beside it carried a hand-written skip detector that filtered `status === 'pending'`
 * while Vitest emits `'skipped'`. That is the *exact* bug `no-skips.mjs` opens by
 * describing as already fixed: "the gate cheerfully reported 'none skipped' over a report
 * containing eighty-six of them".
 *
 * So there were two copies of one check, the good copy was not the one guarding merges,
 * and both were green. `pnpm lint` and the Playwright journeys were not in CI at all,
 * which meant `lint-gate.test.ts` proved the lint scripts *could* fail while nothing ever
 * gave them the opportunity.
 *
 * The lesson generalises past this one file: a guard is worth what the merge gate invokes,
 * not what the repository contains. This test asserts that CI calls the real scripts, and
 * that it does not grow a second private implementation of a check that already exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './source-scan.js';

const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const scripts = manifest.scripts ?? {};

/** The `run:` lines only — a command named in a comment is not a command CI executes. */
const runLines = workflow
  .split('\n')
  .filter((line) => /^\s*(-\s*)?run:\s*\S/.test(line) || /^\s{8,}pnpm\b/.test(line))
  .join('\n');

describe('CI runs the real verification gates', () => {
  it('reads a workflow that actually defines steps', () => {
    // A guard whose file moved would otherwise pass forever over an empty string.
    expect(workflow.length).toBeGreaterThan(500);
    expect(runLines).toMatch(/pnpm/);
  });

  for (const [gate, command] of [
    ['the serialised, skip-failing test run', 'pnpm test:verify'],
    ['lint', 'pnpm lint'],
    ['typecheck', 'pnpm typecheck'],
    ['the architecture boundary law', 'pnpm boundaries'],
    ['the browser journeys', 'pnpm test:e2e:verify'],
  ] as const) {
    it(`invokes ${gate}`, () => {
      expect(
        runLines.includes(command),
        `CI no longer runs \`${command}\`. A gate the merge does not invoke is not a gate — ` +
          'it is a file that makes the repository look protected.',
      ).toBe(true);
    });
  }

  it('does not run the weaker bare vitest command as its test step', () => {
    /**
     * `pnpm exec vitest run` and `pnpm test` both exit 0 over skipped tests. Either one
     * appearing as the test step means the no-skips gate has been routed around, whatever
     * else the workflow also runs.
     */
    const weak = runLines
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(-\s*)?run:\s*(pnpm exec vitest run|pnpm test)\s*$/.test(line));

    expect(
      weak,
      'these report success over a report containing skips:\n' + weak.join('\n'),
    ).toEqual([]);
  });

  it('delegates skip detection to no-skips.mjs instead of reimplementing it', () => {
    /**
     * The removed CI step is the specimen: a second, subtly different implementation of a
     * check that already existed correctly. The status vocabulary is the part that is easy
     * to get wrong, so any workflow that starts comparing statuses by hand is the thing
     * this assertion is looking for.
     */
    expect(
      /status\s*===\s*['"](pending|skipped|todo)['"]/.test(workflow),
      'ci.yml is comparing test statuses by hand again. That is how the gate came to ' +
        'filter `pending` while Vitest emits `skipped`. Call no-skips.mjs instead.',
    ).toBe(false);
  });

  it('routes every gate CI names through a script that ends at no-skips.mjs', () => {
    // The indirection is the point: CI names a script, the script names the guard, and the
    // developer running that same script locally gets the identical verdict.
    for (const script of ['test:verify', 'test:e2e:verify']) {
      expect(scripts[script] ?? '', `package.json has no "${script}" script`).toContain(
        'no-skips.mjs',
      );
    }
  });

  /**
   * The workflow's own internal consistency.
   *
   * Not a claim that it runs on GitHub — nothing here has executed a runner, and this file
   * cannot tell you that it would. What it can tell you is the class of error that is
   * checkable from inside the repository: a step invoking a script that does not exist, a
   * tab in a YAML file, a `run:` that never got a command. Those are exactly the mistakes
   * that turn into a red first build after a merge.
   */
  describe('the workflow is internally consistent', () => {
    it('invokes only pnpm scripts that exist', () => {
      /**
       * The check with the most value: `pnpm test:verify` in CI and no `test:verify` in
       * package.json is a green local suite and a workflow that dies on its own second
       * step. `pnpm exec …` and `pnpm --filter …` are excluded — those run binaries and
       * package scripts, not root ones.
       */
      const invoked = [...workflow.matchAll(/^\s*(?:-\s*)?run:\s*pnpm\s+([a-z0-9:._-]+)/gim)]
        .map((match) => match[1] ?? '')
        .filter((name) => name !== 'exec' && name !== 'install' && !name.startsWith('--'));

      expect(invoked.length, 'no pnpm script invocations found in the workflow').toBeGreaterThan(4);

      const missing = invoked.filter((name) => scripts[name] === undefined);
      expect(
        missing,
        'CI runs these and package.json does not define them:\n' + missing.join('\n'),
      ).toEqual([]);
    });

    it('contains no tab characters', () => {
      // A tab is not valid YAML indentation, and it is invisible in most diffs.
      const lines = workflow
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.includes('\t'))
        .map(({ number }) => `line ${number}`);

      expect(lines, 'tabs are not valid YAML indentation:\n' + lines.join('\n')).toEqual([]);
    });

    it('gives every step something to do', () => {
      /**
       * A step with a `name:` and neither `run:` nor `uses:` parses as valid YAML and does
       * nothing — the quietest possible way for a gate to stop running while still
       * appearing in the build log.
       */
      const steps = workflow.split(/\n\s*- /).slice(1);
      const empty = steps
        .filter((step) => !/(^|\n)\s*(run|uses):/.test(step) && !/^\s*(run|uses):/.test(step))
        .map((step) => (step.split('\n')[0] ?? '').trim());

      expect(empty, 'these steps do nothing:\n' + empty.join('\n')).toEqual([]);
    });

    it('declares the services the gates need', () => {
      // `test:verify` and the browser journeys both talk to PostgreSQL, and the DB suites
      // SKIP loudly without one — which the no-skips gate then turns into a failure. A
      // workflow without the service would fail correctly but confusingly.
      expect(workflow).toMatch(/services:/);
      expect(workflow).toMatch(/postgres:/);
      expect(workflow, 'the gates need SL_DATABASE_URL').toMatch(/SL_DATABASE_URL:/);
    });

    it('builds before it tests', () => {
      /**
       * CLAUDE.md: workspace packages resolve through `dist/`, so an unbuilt dependency
       * fails collection rather than failing a test. Ordering is load-bearing and invisible
       * once it is wrong.
       */
      const buildAt = workflow.indexOf('pnpm build');
      const testAt = workflow.indexOf('pnpm test:verify');
      expect(buildAt, 'no build step').toBeGreaterThan(-1);
      expect(testAt, 'no test step').toBeGreaterThan(-1);
      expect(buildAt).toBeLessThan(testAt);
    });

    it('installs a browser before running the browser journeys', () => {
      const installAt = workflow.indexOf('playwright install');
      const e2eAt = workflow.indexOf('pnpm test:e2e:verify');
      expect(installAt, 'nothing installs a browser').toBeGreaterThan(-1);
      expect(installAt).toBeLessThan(e2eAt);
    });
  });

  it('keeps a single-command local equivalent of the merge gate', () => {
    /**
     * `pnpm verify` exists so "did this pass?" has one answer a person can reproduce. If
     * CI and the local command drift, the useful signal is which gates the local command
     * has stopped covering.
     */
    const verify = scripts['verify'] ?? '';
    expect(verify, 'package.json has no "verify" script').not.toBe('');
    for (const gate of ['lint', 'typecheck', 'boundaries', 'test:verify', 'test:e2e:verify']) {
      expect(verify, `pnpm verify no longer covers ${gate}`).toContain(gate);
    }
  });
});
