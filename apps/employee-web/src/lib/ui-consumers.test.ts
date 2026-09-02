/**
 * Every API client method must have a UI consumer.
 *
 * ## The defect this generalises
 *
 * Three times now the same shape has appeared: something is built, tested, and reachable
 * by nothing. The resolve/close path had a domain, a migration, an action vocabulary and a
 * sweep, and no route. Fourteen of sixteen domain events had a relay that knew how to
 * route them and nothing that emitted them. And an audit on 2026-08-29 found the whole
 * agent working surface in that state: `claim`, `resolve`, `transfer`, `escalate`,
 * `cover`, `sla` and the four notification endpoints were guarded, tested, and callable
 * from no screen.
 *
 * A test suite cannot notice that, because every layer passes in isolation. What catches
 * it is asking the boring question in the other direction: **is anything using this?**
 *
 * ## What this checks, and what it cannot
 *
 * A method on `api` must be referenced by a component or a page. That is a weak proof of a
 * working UI and a strong proof against a dead one — it cannot tell whether the button
 * renders or the handler fires, but it fails the moment a capability is added to the client
 * and never wired to anything a person can press.
 *
 * The complement lives in `apps/api/src/employee-journey.test.ts`, which drives the same
 * sequence over real HTTP against a real database. Between them: the journey is correct,
 * and no part of the client is orphaned. Neither one alone would have caught what the
 * audit found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Method names declared on the exported `api` object. */
function clientMethods(): string[] {
  const source = readFileSync(join(SRC, 'lib', 'api-client.ts'), 'utf8');
  const body = source.slice(source.indexOf('export const api = {'));
  // `name: (` at one level of indentation — the object's own entries, not nested calls.
  return [...body.matchAll(/^ {2}(\w+):\s*\(/gm)].map((m) => m[1]!);
}

/** Everything the UI is made of: components and route files, but not the client itself. */
function uiSource(): string {
  return filesUnder(SRC)
    .filter((f) => !f.endsWith(join('lib', 'api-client.ts')))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

describe('the client has no orphaned capabilities', () => {
  it('finds methods to check — the guard must not pass over an empty set', () => {
    // A regex that silently matched nothing would make the assertion below vacuous, which
    // is the failure mode of every source-scanning guard.
    expect(clientMethods().length).toBeGreaterThan(15);
  });

  it('every api.* method is used by a component or a page', () => {
    const ui = uiSource();
    /**
     * Whitespace is allowed between `api` and the method: `directory.tsx` chains across a
     * line break (`api\n  .directory(...)`), which a naive `api\.name` misses. A guard
     * that reports a false orphan gets the guard deleted, not the code fixed.
     */
    const orphans = clientMethods().filter(
      (name) => !new RegExp(`\\bapi\\s*\\.\\s*${name}\\b`).test(ui),
    );

    expect(
      orphans,
      'These API client methods are called by no component or page. Each one is a ' +
        'capability the product has and nobody can reach — the exact state `resolve`, ' +
        '`claim`, `transfer`, `escalate`, `cover`, `sla` and the notification endpoints ' +
        'were in until 2026-08-29. Either wire it to a control or delete it; a method ' +
        'nobody can invoke is not a feature.\n' +
        orphans.join(', '),
    ).toEqual([]);
  });

  it('the tracker-required agent actions are all present in the client', () => {
    /**
     * Named explicitly rather than derived, because these are the ones the tracker's
     * acceptance criteria depend on. A rename that quietly dropped one would otherwise
     * pass the orphan check above — the method would simply not exist to be orphaned.
     *
     * SL-037 claim · SL-016 resolve/reopen · SL-042 transfer · SL-043 escalate ·
     * SL-039 cover · SL-047 sla · SL-060 notifications · SL-006 queue.
     */
    const required = [
      'queue',
      'claim',
      'resolve',
      'reopen',
      'transfer',
      'escalate',
      'cover',
      'sla',
      'notifications',
      'notificationCount',
      'markNotificationRead',
    ];
    const methods = new Set(clientMethods());
    const missing = required.filter((name) => !methods.has(name));

    expect(missing, 'agent actions the tracker requires, absent from the client').toEqual([]);
  });

  it('uses the shared socket contract, never a string literal (F1)', () => {
    /**
     * The realtime protocol drifted silently for months: this app emitted
     * `conversation.subscribe` at a gateway listening for `subscribe`, and listened for
     * `conversation.event` where the gateway emits `event`. A socket name that nobody is
     * listening for produces silence, not an error, so nothing failed and the employee
     * surface never received a single realtime event.
     *
     * The names now come from `@starlink/shared-contracts/realtime`, which makes a rename
     * a compile error on both sides. This guard stops a literal creeping back in.
     */
    const realtime = readFileSync(join(SRC, 'lib', 'use-realtime.ts'), 'utf8');

    expect(realtime, 'the socket contract must be imported, not restated')
      .toContain("@starlink/shared-contracts/realtime");

    const literals = [...realtime.matchAll(/socket\.(?:on|emit)\(\s*'([^']+)'/g)].map((m) => m[1]!);
    /**
     * Socket.IO's OWN lifecycle events are legitimately literals — they are the client
     * library's contract, not ours, and there is nothing to share them with.
     */
    const ours = literals.filter((n) => !['connect', 'disconnect', 'connect_error'].includes(n));

    expect(ours, 'these socket event names bypass the shared contract').toEqual([]);
  });
});
