/**
 * §21.4's transition table exists ONCE, in `@starlink/service-case`.
 *
 * Until 2026-08-28 there were two. `packages/conversation-domain/src/state-machine.ts`
 * held a second transcription, exported from that package's barrel, imported by nothing
 * and covered by no test. It had survived since Phase 1 because a dead file breaks
 * nothing — and it was a trap rather than merely clutter, because
 * `import { TRANSITIONS } from '@starlink/conversation-domain'` compiled and returned a
 * table that DISAGREED with the real one:
 *
 *   * `new → assigned` omitted LEAD, so a lead assigning would have been refused.
 *   * `resolved → active` omitted LEAD and flattened §21.4's "reason required if
 *     staff-initiated" to "not required", so a staff reopen would have gone unexplained.
 *   * there was no CLOSED terminal guard and no ALREADY_IN_STATE, so a reply to a closed
 *     conversation would have revived it and silently extended a bounded window.
 *
 * The authoritative copy is named by three sources — `CURRENT_STATE_AUDIT.md` §"State
 * machine", `STARLINK_IMPLEMENTATION_PLAN.md`'s Phase 6 slice 2, and the dependency
 * direction (`conversation-domain` depends on `service-case`, so the lower package owns
 * the table).
 *
 * This guard is a source scan rather than a type check on purpose: TypeScript is content
 * with two exported constants of the same name in two packages, and it was for months.
 * What has to be prevented is the FILE coming back, so the file is what is checked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, REPO_ROOT } from './source-scan.js';

const AUTHORITATIVE = 'packages/service-case/src/lifecycle.ts';
const SERVICE_CASE_LIFECYCLE = join(REPO_ROOT, ...AUTHORITATIVE.split('/'));

describe('§21.4 has exactly one transition table', () => {
  it('the authoritative table is in @starlink/service-case', () => {
    expect(
      existsSync(SERVICE_CASE_LIFECYCLE),
      'packages/service-case/src/lifecycle.ts is the transcription of §21.4 that the ' +
        'implementation plan, the state audit and the dependency direction all name as ' +
        'authoritative. If it moved, this guard must move with it.',
    ).toBe(true);

    const source = readFileSync(SERVICE_CASE_LIFECYCLE, 'utf8');
    // The rows the deleted duplicate got wrong. Asserted here rather than in the package
    // suite because these are precisely the differences that made two copies dangerous.
    expect(source).toContain("from: 'ACTIVE', to: 'RESOLVED'");
    expect(source).toMatch(/from: 'RESOLVED',\s*\n?\s*to: 'ACTIVE'|from: 'RESOLVED', to: 'ACTIVE'/);
  });

  it('no other package declares a §21.4 TRANSITIONS table', () => {
    /**
     * `TRANSITIONS` is searched for as a DECLARATION, not as a mention. Importing it,
     * re-exporting it and testing it are all fine — the whole point is that there is one
     * to import. What must not exist is a second `export const TRANSITIONS`.
     */
    const declaration = /export\s+const\s+TRANSITIONS\b/;

    const offenders = collectSourceFiles()
      .filter((file) => file.path !== AUTHORITATIVE)
      // This file quotes the pattern it searches for, so it matches itself. Excluded by
      // path rather than by making the pattern cleverer — a guard that cannot state
      // plainly what it forbids is a guard nobody can read.
      .filter((file) => file.path !== 'infrastructure/guards/src/single-transition-table.test.ts')
      .filter((file) => declaration.test(file.content))
      .map((file) => file.path);

    expect(
      offenders,
      `A second §21.4 transition table has appeared in: ${offenders.join(', ')}.\n` +
        'Two copies of a decision table do not stay equal. The last pair disagreed about ' +
        'whether a lead may reopen and whether a closed conversation may be revived, and ' +
        'nothing noticed because the second copy had no callers and no tests. Import ' +
        "`TRANSITIONS` from '@starlink/service-case' instead.",
    ).toEqual([]);
  });

  it('the state machine is not re-exported from @starlink/conversation-domain', () => {
    const barrel = join(REPO_ROOT, 'packages', 'conversation-domain', 'src', 'index.ts');
    const source = readFileSync(barrel, 'utf8');

    /**
     * The specific regression. The dead table was reachable only because this barrel
     * exported it, which is what made a wrong import compile.
     *
     * An EXPORT statement, not a mention. The barrel carries a comment explaining why the
     * state machine is not there, and a substring search would flag the explanation as
     * the offence — which is the kind of guard people delete rather than satisfy.
     */
    const reExported = /^\s*export\s[^\n]*['"]\.\/state-machine\.js['"]/m.test(source);

    expect(
      reExported,
      'packages/conversation-domain/src/index.ts exports a state machine again. That ' +
        'package depends on @starlink/service-case, which owns §21.4 — re-exporting a ' +
        'local copy makes `import { TRANSITIONS } from "@starlink/conversation-domain"` ' +
        'compile and return the wrong table.',
    ).toBe(false);
  });
});
