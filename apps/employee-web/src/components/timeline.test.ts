/**
 * Day separators and the unread rule.
 *
 * Both are small functions whose wrong answers are quietly misleading rather than
 * obviously broken — a separator on the wrong side of midnight, or a "New" line pointing
 * at something already read — so each case below is a specific way of being wrong.
 */
import { describe, expect, it } from 'vitest';

import { crossesDay, daySeparatorLabel, unreadDividerIndex } from './timeline';
import type { MessageView } from '../lib/api-client';

const ME = 'me';
const THEM = 'them';

let seq = 0;
const msg = (createdAt: string, senderPrincipalId = THEM): MessageView => {
  seq += 1;
  return {
    messageId: `m${seq}`,
    conversationId: 'c1',
    seq,
    visibility: 'INTERNAL',
    senderPrincipalId,
    senderKind: 'EMPLOYEE',
    senderDisplayName: senderPrincipalId,
    body: 'x',
    createdAt,
  } as MessageView;
};

describe('crossesDay', () => {
  it('is true for the first message, which always opens a day', () => {
    expect(crossesDay(undefined, msg('2026-08-31T09:00:00'))).toBe(true);
  });

  it('is false within one calendar day, however far apart', () => {
    // 20 hours apart and still the same day. An elapsed-hours rule would split this.
    expect(crossesDay(msg('2026-08-31T03:00:00'), msg('2026-08-31T23:00:00'))).toBe(false);
  });

  it('is true across midnight, however close together', () => {
    /**
     * The case an elapsed-hours implementation gets wrong in the other direction: 40
     * minutes apart, and the reader has gone to bed and come back. The separator is what
     * tells them the reply arrived the next morning rather than straight away.
     */
    expect(crossesDay(msg('2026-08-30T23:50:00'), msg('2026-08-31T00:30:00'))).toBe(true);
  });

  it('does not invent a separator from an unparseable stamp', () => {
    // A bad date must not put a rule labelled "" in the middle of the thread.
    expect(crossesDay(msg('nonsense'), msg('2026-08-31T10:00:00'))).toBe(false);
  });
});

describe('daySeparatorLabel', () => {
  const now = new Date('2026-08-31T15:00:00');

  it('says Today and Yesterday rather than the date', () => {
    expect(daySeparatorLabel('2026-08-31T09:00:00', now)).toBe('Today');
    expect(daySeparatorLabel('2026-08-30T23:59:00', now)).toBe('Yesterday');
  });

  it('carries the weekday with the date further back', () => {
    // "Mon, 24 Aug" locates a conversation in a working week; "24 Aug" does not.
    const label = daySeparatorLabel('2026-08-24T09:00:00', now);
    expect(label).toMatch(/24/);
    expect(label).toMatch(/[A-Za-z]{3}/);
  });

  it('adds the year only once it is not this one', () => {
    expect(daySeparatorLabel('2026-01-04T09:00:00', now)).not.toMatch(/2026/);
    expect(daySeparatorLabel('2025-01-04T09:00:00', now)).toMatch(/2025/);
  });

  it('returns empty rather than "Invalid Date" for an unparseable stamp', () => {
    expect(daySeparatorLabel('nonsense', now)).toBe('');
  });
});

describe('unreadDividerIndex', () => {
  it('points at the first message the reader has not seen', () => {
    const messages = [msg('2026-08-31T09:00:00'), msg('2026-08-31T09:01:00'), msg('2026-08-31T09:02:00')];
    // Two unread means the last two, so the rule goes above index 1.
    expect(unreadDividerIndex(messages, ME, 2)).toBe(1);
  });

  it('counts only other people, but positions across everything', () => {
    /**
     * The count is defined server-side as messages after the marker that somebody ELSE
     * sent, so a reply of your own in the unread run must not consume one of them — but it
     * must still be below the rule, because it happened after the last thing you read.
     */
    const messages = [
      msg('2026-08-31T09:00:00'),
      msg('2026-08-31T09:01:00'),
      msg('2026-08-31T09:02:00', ME),
      msg('2026-08-31T09:03:00'),
    ];
    expect(unreadDividerIndex(messages, ME, 2)).toBe(1);
  });

  it('shows nothing when everything has been read', () => {
    const messages = [msg('2026-08-31T09:00:00'), msg('2026-08-31T09:01:00')];
    expect(unreadDividerIndex(messages, ME, 0)).toBe(-1);
    expect(unreadDividerIndex(messages, ME, -1)).toBe(-1);
  });

  it('shows nothing when the whole page is unread', () => {
    /**
     * A rule above the first message is a label for the entire screen, not a boundary
     * within it — it tells the reader nothing they cannot already see.
     */
    const messages = [msg('2026-08-31T09:00:00'), msg('2026-08-31T09:01:00')];
    expect(unreadDividerIndex(messages, ME, 2)).toBe(-1);
  });

  it('shows nothing when the marker is older than the loaded page', () => {
    /**
     * `unreadCount` covers the whole conversation and the page is bounded, so the count
     * can exceed what is loaded. Running off the top must return "no divider", not the
     * index the loop happened to stop at — which would put the rule in an arbitrary place.
     */
    const messages = [msg('2026-08-31T09:00:00'), msg('2026-08-31T09:01:00')];
    expect(unreadDividerIndex(messages, ME, 50)).toBe(-1);
  });

  it('handles an empty page', () => {
    expect(unreadDividerIndex([], ME, 3)).toBe(-1);
  });
});
