/**
 * Mention validation.
 *
 * Every case here is a way a client could produce a mention that is wrong rather than
 * merely unusual — and two of them are ways it could produce one that is dangerous.
 */
import { describe, expect, it } from 'vitest';

import { mentionRecipients, validateMentions, MAX_MENTIONS, type Mention } from './mentions.js';

const A = '018f2c5a-0000-7000-8000-00000000000a';
const B = '018f2c5a-0000-7000-8000-00000000000b';
const OUTSIDER = '018f2c5a-0000-7000-8000-0000000000ff';
const members = new Set([A, B]);

const person = (principalId: string, offset: number, length: number): Mention => ({
  kind: 'PRINCIPAL',
  principalId: principalId as never,
  offset,
  length,
});

describe('validateMentions', () => {
  it('accepts a mention that lines up with the body', () => {
    // "@Asha please look" — the mention covers characters 0..5.
    const result = validateMentions([person(A, 0, 5)], '@Asha please look', members, true);
    expect(result.ok).toBe(true);
  });

  it('refuses a mention of somebody who is not in the conversation', () => {
    /**
     * The dangerous one. A mention is a notification, and a notification points at a
     * conversation — so mentioning an outsider would send somebody a link that `decide()`
     * then refuses, which tells them a conversation exists and who is in it.
     */
    const result = validateMentions([person(OUTSIDER, 0, 5)], '@Asha hello', members, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MENTION_NOT_A_PARTICIPANT');
  });

  it('refuses offsets that fall outside the body', () => {
    /**
     * The other dangerous one, in a quieter way: a renderer slicing the body at a
     * client-supplied offset would either throw or mark the wrong characters, and the
     * offsets arrive from a browser.
     */
    for (const bad of [person(A, -1, 5), person(A, 0, 0), person(A, 8, 40), person(A, 1.5, 3)]) {
      const result = validateMentions([bad], '@Asha hi', members, true);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.reason).toBe('MENTION_OUT_OF_RANGE');
    }
  });

  it('refuses two mentions covering the same characters', () => {
    // Merging them would invent a mention nobody made; rendering both would put two marks
    // over one run of text.
    const result = validateMentions([person(A, 0, 5), person(B, 3, 5)], '@Asha @Bo hi', members, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MENTION_OVERLAPS');
  });

  it('allows two mentions that merely touch', () => {
    // The control for the case above: `offset + length === next.offset` is adjacent, not
    // overlapping, and a strict `<=` would reject a perfectly ordinary "@a@b".
    const result = validateMentions([person(A, 0, 3), person(B, 3, 3)], '@a @b more', members, true);
    expect(result.ok).toBe(true);
  });

  it('returns mentions in reading order whatever order they arrived in', () => {
    // '@a to @b' is eight characters; '@b' is the last two.
    const result = validateMentions([person(B, 6, 2), person(A, 0, 2)], '@a to @b', members, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mentions.map((m) => m.offset)).toEqual([0, 6]);
  });

  it('refuses @all where it is not permitted', () => {
    /**
     * A one-to-one, or a customer conversation. On the first it means the one person
     * already reading it; on the second the participant set includes somebody outside the
     * company, and "notify everyone" must never quietly mean that.
     */
    const all: Mention = { kind: 'ALL', offset: 0, length: 4 };
    expect(validateMentions([all], '@all hi', members, false)).toEqual({
      ok: false,
      reason: 'MENTION_ALL_NOT_PERMITTED',
    });
    expect(validateMentions([all], '@all hi', members, true).ok).toBe(true);
  });

  it('bounds how many mentions one message may carry', () => {
    const many = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => person(A, i * 2, 1));
    const result = validateMentions(many, 'x'.repeat(400), members, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TOO_MANY_MENTIONS');
  });

  it('accepts a message with no mentions at all', () => {
    expect(validateMentions([], 'ordinary message', members, true)).toEqual({ ok: true, mentions: [] });
  });
});

describe('mentionRecipients', () => {
  it('resolves @all to every participant', () => {
    const recipients = mentionRecipients([{ kind: 'ALL', offset: 0, length: 4 }], [A, B], A);
    expect(recipients).toEqual([B]);
  });

  it('never notifies the sender, however they were named', () => {
    /**
     * `NEVER_NOTIFIED` includes `OWN_ACTION`, and being told you mentioned yourself is the
     * clearest possible case of it. True for an explicit self-mention and for @all alike.
     */
    expect(mentionRecipients([person(A, 0, 3)], [A, B], A)).toEqual([]);
    expect(mentionRecipients([{ kind: 'ALL', offset: 0, length: 4 }], [A], A)).toEqual([]);
  });

  it('notifies somebody once when they are both named and covered by @all', () => {
    // One event that names somebody twice is one notification, not two.
    const recipients = mentionRecipients(
      [person(B, 0, 3), { kind: 'ALL', offset: 5, length: 4 }],
      [A, B],
      A,
    );
    expect(recipients).toEqual([B]);
  });
});
