/**
 * The mention draft, which is where the offsets are actually maintained.
 *
 * The server validates what arrives; this decides what is sent. Every case below is a way
 * an offset can silently stop describing the text it points at — and a mention pointing at
 * the wrong characters notifies the wrong person.
 */
import { describe, expect, it } from 'vitest';

import { insertMention, mentionQueryAt, pruneMentions, splitBody } from './mention-draft';
import type { MentionView } from './api-client';

const PRIYA = '018f2c5a-0000-7000-8000-00000000000a';
const ASHA = '018f2c5a-0000-7000-8000-00000000000b';

describe('mentionQueryAt', () => {
  it('finds the query the caret is sitting in', () => {
    expect(mentionQueryAt('hello @pri', 10)).toEqual({ at: 6, term: 'pri' });
    expect(mentionQueryAt('@', 1)).toEqual({ at: 0, term: '' });
  });

  it('does not trigger inside a word', () => {
    // An email address must not open a member list.
    expect(mentionQueryAt('mail me at priya@coveryou.co.in', 22)).toBeUndefined();
  });

  it('stops at whitespace, so the picker closes once the word ends', () => {
    // The caret is after "check", which is a word away from the `@`.
    expect(mentionQueryAt('@priya please check', 19)).toBeUndefined();
  });

  it('reads the query at the caret, not at the end of the body', () => {
    // Editing earlier text must open the picker for THAT mention, not the last one typed.
    expect(mentionQueryAt('@as and @pr', 3)).toEqual({ at: 0, term: 'as' });
  });

  it('returns nothing for a caret outside the body', () => {
    expect(mentionQueryAt('abc', 9)).toBeUndefined();
    expect(mentionQueryAt('abc', -1)).toBeUndefined();
  });
});

describe('insertMention', () => {
  it('replaces the query and leaves the caret after a trailing space', () => {
    const result = insertMention('hi @pr', { at: 3, term: 'pr' }, 6, [], {
      label: 'Priya Nair',
      principalId: PRIYA,
    });
    expect(result.body).toBe('hi @Priya Nair ');
    expect(result.caret).toBe(result.body.length);
    expect(result.mentions).toEqual([
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 3, length: 11 },
    ]);
  });

  it('shifts a later mention by the change in length', () => {
    /**
     * The case that breaks a naive implementation. Inserting a long name BEFORE an
     * existing mention moves it — and an unshifted offset then marks the wrong run of
     * characters, which is a mention of the wrong person.
     */
    const existing: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: ASHA, offset: 7, length: 5 },
    ];
    // "@p and @Asha" → replacing "@p" (offset 0..2) with "@Priya Nair "
    const result = insertMention('@p and @Asha', { at: 0, term: 'p' }, 2, existing, {
      label: 'Priya Nair',
      principalId: PRIYA,
    });
    expect(result.body).toBe('@Priya Nair  and @Asha');
    const asha = result.mentions.find((m) => m.kind === 'PRINCIPAL' && m.principalId === ASHA);
    expect(asha?.offset).toBe(17);
    expect(result.body.slice(17, 17 + 5)).toBe('@Asha');
  });

  it('inserts @all with no principal', () => {
    const result = insertMention('@a', { at: 0, term: 'a' }, 2, [], { label: 'all' });
    expect(result.body).toBe('@all ');
    expect(result.mentions).toEqual([{ kind: 'ALL', offset: 0, length: 4 }]);
  });

  it('drops a mention the insertion overwrote', () => {
    // Retyping over an existing mention replaces it; keeping the old offset would leave a
    // mention pointing into the middle of the new name.
    const existing: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: ASHA, offset: 0, length: 5 },
    ];
    const result = insertMention('@Asha', { at: 0, term: 'Asha' }, 5, existing, {
      label: 'Priya Nair',
      principalId: PRIYA,
    });
    expect(result.mentions).toEqual([
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 0, length: 11 },
    ]);
  });
});

describe('pruneMentions', () => {
  const label = (mention: MentionView): string | undefined =>
    mention.kind === 'ALL' ? 'all' : mention.principalId === PRIYA ? 'Priya Nair' : undefined;

  it('keeps a mention whose text still matches', () => {
    const mentions: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 0, length: 11 },
    ];
    expect(pruneMentions('@Priya Nair hello', mentions, label)).toEqual(mentions);
  });

  it('drops a mention whose text was edited', () => {
    /**
     * Somebody backspacing inside "@Priya Nair" means they no longer want that mention.
     * Conservative on purpose: a dropped mention becomes ordinary text, which is visible
     * and harmless — a kept-but-wrong one notifies the wrong person.
     */
    const mentions: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 0, length: 11 },
    ];
    expect(pruneMentions('@Priya Nai hello', mentions, label)).toEqual([]);
  });

  it('drops a mention that now runs past the end of the body', () => {
    const mentions: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 0, length: 11 },
    ];
    expect(pruneMentions('@Priya', mentions, label)).toEqual([]);
  });

  it('drops a mention of somebody who is no longer resolvable', () => {
    // A colleague removed from the group while the message was being written.
    const mentions: MentionView[] = [
      { kind: 'PRINCIPAL', principalId: ASHA, offset: 0, length: 5 },
    ];
    expect(pruneMentions('@Asha hello', mentions, label)).toEqual([]);
  });
});

describe('splitBody', () => {
  it('splits around a mention', () => {
    const parts = splitBody('hi @Priya Nair here', [
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 3, length: 11 },
    ]);
    expect(parts.map((p) => p.text)).toEqual(['hi ', '@Priya Nair', ' here']);
    expect(parts[1]?.mention).toBeDefined();
    expect(parts[0]?.mention).toBeUndefined();
  });

  it('returns one plain part when there are none', () => {
    expect(splitBody('ordinary', [])).toEqual([{ text: 'ordinary' }]);
  });

  it('renders a malformed mention as plain text rather than throwing', () => {
    /**
     * The array is validated server-side, but an older client or a corrupted row must not
     * be able to break the message list — a thread that fails to render is worse than one
     * that renders a mention as plain text.
     */
    const parts = splitBody('short', [
      { kind: 'ALL', offset: 40, length: 4 },
      { kind: 'ALL', offset: 0, length: -1 },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('short');
  });

  it('never drops or duplicates a character of the body', () => {
    // The property that matters: whatever the mentions say, the reader sees the message.
    const body = '@all and @Priya Nair and more text';
    const parts = splitBody(body, [
      { kind: 'ALL', offset: 0, length: 4 },
      { kind: 'PRINCIPAL', principalId: PRIYA, offset: 9, length: 11 },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(body);
  });
});
