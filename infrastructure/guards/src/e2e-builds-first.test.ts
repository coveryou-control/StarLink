import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The browser gate must build before it runs.
 *
 * ## The trap this closes
 *
 * Playwright starts the employee and customer surfaces with `next start`, which serves
 * whatever is already in `.next`. It does not build. So `pnpm test:e2e:verify` on its own
 * ran the LAST build — and a green run then said nothing about the code on disk.
 *
 * It is worse than an ordinary stale-cache annoyance, because the failure is silent and
 * inverted: the suite reports on code you are not looking at, and the more recently you
 * changed something the more confidently it lies. It cost a run reporting two sign-in
 * failures that had already been fixed, and the fix looked wrong until the build was
 * checked.
 *
 * `pnpm verify` always built first, and so does CI — which is exactly why this survived:
 * the composite gate was correct and the one people reach for by hand was not.
 *
 * Turbo caches, so the added build is ~100ms when nothing changed. There is no reason to
 * leave the sharp edge in place for that.
 *
 * ## Why a test rather than a comment
 *
 * Because the next person shortening this script will be doing it for a good reason — it
 * looks like a redundant build inside a composite that already builds — and the harm only
 * shows up much later, in a run that passes.
 */

/* Resolved from THIS file, not from `process.cwd()`: a filtered run
   (`pnpm --filter @starlink/guards test`) has the package directory as its working
   directory, and the root manifest is three levels up. Every other guard in here does the
   same, for the same reason. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('the browser gate cannot run against a stale build', () => {
  it('builds before it starts the servers', () => {
    const script = PACKAGE.scripts?.['test:e2e:verify'];
    expect(script, 'test:e2e:verify has gone').toBeDefined();
    expect(
      script,
      'test:e2e:verify must build first — `next start` serves the previous build, so ' +
        'without this the suite reports on code that is not on disk',
    ).toMatch(/^pnpm build\s*&&/);
  });

  it('still runs the no-skips check afterwards', () => {
    /*
       The other half of the same script, asserted here so that a rewrite which adds the
       build cannot quietly drop the thing that makes a skipped journey fail the gate.
    */
    const script = PACKAGE.scripts?.['test:e2e:verify'] ?? '';
    expect(script).toContain('playwright test');
    expect(script).toContain('no-skips.mjs');
  });

  it('leaves the composite verify script building first too', () => {
    const verify = PACKAGE.scripts?.['verify'] ?? '';
    expect(verify).toMatch(/^pnpm build\s*&&/);
  });
});
