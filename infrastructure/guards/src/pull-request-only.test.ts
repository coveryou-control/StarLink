/**
 * `main` is reached through a pull request, and the machinery that enforces it stays wired.
 *
 * ## What this can and cannot guarantee
 *
 * The binding control is GitHub's branch protection: server-side, unskippable, and the
 * only thing that makes "every change on main went through review" a fact rather than a
 * convention. It cannot be asserted from here — this repository does not get to inspect
 * its own remote's settings, and a test that tried would pass on a fork with none.
 *
 * What IS assertable is the local half: a pre-push hook that refuses the push before the
 * objects leave the machine, and the `prepare` script that installs it. That half has a
 * specific failure mode worth guarding — git does not clone hooks, so the whole mechanism
 * rests on one line in package.json pointing `core.hooksPath` at a committed directory.
 * Delete that line and nothing breaks, nothing warns, and the next direct push to main
 * succeeds. Six months later somebody wonders why the hook "stopped working".
 *
 * So: the hook exists, it names the branches, and the script that installs it is present.
 * Three files that have to agree, checked together.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative: string): string => readFileSync(resolve(REPO, relative), 'utf8');

describe('main is protected from a direct push', () => {
  it('the pre-push hook exists and refuses the default branch', () => {
    const hook = read('.githooks/pre-push');

    // The branch list, and the refusal. A hook that ran and exited 0 would be worse than
    // no hook: it would look installed.
    expect(hook, 'the hook must name the branches it protects').toContain('PROTECTED=');
    expect(hook).toMatch(/\bmain\b/);
    expect(hook, 'the hook must actually fail the push').toContain('exit 1');

    // And it must tell the person what to do instead. A refusal with no way forward is
    // how a hook gets deleted rather than followed.
    expect(hook.toLowerCase()).toContain('git switch -c');
  });

  it('`pnpm install` installs it — git does not clone hooks', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const prepare = pkg.scripts?.prepare;

    expect(
      prepare,
      'package.json needs a `prepare` script; without it the hook is a file nobody runs, ' +
        'because git does not clone hooks and nobody remembers a manual setup step',
    ).toBeDefined();
    expect(prepare).toContain('core.hooksPath');
    expect(prepare).toContain('.githooks');
  });

  it('CONTRIBUTING documents the rule and both halves of its enforcement', () => {
    /*
       The hook stops the push; this is what tells somebody why. A control nobody can find
       the reasoning for is a control somebody eventually routes around.

       Checked by SUBSTANCE, not by phrasing. The first version of this test matched the
       sentence "Never commit to main directly" and failed the moment the section was
       rewritten to say the same thing better — a guard that pins prose to one wording
       makes the document harder to improve, which is the opposite of keeping it true.
       These three are things the file has to MENTION, and it cannot mention them by
       accident.
    */
    const contributing = read('CONTRIBUTING.md');

    for (const [what, pattern] of [
      ['the rule itself', /pull request/i],
      ['the local hook', /\.githooks\/pre-push/],
      ['the server-side control', /branch protection/i],
    ] as const) {
      expect(contributing, `CONTRIBUTING.md no longer mentions ${what}`).toMatch(pattern);
    }
  });
});
