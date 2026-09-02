/**
 * Read receipts — the second tick.
 *
 * ## No new state
 *
 * `conversation.read_state` has carried `(principal_id, conversation_id, last_read_seq)`
 * since the foundation migration, because that watermark is what `unreadCount` is computed
 * from. A read receipt is a PROJECTION of state the product already keeps, seen from the
 * other side: instead of asking "how much of this conversation have I not read", it asks
 * "how much of it has everybody else read".
 *
 * That matters for rule 9. Nothing here exists only in an event — the socket frame makes
 * the tick immediate, and a re-fetch of the page reconstructs exactly the same answer from
 * the table. Pull the realtime layer out entirely and the feature still works, one refresh
 * behind.
 *
 * ## The rule, and why it is the conservative one
 *
 * A message is READ when every OTHER currently-active participant has a watermark at or
 * past its sequence. The watermark for the conversation is therefore the MINIMUM across
 * those people, and a participant who has never opened the thread has no row — which reads
 * as zero and holds the whole conversation at one tick.
 *
 * The failure mode that matters is over-claiming. Telling somebody their message was read
 * when it was not is a lie the product would be telling on a colleague's behalf; telling
 * them it was not read when it just has been is a tick that appears a moment later. So
 * every ambiguous case resolves downward — the same instinct as rule 4, where an unknown
 * permission is denied rather than assumed.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   * Adding a colleague to a group lowers the watermark to zero until they read, so
 *     existing double ticks drop back to one. That is not a glitch. BR-07 gives the new
 *     member the whole history, so it is true that somebody in the conversation has not
 *     read it.
 *   * A conversation with nobody else in it never reaches two ticks, because there is
 *     nobody whose reading could be reported.
 *
 * ## Whose messages
 *
 * Only your own. A tick on somebody else's message would be telling them what you already
 * know and telling you nothing — and on a group it would leak, one message at a time, how
 * closely each colleague is following the thread. The state is per-conversation, so this
 * is a rendering rule rather than a scoping one, and it is asserted in the tests.
 */
import type { UUID } from './primitives.js';

/** One participant's position in the conversation. */
export interface ReadPosition {
  readonly principalId: UUID;
  /** Zero for somebody who has never opened the thread — they have no row. */
  readonly lastReadSeq: number;
}

/**
 * How far EVERYBODY ELSE has read.
 *
 * `0` when there is nobody else, and `0` the moment any one of them is at zero. The
 * caller's own position is excluded rather than assumed absent: the read-state table has a
 * row for the reader too, and including it would let a person's own reading tick their
 * own messages.
 */
export function readWatermark(positions: readonly ReadPosition[], selfId: UUID): number {
  const others = positions.filter((position) => position.principalId !== selfId);
  if (others.length === 0) return 0;
  return others.reduce((lowest, position) => Math.min(lowest, Math.max(0, position.lastReadSeq)), Number.MAX_SAFE_INTEGER);
}

/**
 * What to draw beside a message.
 *
 * `NONE` for a message that is not yours — see the note above on why a colleague's message
 * carries no tick at all. `SENT` means the server has it, which is the fact the single tick
 * has always carried. `READ` means every other participant's watermark has passed it.
 */
export type DeliveryTick = 'NONE' | 'SENT' | 'READ';

export function deliveryTick(input: {
  readonly isMine: boolean;
  readonly seq: number;
  readonly readWatermark: number;
}): DeliveryTick {
  if (!input.isMine) return 'NONE';
  /**
   * A message with no sequence has not been acknowledged by the server yet — the optimistic
   * row the composer appends. It is not "sent", it is pending, and the composer draws that
   * state itself.
   */
  if (!Number.isFinite(input.seq) || input.seq <= 0) return 'NONE';
  return input.readWatermark >= input.seq ? 'READ' : 'SENT';
}
