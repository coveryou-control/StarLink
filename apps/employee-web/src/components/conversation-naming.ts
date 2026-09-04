/**
 * How a conversation is named and dated in the interface.
 *
 * ## Why these three live together, and apart from the components
 *
 * `conversation-list.tsx` needed the initials and `chat-header.tsx` needed the label, so
 * each imported the other and dependency-cruiser failed the build on the cycle. It was
 * right to: the two modules are peers with no ownership relation, and picking either one
 * as the home for a shared helper would have been arbitrary.
 *
 * They are also the only genuinely reusable part of either file — pure functions over a
 * summary, with no React, no state and no fetch — which is what makes them easy to test
 * exhaustively and worth testing that way. The components keep the rendering.
 */
import type { ConversationSummary } from '../lib/api-client';


/**
 * What to call a conversation in the list.
 *
 * Internal threads have no title unless somebody types one, and for a colleague chat
 * nobody does — so every direct message read "Untitled conversation" and two of them were
 * indistinguishable without opening each. The server now sends the other participants for
 * INTERNAL types, and this turns them into a label.
 *
 * The order is deliberate:
 *
 *   1. An explicit title always wins. If a person named the conversation, that is what
 *      they want to see, and a derived name would silently overrule them.
 *   2. Otherwise the people in it — one name for a direct message, a few plus a count for
 *      a group, because a sidebar row cannot carry sixty names and a count is what a
 *      reader actually needs from a large one.
 *   3. Otherwise the original fallback, unchanged. A customer conversation gets no
 *      participants from the server by design, and an older server sends none at all;
 *      both land here rather than on something misleading.
 *
 * `undefined` and `[]` are treated the same on purpose: a conversation with no other live
 * participant cannot be named after anybody, whichever way the server said so.
 */
const GROUP_NAMES_SHOWN = 2;

export function conversationLabel(conversation: ConversationSummary): string {
  if (conversation.title !== undefined && conversation.title !== '') return conversation.title;

  const others = conversation.participants ?? [];
  if (others.length === 0) return 'Untitled conversation';
  if (others.length === 1) return others[0]!.displayName;

  const shown = others.slice(0, GROUP_NAMES_SHOWN).map((p) => p.displayName);
  const remaining = others.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} +${remaining}` : shown.join(', ');
}


/**
 * One or two letters, from the first two words.
 *
 * Deliberately not an image: there is no avatar store, and inventing one would be a
 * feature. Initials give the eye something stable to track down a list of conversations,
 * which is most of what an avatar does in a chat app anyway.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  const first = words[0]![0] ?? '';
  const second = words.length > 1 ? (words[1]![0] ?? '') : '';
  return (first + second).toUpperCase();
}

/**
 * "12:04", "Yesterday", "Tue", "14 Aug" — what a chat application puts on a list row.
 *
 * A full `toLocaleDateString()` on every row is both wider than the space available and
 * less useful: within a working day the time is the answer, and beyond a week the date is.
 * Rendered inside a `<time dateTime=…>` with the absolute value in the tooltip, so nothing
 * is lost and a screen reader still reaches the machine-readable stamp.
 *
 * Computed at render, which means it can go stale in a tab left open. It is a list hint,
 * not a fact anybody acts on, and the list re-renders on every poll anyway.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);

  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'short' });
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * What an avatar should show for a conversation.
 *
 * A group and a one-to-one both rendered one set of initials taken from the conversation's
 * NAME, so "Q3 renewals huddle" became "QR" — initials of a phrase, which look like a
 * person's and are not. A reader scanning the list could not tell a group from a colleague
 * without reading the row.
 *
 * A group now shows the first letters of two members, which is what a group IS, and the
 * stylesheet gives it a squarer frame so the shape differs too — colour and letters alone
 * would not survive a greyscale screenshot (NFR-ACC-3).
 */
export function avatarFor(conversation: ConversationSummary): {
  readonly text: string;
  readonly isGroup: boolean;
} {
  const others = conversation.participants ?? [];
  const isGroup = conversation.conversationType === 'INTERNAL_GROUP' || others.length > 1;

  if (!isGroup) {
    return { text: initialsFor(conversationLabel(conversation)), isGroup: false };
  }

  /**
   * No text at all — a group is drawn as a figure, not a letter.
   *
   * It was the first letters of the first two members once, which reads as a PERSON with
   * two initials: "RR" beside "Rahul, Rishitt Gupta" looks exactly like an avatar for
   * somebody called R. R., and a list of five groups became five two-letter circles nobody
   * could tell apart from the direct messages between them.
   *
   * Then it was `#`, which fixed that and introduced its own claim: a hash means a CHANNEL,
   * and StarLink has no channels. Callers now render `GroupGlyph` when `isGroup`, and the
   * empty string is what they fall back to if one ever forgets — a blank tile, which is
   * wrong but not a lie about what the conversation is.
   */
  return { text: '', isGroup: true };
}

/**
 * A stable colour for a person's name in a group thread.
 *
 * ## Why groups need this
 *
 * In a one-to-one, position tells you who spoke. In a group of six it does not, and a
 * column of identically-coloured names is read word by word rather than recognised. Giving
 * each person a consistent hue turns "who said this" from reading into glancing — which is
 * the single biggest readability difference between a two-person and a six-person thread.
 *
 * ## Why these colours
 *
 * All six are darkened, desaturated members of the same family as the indigo accent rather
 * than a rainbow: the point is to distinguish people, not to decorate the thread, and a
 * saturated palette would compete with the mention pill and the unread badge, which are
 * the two things that genuinely need to be noticed.
 *
 * Chosen by a hash of the PRINCIPAL id, not of the display name — two colleagues who share
 * a name must not share a colour, and somebody's colour must not change when they are
 * renamed. Stable across sessions and across everybody's screen for free, with no state.
 *
 * Never the only signal: the name itself is always there in text (NFR-ACC-3).
 */
const SENDER_COLOURS = [
  'var(--sender-1)',
  'var(--sender-2)',
  'var(--sender-3)',
  'var(--sender-4)',
  'var(--sender-5)',
  'var(--sender-6)',
] as const;

export function senderColour(principalId: string | undefined): string {
  if (principalId === undefined || principalId === '') return 'var(--accent)';
  // FNV-ish: cheap, deterministic, and spread well enough over six buckets for the
  // handful of people in one conversation.
  let hash = 0;
  for (let index = 0; index < principalId.length; index += 1) {
    hash = (hash * 31 + principalId.charCodeAt(index)) >>> 0;
  }
  return SENDER_COLOURS[hash % SENDER_COLOURS.length]!;
}
