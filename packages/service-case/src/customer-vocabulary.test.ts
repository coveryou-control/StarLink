/**
 * PHASE 6 EXIT CRITERION: the customer-vocabulary mapping, with an internal-state leak test.
 *
 * §22.5's table gives internal state one entry for the customer column: **"Never — mapped
 * (D-26)"**. So there are two properties, and the second is the one worth having:
 *
 *   1. Each internal state maps to the right customer word.
 *   2. **No internal state name can reach a customer by any path** — including a state
 *      nobody has thought about yet, which is how the leak actually happens.
 *
 * The bug this file replaces is instructive. `toCustomerState` switched on
 * `'AWAITING_CUSTOMER'`; the enum value is `'WAITING_CUSTOMER'`. Every waiting
 * conversation fell through to the default and displayed as though we were still working
 * on it, so the customer was never told it was their turn. The unit test asserted
 * `toCustomerState('AWAITING_CUSTOMER')` — the same misspelling — and passed for weeks. A
 * test that restates the implementation's assumption cannot catch the implementation's
 * assumption being wrong, which is why the tests below are driven from the STATE ENUM
 * rather than from a list written here.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationState } from '@starlink/shared-contracts';

import {
  internalStatesFor,
  toCustomerStatus,
  DEFAULT_STATUS_WORDING,
  type CustomerVisibleStatus,
} from './customer-vocabulary.js';
import { TRANSITIONS } from './lifecycle.js';

/**
 * Every state the lifecycle can actually be in, derived from §21.4's table.
 *
 * Deliberately not a hand-written list. A state added to the table joins this set
 * automatically, so the exhaustiveness tests below cover it without anyone remembering.
 */
const ALL_STATES: readonly ConversationState[] = [
  ...new Set(TRANSITIONS.flatMap((r) => [r.from, r.to])),
];

const ALL_CUSTOMER_STATUSES: readonly CustomerVisibleStatus[] = [
  'RECEIVED',
  'BEING_LOOKED_AT',
  'WAITING_FOR_YOU',
  'RESOLVED',
];

describe('the mapping is total over the state machine', () => {
  it('gives every reachable internal state a customer word', () => {
    for (const state of ALL_STATES) {
      expect(ALL_CUSTOMER_STATUSES, `${state} has no customer word`).toContain(
        toCustomerStatus(state),
      );
    }
  });

  it('maps the real enum spelling, not a plausible one', () => {
    /**
     * The regression. `WAITING_CUSTOMER` is the enum value; `AWAITING_CUSTOMER` is what
     * the old code and its test both believed. Asserted against the literal the rest of
     * the system uses, so a rename breaks this rather than silently reverting the bug.
     */
    expect(toCustomerStatus('WAITING_CUSTOMER')).toBe('WAITING_FOR_YOU');
    // And the misspelling must NOT produce the waiting word — if it did, the mapping
    // would be accepting both and the original defect could return unnoticed.
    expect(toCustomerStatus('AWAITING_CUSTOMER')).not.toBe('WAITING_FOR_YOU');
  });

  it('maps each state to the word D-26 proposes', () => {
    expect(toCustomerStatus('NEW')).toBe('RECEIVED');
    expect(toCustomerStatus('QUEUED')).toBe('RECEIVED');
    expect(toCustomerStatus('ASSIGNED')).toBe('BEING_LOOKED_AT');
    expect(toCustomerStatus('ACTIVE')).toBe('BEING_LOOKED_AT');
    expect(toCustomerStatus('RESOLVED')).toBe('RESOLVED');
  });

  it('never blames the customer for OUR delay', () => {
    /**
     * `WAITING_INTERNAL` means we are waiting on a colleague — an underwriter, a claims
     * assessor. Showing "waiting for you" would tell the customer the ball is in their
     * court when it is not, and they would sit there believing they had already replied
     * wrongly. This is the row most likely to be got wrong by someone pattern-matching on
     * the word "waiting".
     */
    expect(toCustomerStatus('WAITING_INTERNAL')).toBe('BEING_LOOKED_AT');
    expect(internalStatesFor('WAITING_FOR_YOU')).toEqual(['WAITING_CUSTOMER']);
  });

  it('does not announce closure, because §21.4 says not to', () => {
    // "resolved → closed | Customer notified: No", and a reply past the window "simply
    // continues". Closure is an internal boundary for measuring work (BR-22, §22.4).
    expect(toCustomerStatus('CLOSED')).toBe('RESOLVED');
  });
});

describe('internal-state leak test', () => {
  it('never returns an internal state name as a customer word', () => {
    /**
     * The property §27.16 makes "a fail-closed serialisation rule, not a UI convention".
     *
     * Checked as a SET relationship rather than value by value: no customer-facing word
     * may coincide with any internal state name. That catches the lazy implementation —
     * returning the state unchanged — for states that do not exist yet as well as the
     * ones that do.
     */
    const internalNames = new Set<string>(ALL_STATES);
    for (const status of ALL_CUSTOMER_STATUSES) {
      // RESOLVED is the deliberate exception and worth naming: the internal state and the
      // customer word are the same English word because the business means the same thing
      // by it. Nothing is leaked — the customer learns their case is resolved, which
      // §21.4 says to tell them ("Yes, with the outcome").
      if (status === 'RESOLVED') continue;
      expect(
        internalNames.has(status),
        `the customer word ${status} is also an internal state name`,
      ).toBe(false);
    }
  });

  it('leaks nothing for a state the code has never heard of', () => {
    /**
     * The real leak path. A state added by a migration ahead of the code, or a row edited
     * by hand, must not be passed through to a customer — and must not be guessed
     * upward either.
     */
    for (const unknown of ['ESCALATED', 'BREACHED', 'PENDING_UNDERWRITING', 'ZZZ', '']) {
      const status = toCustomerStatus(unknown);
      expect(status).toBe('RECEIVED');
      expect(status).not.toBe(unknown);
    }
  });

  it('claims the LESS when it does not know', () => {
    /**
     * `RECEIVED`, not `BEING_LOOKED_AT`. "We have your message" is true of everything
     * that exists; "being looked at" asserts a person is working on it. Guessing upward
     * leaves a customer waiting patiently on a promise nobody made.
     */
    expect(toCustomerStatus(undefined)).toBe('RECEIVED');
    expect(toCustomerStatus(null)).toBe('RECEIVED');
  });

  it('exposes no SLA, escalation or priority vocabulary at all', () => {
    /**
     * §22.5: "The row that carries the most risk is SLA state. A customer who can see
     * 'first response breached' has been handed a grievance the company generated
     * itself." The vocabulary has four values and none of them is about our performance.
     */
    const forbidden = ['BREACH', 'SLA', 'ESCALAT', 'PRIORITY', 'OVERDUE', 'LATE', 'QUEUE'];
    for (const status of ALL_CUSTOMER_STATUSES) {
      for (const word of forbidden) {
        expect(status.toUpperCase()).not.toContain(word);
        expect(DEFAULT_STATUS_WORDING[status].toUpperCase()).not.toContain(word);
      }
    }
  });
});

describe('the wording is a seam, not a decision', () => {
  it('gives every status a word, and keeps them apart from the mapping', () => {
    // D-26 is PROPOSED (§44.5). The words are the business's to ratify; which internal
    // states collapse together is a safety property and is not theirs to loosen.
    for (const status of ALL_CUSTOMER_STATUSES) {
      expect(DEFAULT_STATUS_WORDING[status]).toBeTruthy();
    }
    expect(DEFAULT_STATUS_WORDING.WAITING_FOR_YOU).toBe('Waiting for you');
  });
});
