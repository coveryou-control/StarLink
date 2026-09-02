/**
 * The notification matrix (§29.2) and the delivery rules (§29.4–29.6).
 *
 * Two properties carry the most weight, and neither is about happy-path delivery:
 *
 *   * **The "not notified" list is enforced, not merely written down.** §29.2 names six
 *     things that must never generate a notification, and the last is a leak rather than
 *     noise: an internal note reaching anyone customer-facing (BR-26).
 *   * **A customer gets no channel at all** — not because the channel is undecided (D-12
 *     chose email on 2026-08-28) but because it has no address (D-31) and no provider
 *     (N-07). The assertion is unchanged; what it protects is not.
 */
import { describe, expect, it } from 'vitest';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import {
  channelsFor,
  isNeverNotified,
  subjectFor,
  NEVER_NOTIFIED,
  NOTIFICATION_RULES,
  type NotifiableEvent,
  type RecipientContext,
} from './matrix.js';
import {
  afterAttempt,
  dedupeKeyFor,
  nextAttemptDelayMs,
  windowStartFor,
} from './delivery.js';

const OWNER = '018f2c5a-6011-7000-8000-00000000000a' as UUID;
const OTHER = '018f2c5a-6011-7000-8000-00000000000b' as UUID;

const staff = (over: Partial<RecipientContext> = {}): RecipientContext => ({
  principalKind: 'EMPLOYEE',
  away: false,
  optedOutOf: [],
  ...over,
});

describe('§29.2 — what is notified', () => {
  it('always reaches staff in-app, whatever their preferences', () => {
    // §29.6: in-app "is not disableable — it is the unread mechanism". Opting out of it
    // would mean opting out of knowing you have work.
    const channels = channelsFor('CONVERSATION_ASSIGNED', staff({ optedOutOf: ['EMAIL', 'INAPP'] }));
    expect(channels).toContain('INAPP');
  });

  it('adds email only when the recipient is AWAY, for "in-app + external if away" rows', () => {
    // §29.6's away is "no realtime connection for a configured period… simply 'not
    // currently connected'". Not presence — §21.9 forbids inferring anything from a socket.
    expect(channelsFor('CUSTOMER_REPLIED', staff({ away: false }))).toEqual(['INAPP']);
    expect(channelsFor('CUSTOMER_REPLIED', staff({ away: true }))).toEqual(['INAPP', 'EMAIL']);
  });

  it('sends externally regardless of away for the rows §29.2 marks "in-app + external"', () => {
    // A breached service standard or a role change must not wait for someone to look.
    for (const event of ['WAITING_BEYOND_STANDARD', 'ROLE_OR_ACCESS_CHANGED', 'TRANSFERRED'] as const) {
      expect(channelsFor(event, staff({ away: false })), event).toEqual(['INAPP', 'EMAIL']);
    }
  });

  it('never sends "cover needed" or a queue arrival externally', () => {
    // §29.2 gives both "In-app" only. Paging a whole team's phones for cover is how a
    // team mutes the product, and then misses the breach alert too.
    expect(channelsFor('COVER_NEEDED', staff({ away: true }))).toEqual(['INAPP']);
    expect(channelsFor('NEW_IN_TEAM_QUEUE', staff({ away: true }))).toEqual(['INAPP']);
  });

  it('honours an email opt-out without touching in-app', () => {
    expect(channelsFor('WAITING_BEYOND_STANDARD', staff({ optedOutOf: ['EMAIL'] }))).toEqual(['INAPP']);
  });

  it('notifies nothing for an event with no rule', () => {
    // Fail closed: adding a value to the enum must not make it notifiable by default.
    expect(channelsFor('SOMETHING_NEW' as NotifiableEvent, staff())).toEqual([]);
  });
});

describe('§29.2 subjects are transcribed, not written', () => {
  it('matches the "Notified" column word for word', () => {
    /**
     * The document’s own phrasing, held as data so it can be diffed against the source.
     * A well-meaning rewording fails here rather than quietly becoming the product’s
     * voice — which matters because customer-facing wording is a business decision in
     * this document three separate times (D-20, D-26, D-28), and staff-facing wording is
     * at least adjacent to one.
     */
    const expected: Record<string, string> = {
      CONVERSATION_ASSIGNED: 'A customer conversation assigned to you',
      WAITING_BEYOND_STANDARD: 'A conversation waiting beyond a service standard',
      ESCALATED_TO_YOUR_FUNCTION: 'Escalation to your function',
      TRANSFERRED: 'Transfer into or out of your ownership',
      COVER_NEEDED: 'Cover needed on your team',
      CUSTOMER_REPLIED: 'A customer replied to a thread you own',
      ROLE_OR_ACCESS_CHANGED: 'Your role or access changed',
      NEW_IN_TEAM_QUEUE: "A new conversation in your team's queue",
      CUSTOMER_CONVERSATION_ANSWERED: "A customer's conversation was answered / resolved",
    };

    /**
     * The one row that is NOT a transcription, named here so it cannot grow to two.
     *
     * §29.2 predates the internal-chat stage and has no mention row, so `MENTIONED` is
     * engineering's wording pending confirmation (N-56). Listing it explicitly is what
     * keeps this test a transcription check: a second undocumented row fails below
     * rather than being quietly absorbed by a loosened assertion.
     */
    const notFromTheDocument = new Set(['MENTIONED']);

    for (const rule of NOTIFICATION_RULES) {
      if (notFromTheDocument.has(rule.event)) continue;
      expect(rule.subject, rule.event).toBe(expected[rule.event]);
      expect(subjectFor(rule.event)).toBe(expected[rule.event]);
    }

    // Exactly one row may be engineering's, and it must be the one named above.
    const undocumented = NOTIFICATION_RULES.filter((r) => expected[r.event] === undefined);
    expect(
      undocumented.map((r) => r.event),
      'a notification subject was added without a §29.2 source and without being declared here',
    ).toEqual([...notFromTheDocument]);
    // Every row carries one. A rule added without a subject would fall back to the
    // generic sentence and nobody would notice until an inbox filled with it.
    expect(NOTIFICATION_RULES.every((r) => r.subject.length > 0)).toBe(true);
  });

  it('never returns an enum-shaped string', () => {
    for (const rule of NOTIFICATION_RULES) {
      expect(rule.subject, rule.event).not.toMatch(/^[A-Z_]+$/);
    }
    expect(subjectFor('NO_SUCH_EVENT')).not.toMatch(/^[A-Z_]+$/);
  });
});

describe('a customer gets no channel until D-12 prerequisites land', () => {
  it('returns an empty list rather than an undeliverable one', () => {
    /**
     * D-12 answered EMAIL on 2026-08-28. The list stays empty until D-31 supplies a
     * durable customer address — today it lives in an in-memory session map that expires
     * in 30 minutes, and the worker sends later than that — and until N-07 configures a
     * provider. Opening the channel first would write rows that can never be delivered.
     *
     * When both land, THIS test is the one to change, deliberately, in the same commit
     * that can send. That is why it asserts the empty list rather than merely allowing it.
     */
    const customer: RecipientContext = { principalKind: 'CUSTOMER', away: true, optedOutOf: [] };
    expect(channelsFor('CUSTOMER_CONVERSATION_ANSWERED', customer)).toEqual([]);
  });

  it('gives a customer nothing even for events staff would be paged about', () => {
    // A customer must never be told about a breached standard — §23.6: "A breach is our
    // failure to manage, not news to deliver."
    const customer: RecipientContext = { principalKind: 'CUSTOMER', away: false, optedOutOf: [] };
    for (const event of ['WAITING_BEYOND_STANDARD', 'ESCALATED_TO_YOUR_FUNCTION', 'TRANSFERRED'] as const) {
      expect(channelsFor(event, customer), event).toEqual([]);
    }
  });
});

describe('§29.2 — what is NEVER notified', () => {
  it('keeps the forbidden list as data, so removing one is a visible change', () => {
    for (const forbidden of [
      'MESSAGE_IN_INTERNAL_GROUP',
      'TYPING',
      'READ_RECEIPT',
      'DIRECTORY_CHANGED',
      'OWN_ACTION',
      'INTERNAL_NOTE_TO_CUSTOMER',
    ]) {
      expect(isNeverNotified(forbidden), forbidden).toBe(true);
    }
  });

  it('has no rule that could notify anything on the forbidden list', () => {
    // The two lists must not overlap. If they ever did, the rule would win and the
    // prohibition would be decoration.
    const ruled = new Set<string>(NOTIFICATION_RULES.map((r) => r.event));
    for (const forbidden of NEVER_NOTIFIED) {
      expect(ruled.has(forbidden), `${forbidden} must not have a notification rule`).toBe(false);
    }
  });
});

describe('§29.5 — dedupe', () => {
  const at = '2026-08-28T10:07:30.000Z' as Timestamp;

  it('keys on (recipient, event, target) as the document specifies', () => {
    const window = windowStartFor(at, 300);
    const a = dedupeKeyFor(OWNER, 'CUSTOMER_REPLIED', 'conv-1', window);

    expect(dedupeKeyFor(OWNER, 'CUSTOMER_REPLIED', 'conv-1', window)).toBe(a);
    // Any one of the three differing is a different notification.
    expect(dedupeKeyFor(OTHER, 'CUSTOMER_REPLIED', 'conv-1', window)).not.toBe(a);
    expect(dedupeKeyFor(OWNER, 'CONVERSATION_ASSIGNED', 'conv-1', window)).not.toBe(a);
    expect(dedupeKeyFor(OWNER, 'CUSTOMER_REPLIED', 'conv-2', window)).not.toBe(a);
  });

  it('buckets the window, so two events close together share a key', () => {
    // Bucketed rather than sliding: a bucket makes the key deterministic, which lets the
    // DATABASE enforce uniqueness instead of a range query racing itself.
    const first = windowStartFor('2026-08-28T10:07:30.000Z' as Timestamp, 300);
    const second = windowStartFor('2026-08-28T10:09:59.000Z' as Timestamp, 300);
    expect(second).toBe(first);
  });

  it('lets a later window send again', () => {
    // The cost of bucketing, accepted by §29.5: a rare duplicate is better than a loss.
    const first = windowStartFor('2026-08-28T10:07:30.000Z' as Timestamp, 300);
    const later = windowStartFor('2026-08-28T10:12:00.000Z' as Timestamp, 300);
    expect(later).not.toBe(first);
  });
});

describe('§29.6 — retries, backoff and the dead letter', () => {
  const policy = { maxAttempts: 5 };

  it('marks a delivered row SENT', () => {
    expect(afterAttempt({ attempts: 0 }, { outcome: 'DELIVERED' }, policy).next).toBe('SENT');
  });

  it('retries a transient failure', () => {
    const step = afterAttempt({ attempts: 1 }, { outcome: 'RETRYABLE', errorCode: 'TIMEOUT' }, policy);
    expect(step.next).toBe('RETRYING');
  });

  it('dead-letters an invalid address IMMEDIATELY, without spending retries', () => {
    /**
     * §29.6: "Permanent failure (invalid address) — row dead-lettered… Not retried
     * forever." Retrying something that cannot succeed spends the budget and delays
     * every row behind it.
     */
    const step = afterAttempt({ attempts: 0 }, { outcome: 'PERMANENT_FAILURE', errorCode: 'INVALID_ADDRESS' }, policy);
    expect(step.next).toBe('DEAD_LETTER');
    expect(step.next === 'DEAD_LETTER' && step.reason).toBe('INVALID_ADDRESS');
  });

  it('dead-letters on exhaustion, with a DIFFERENT reason', () => {
    // The operational response differs: one needs an address fixed, the other needs the
    // provider looked at. §32.4 alerts on the count either way.
    const step = afterAttempt({ attempts: 4 }, { outcome: 'RETRYABLE', errorCode: 'TIMEOUT' }, policy);
    expect(step.next).toBe('DEAD_LETTER');
    expect(step.next === 'DEAD_LETTER' && step.reason).toBe('RETRIES_EXHAUSTED:TIMEOUT');
  });

  it('backs off exponentially and caps', () => {
    const alwaysMax = () => 1;
    expect(nextAttemptDelayMs(1, alwaysMax)).toBe(30_000);
    expect(nextAttemptDelayMs(2, alwaysMax)).toBe(60_000);
    expect(nextAttemptDelayMs(20, alwaysMax)).toBe(30 * 60_000);
  });

  it('jitters, so a recovering provider is not hit by every row at once', () => {
    /**
     * The property that matters more than the curve. An outage puts every pending row on
     * the same schedule; without jitter they all retry in the same instant on recovery,
     * turning the recovery into a second outage.
     */
    const delays = new Set(Array.from({ length: 50 }, () => nextAttemptDelayMs(3)));
    expect(delays.size).toBeGreaterThan(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(120_000);
    }
  });
});
