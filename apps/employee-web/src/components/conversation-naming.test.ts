/**
 * What a conversation is called in the list.
 *
 * Internal threads carry no title unless somebody types one, and for a colleague chat
 * nobody does — so every direct message rendered as "Untitled conversation" and two of
 * them were indistinguishable without opening each. `participantCount` was the only thing
 * the summary knew about participants: a number, never a name.
 *
 * The precedence below is the whole rule, and each case exists because getting it wrong
 * has a specific cost: overruling a title the user typed, naming a group after one person,
 * or replacing a safe fallback with a misleading name.
 */
import { describe, expect, it } from 'vitest';

import { conversationLabel, relativeTime } from './conversation-naming';
import type { ConversationSummary } from '../lib/api-client';

const summary = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  conversationId: 'c1',
  conversationType: 'INTERNAL_DIRECT',
  sensitivity: 'ORDINARY',
  lastActivityAt: '2026-08-31T10:00:00.000Z',
  participantCount: 2,
  unreadCount: 0,
  /* Not optional on the summary, and false is a real answer — see the type. A fixture that
     omitted them would be constructing a shape the server never sends. */
  readWatermark: 0,
  pinned: false,
  ...over,
});

const person = (displayName: string, principalId = displayName): { principalId: string; displayName: string } => ({
  principalId,
  displayName,
});

describe('conversationLabel', () => {
  it('names a 1:1 after the other person', () => {
    // The defect this whole change exists for.
    expect(
      conversationLabel(summary({ participants: [person('Priya Nair')] })),
      'a direct message still reads as untitled',
    ).toBe('Priya Nair');
  });

  it('names a group with a few names and a count', () => {
    /**
     * A sidebar row cannot carry sixty names, and a count is what a reader actually needs
     * from a large group. Two names plus the remainder.
     */
    const participants = ['Asha', 'Vikram', 'Rahul', 'Meera'].map((n) => person(n));
    expect(conversationLabel(summary({ conversationType: 'INTERNAL_GROUP', participants }))).toBe(
      'Asha, Vikram +2',
    );
  });

  it('does not add a count when everybody fits', () => {
    const participants = ['Asha', 'Vikram'].map((n) => person(n));
    expect(conversationLabel(summary({ participants }))).toBe('Asha, Vikram');
  });

  it('lets an explicit title win over the derived name', () => {
    /**
     * If a person named the conversation, that is what they want to see. A derived name
     * would silently overrule them — and they would have no way to get their own title
     * back.
     */
    expect(
      conversationLabel(
        summary({ title: 'Q3 renewals huddle', participants: [person('Priya Nair')] }),
      ),
    ).toBe('Q3 renewals huddle');
  });

  it('falls back when the server sent no participants', () => {
    /**
     * A customer conversation gets none by design, and an older server sends none at all.
     * Both land on the original string rather than on something misleading.
     */
    expect(conversationLabel(summary({ conversationType: 'CUSTOMER_SERVICE' }))).toBe(
      'Untitled conversation',
    );
  });

  it('falls back when the participant list is present but empty', () => {
    /**
     * A conversation with no other live participant cannot be named after anybody. Treated
     * identically to "not sent", because the outcome is the same and a reader should not
     * have to know which happened.
     */
    expect(conversationLabel(summary({ participants: [] }))).toBe('Untitled conversation');
  });

  it('treats an empty-string title as no title', () => {
    // `?? ` would accept `''` and render a blank row — invisible, and unclickable-looking.
    expect(conversationLabel(summary({ title: '', participants: [person('Priya Nair')] }))).toBe(
      'Priya Nair',
    );
  });
});

/**
 * The list row's timestamp.
 *
 * A full locale date on every row was both wider than the space and less useful than the
 * time within a working day. Each branch below exists because the wrong one is actively
 * misleading — "Yesterday" for something from last week, or a bare weekday for something
 * from three months ago.
 */
describe('relativeTime', () => {
  const now = new Date('2026-08-31T15:00:00');

  it('shows a clock time for today', () => {
    const out = relativeTime(new Date('2026-08-31T09:04:00').toISOString(), now);
    expect(out, 'today should read as a time of day').toMatch(/\d/);
    expect(out).not.toContain('Aug');
  });

  it('says Yesterday for yesterday, even a minute before midnight', () => {
    /**
     * Calendar days, not 24-hour spans. 23:59 yesterday is 15 hours ago and is NOT today;
     * an elapsed-hours implementation calls it "today" and puts a clock time on a row
     * from a different day, which is the one answer a reader cannot recover from.
     */
    expect(relativeTime(new Date('2026-08-30T23:59:00').toISOString(), now)).toBe('Yesterday');
    expect(relativeTime(new Date('2026-08-30T00:01:00').toISOString(), now)).toBe('Yesterday');
  });

  it('names the weekday within the last week', () => {
    expect(relativeTime(new Date('2026-08-27T10:00:00').toISOString(), now)).toBe(
      new Date('2026-08-27T10:00:00').toLocaleDateString(undefined, { weekday: 'short' }),
    );
  });

  it('falls back to a date beyond a week, and adds the year beyond this one', () => {
    expect(relativeTime(new Date('2026-06-14T10:00:00').toISOString(), now)).not.toMatch(/2026/);
    expect(relativeTime(new Date('2025-06-14T10:00:00').toISOString(), now)).toMatch(/2025/);
  });

  it('returns empty rather than "Invalid Date" for an unparseable stamp', () => {
    // A row is allowed to lose its timestamp; it is not allowed to print a JS error into
    // the sidebar.
    expect(relativeTime('not a date', now)).toBe('');
  });
});
