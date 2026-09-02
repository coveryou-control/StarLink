/**
 * Where the thread breaks: day boundaries, and the line you had read up to.
 *
 * Both are pure functions over the page already in hand, deliberately. A separator that
 * needed a request would be a separator that appears late, and the timeline is the one
 * place in this product where a late layout shift is felt as jank rather than as loading.
 */
import type { MessageView } from '../lib/api-client';

/** Local midnight, as a number. The unit of comparison for everything below. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Do these two messages belong to different days?
 *
 * Calendar days in the READER's timezone, not elapsed hours: two messages 40 minutes
 * apart across midnight are on different days and need the separator, and two messages 20
 * hours apart within one long day do not.
 */
export function crossesDay(previous: MessageView | undefined, current: MessageView): boolean {
  if (previous === undefined) return true;
  const before = new Date(previous.createdAt);
  const after = new Date(current.createdAt);
  if (Number.isNaN(before.getTime()) || Number.isNaN(after.getTime())) return false;
  return startOfDay(before) !== startOfDay(after);
}

/**
 * What the separator says.
 *
 * "Today" and "Yesterday" rather than the date, because those are the two days a reader
 * is actually orienting against and a bare date makes them do the arithmetic. Beyond that
 * the weekday comes with the date — "Mon, 24 Aug" locates a conversation in a working week
 * in a way "24 Aug" does not — and the year appears only once it is not this one.
 */
export function daySeparatorLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * The index of the first message the reader has NOT seen, or `-1` for none.
 *
 * ## Why it is derived rather than read
 *
 * The server does not send a read marker with the message page; it sends `unreadCount` on
 * the conversation SUMMARY, and that count is defined as messages after the read marker
 * that somebody else sent. So the divider is recovered by counting backwards from the
 * newest message over other people's messages until the count is exhausted — which lands
 * on exactly the message the marker sits before.
 *
 * Own messages are skipped in the count but NOT in the position: a reply of yours sent
 * after the last thing you read is not something you need pointing out, and the divider
 * belongs above the first thing you have not seen regardless of what follows it.
 *
 * ## Why the count has to be captured at open
 *
 * Opening the conversation marks it read, so `unreadCount` collapses to zero within a
 * second or two. The caller freezes it on mount; passing the live value would make the
 * divider flicker in and vanish, which is worse than never showing it.
 *
 * Returns `-1` when there is nothing to divide: no unread, a count larger than the page
 * (the marker is older than anything loaded, so every message here is unread and a
 * divider at the very top says nothing), or an unread run that begins at index 0.
 */
export function unreadDividerIndex(
  messages: readonly MessageView[],
  currentPrincipalId: string,
  unreadCount: number,
): number {
  if (unreadCount <= 0 || messages.length === 0) return -1;

  let remaining = unreadCount;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.senderPrincipalId !== currentPrincipalId) remaining -= 1;
    if (remaining === 0) return index === 0 ? -1 : index;
  }

  // The marker predates this page. Everything loaded is unread, and a rule at the top of
  // the thread would be a label for the whole screen rather than a boundary within it.
  return -1;
}
