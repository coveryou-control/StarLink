import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The audit surface is read-only, and this is what enforces it.
 *
 * ## Why a source check rather than a role check
 *
 * Because the auditor is the organisation's ADMINISTRATOR. It can create accounts, assign
 * roles and manage channels — so "this account holds no write action" is not available as a
 * guarantee. That was available while the capability sat on a dedicated account, and the
 * moment the product decided one ADMIN should do both jobs, it stopped being.
 *
 * What remains available is the shape of the surface. `/v1/audit` exposes only `@Get`
 * handlers, so there is no door through which the audit view could send, reply, react,
 * edit, delete, forward or impersonate — not because each is refused, but because none is
 * routed. This test reads the controller and fails the build if that stops being true.
 *
 * A reviewer would probably notice a `@Post` added to a file called `audit.controller.ts`.
 * Probably is not a control.
 *
 * ## What it cannot say
 *
 * It cannot prove the handlers do not write — a `@Get` can call anything. The complement is
 * the read path itself: these handlers use `MessageReader.readPage` and plain `SELECT`s,
 * and touch neither `READ_STATE_STORE` nor `ConversationNotifier` nor the realtime gateway,
 * which is what keeps an audit view from marking messages read, moving a receipt, or
 * notifying the people being audited. Those absences are asserted below as absences,
 * because that is the form the guarantee actually takes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'audit.controller.ts'), 'utf8');

/**
 * The controller with its COMMENTS REMOVED.
 *
 * The first version of this guard scanned the raw file and failed on the controller's own
 * docstring, which names `READ_STATE_STORE` and `POST /read` in the course of explaining
 * that it deliberately uses neither. A guard that cannot tell an import from a sentence
 * about an import reports the careful explanation as the defect — and the fix somebody
 * reaches for is deleting the explanation.
 */
const controller = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the audit controller routes nothing that writes', () => {
  it('declares only @Get handlers', () => {
    const verbs = [...controller.matchAll(/@(Get|Post|Put|Patch|Delete)\s*\(/g)].map((m) => m[1]);

    expect(verbs.length, 'no route decorators found — this guard would be vacuous').toBeGreaterThan(
      5,
    );
    expect(
      [...new Set(verbs)],
      'the audit surface must expose only reads. A write route here is a way for an audit ' +
        'view to change what it is auditing.',
    ).toEqual(['Get']);
  });

  it('imports no write-capable store', () => {
    /**
     * The stores that mutate a conversation. Importing one into this file would be the step
     * before a `@Get` handler quietly does something a `@Get` should not, and it is far
     * easier to spot at the import than at the call.
     */
    for (const forbidden of [
      'MESSAGE_STORE',
      'READ_STATE_STORE',
      'ConversationNotifier',
      'REACTION_STORE',
      'PIN_STORE',
      'STAR_STORE',
      'ARCHIVE_STORE',
      'HIDDEN_MESSAGE_STORE',
    ]) {
      expect(
        controller.includes(forbidden),
        `${forbidden} is imported by the audit controller. Opening a conversation in audit ` +
          'mode must not mark it read, move a receipt, react, pin, or notify anybody.',
      ).toBe(false);
    }
  });

  it('does not mark anything read', () => {
    /* The requirement in its own words: opening a conversation in audit mode must not mark
       messages as read for employees. On the employee tree that is a separate `POST /read`;
       here there is nothing to call it from, and nothing that calls it. */
    expect(/markRead|lastReadSeq|\/read\b/.test(controller)).toBe(false);
  });

  it('issues no realtime frame', () => {
    // Typing indicators, presence and delivery receipts are all writes that the people being
    // audited would SEE. An audit that announces itself to its subject is not an audit.
    for (const forbidden of ['emit(', 'SOCKET_EVENTS', 'publish(']) {
      expect(controller.includes(forbidden), `audit controller references ${forbidden}`).toBe(
        false,
      );
    }
  });

  it('goes through the audit gate on every handler', () => {
    /**
     * Each handler must call `mayRead`, which rate-limits, decides and writes the ledger row
     * before any content is read. Counted against the number of routes so a handler added
     * without one is a failure rather than a silent hole.
     */
    const routes = [...controller.matchAll(/@Get\s*\(/g)].length;
    const gated = [...controller.matchAll(/this\.mayRead\(/g)].length;

    /* `permission` is the one route that does not read content — it answers whether to offer
       the door — so it uses the capability check directly instead. */
    expect(gated).toBe(routes - 1);
    expect(controller).toContain('holdsAuditCapability');
  });
});
