/**
 * Turning what somebody typed into structured mentions.
 *
 * ## Why the offsets are tracked rather than recomputed
 *
 * A mention is a run of characters in the body plus the principal it refers to. The
 * obvious cheap version stores only the ids and finds the runs again at send time by
 * searching the body for each display name — and that is wrong in three ways that all
 * happen in real use: two colleagues called Priya cannot be told apart, a name quoted
 * inside a sentence is marked as if somebody had been addressed, and a name containing a
 * substring of another name matches the wrong span.
 *
 * So the offsets are maintained as the text changes. Everything here is pure so it can be
 * tested exhaustively; the component holds the state.
 */
import type { MentionView } from './api-client';

/** The `@query` the caret is currently sitting in, if any. */
export interface MentionQuery {
  /** Index of the `@`. */
  readonly at: number;
  /** Everything typed after it, which is what the member list filters on. */
  readonly term: string;
}

/**
 * Finds the mention being typed at the caret.
 *
 * A trigger only counts at the start of the body or after whitespace, so an email address
 * does not open a member list. The query stops at whitespace: names contain spaces, but
 * allowing them here would mean every word after an `@` kept the picker open forever, and
 * picking from a filtered list is what inserts the full name anyway.
 */
export function mentionQueryAt(body: string, caret: number): MentionQuery | undefined {
  if (caret < 0 || caret > body.length) return undefined;

  for (let index = caret - 1; index >= 0; index -= 1) {
    const character = body[index]!;
    if (character === '@') {
      const before = index === 0 ? ' ' : body[index - 1]!;
      if (!/\s/.test(before)) return undefined;
      return { at: index, term: body.slice(index + 1, caret) };
    }
    // Whitespace ends the search: the caret is not inside a mention.
    if (/\s/.test(character)) return undefined;
  }
  return undefined;
}

export interface InsertResult {
  readonly body: string;
  readonly caret: number;
  readonly mentions: readonly MentionView[];
}

/**
 * Replaces the `@query` at `query.at` with a complete mention, and shifts everything after
 * it.
 *
 * A trailing space is added because the next thing typed is a word, not more of the name —
 * and without it a second `@` immediately after would be read as part of this mention's
 * text.
 */
export function insertMention(
  body: string,
  query: MentionQuery,
  caret: number,
  existing: readonly MentionView[],
  chosen: { readonly label: string; readonly principalId?: string },
): InsertResult {
  const text = `@${chosen.label}`;
  const next = `${body.slice(0, query.at)}${text} ${body.slice(caret)}`;

  const inserted: MentionView =
    chosen.principalId === undefined
      ? { kind: 'ALL', offset: query.at, length: text.length }
      : { kind: 'PRINCIPAL', principalId: chosen.principalId, offset: query.at, length: text.length };

  /**
   * Everything after the replaced span moves by the difference in length. Mentions that
   * OVERLAP the replaced span are dropped — the characters they referred to are gone, and
   * keeping an offset into text that no longer exists is how a mention ends up marking
   * somebody else's name.
   */
  const replacedLength = caret - query.at;
  const shift = text.length + 1 - replacedLength;

  const kept = existing
    .filter((mention) => mention.offset + mention.length <= query.at || mention.offset >= caret)
    .map((mention) =>
      mention.offset >= caret ? { ...mention, offset: mention.offset + shift } : mention,
    );

  return {
    body: next,
    caret: query.at + text.length + 1,
    mentions: [...kept, inserted].sort((a, b) => a.offset - b.offset),
  };
}

/**
 * Drops mentions that no longer describe the text.
 *
 * Called on every edit. Rather than trying to work out how an arbitrary change moved each
 * span — which needs a diff, and gets it wrong at exactly the moments that matter — this
 * verifies each mention still covers the characters it claims to and discards the ones
 * that do not. Deleting a character inside "@Priya Nair" removes that mention, which is
 * what somebody editing it means.
 *
 * Conservative on purpose: a dropped mention becomes ordinary text, which is visibly
 * different and harmless. A kept-but-wrong mention notifies the wrong person.
 */
export function pruneMentions(
  body: string,
  mentions: readonly MentionView[],
  labelFor: (mention: MentionView) => string | undefined,
): readonly MentionView[] {
  return mentions.filter((mention) => {
    if (mention.offset + mention.length > body.length) return false;
    const expected = labelFor(mention);
    if (expected === undefined) return false;
    return body.slice(mention.offset, mention.offset + mention.length) === `@${expected}`;
  });
}

/**
 * Splits a body into runs, marking the mentioned ones — the shape the renderer needs.
 *
 * Mentions arrive sorted and non-overlapping (the server validates both), but this does
 * not assume it: a malformed array from an older client must render as plain text rather
 * than throwing inside the message list.
 */
export interface BodyPart {
  readonly text: string;
  readonly mention?: MentionView;
}

export function splitBody(body: string, mentions: readonly MentionView[]): readonly BodyPart[] {
  if (mentions.length === 0) return [{ text: body }];

  const ordered = [...mentions].sort((a, b) => a.offset - b.offset);
  const parts: BodyPart[] = [];
  let cursor = 0;

  for (const mention of ordered) {
    const start = mention.offset;
    const end = mention.offset + mention.length;
    // Out of range or overlapping the previous run: skip it rather than slicing wildly.
    if (start < cursor || end > body.length || mention.length <= 0) continue;
    if (start > cursor) parts.push({ text: body.slice(cursor, start) });
    parts.push({ text: body.slice(start, end), mention });
    cursor = end;
  }

  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}
