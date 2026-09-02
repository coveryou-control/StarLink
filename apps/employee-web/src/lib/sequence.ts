/**
 * Client-side sequence-gap detection (FR-RT-4, doc §20.6, §19.5).
 *
 * The server stamps every conversation event with a monotonic per-conversation `seq`.
 * The transport does not promise to deliver all of them: a socket can drop, a
 * reconnect can straddle a publish, a backplane can lose a frame. So the client treats
 * realtime as a HINT and the database as the truth (FR-RT-1, "realtime is additive").
 *
 * Three cases, and the third is the one that matters:
 *
 *   seq == last + 1   → apply directly. The common path.
 *   seq <= last       → discard. A duplicate or a reorder; we already have it.
 *   seq >  last + 1   → GAP. Do not apply, do not guess, do not interpolate.
 *                       Re-fetch the range from the API, which is authoritative.
 *
 * Applying an out-of-order event would render a thread that never existed — message 7
 * above message 5 — and the user would have no way to know. Re-fetching is slower and
 * always right, which is the correct trade for a thread someone makes decisions from.
 */

export type SequenceVerdict =
  | { readonly kind: 'APPLY' }
  | { readonly kind: 'DISCARD'; readonly reason: 'DUPLICATE_OR_REORDER' }
  | { readonly kind: 'REFETCH'; readonly from: number; readonly to: number };

/** Tracks the highest contiguous seq applied, per conversation. */
export class SequenceTracker {
  readonly #high = new Map<string, number>();

  /**
   * The seq of the newest event applied contiguously. `0` means nothing applied yet,
   * which is why the FIRST event of a conversation must be handled explicitly: with no
   * baseline, seq 43 is not a gap, it is simply where this client joined.
   */
  highWaterMark(conversationId: string): number {
    return this.#high.get(conversationId) ?? 0;
  }

  /**
   * Establish the baseline after a REST fetch. The fetch is authoritative, so whatever
   * seq it carries becomes the new floor — this is also how a gap gets resolved.
   */
  reset(conversationId: string, seq: number): void {
    this.#high.set(conversationId, seq);
  }

  forget(conversationId: string): void {
    this.#high.delete(conversationId);
  }

  /**
   * Classify an inbound event. Pure: does not mutate. Call {@link commit} once the
   * event has actually been applied to the UI, so a render failure cannot silently
   * advance the watermark past an event the user never saw.
   */
  classify(conversationId: string, seq: number): SequenceVerdict {
    const last = this.#high.get(conversationId);

    // No baseline: this client has not fetched this conversation yet. We cannot tell a
    // gap from a cold start, so we refuse to guess and let the fetch establish truth.
    if (last === undefined) {
      return { kind: 'REFETCH', from: 0, to: seq };
    }

    if (seq <= last) return { kind: 'DISCARD', reason: 'DUPLICATE_OR_REORDER' };
    if (seq === last + 1) return { kind: 'APPLY' };
    return { kind: 'REFETCH', from: last + 1, to: seq };
  }

  /** Advance the watermark. Only ever moves forward. */
  commit(conversationId: string, seq: number): void {
    const last = this.#high.get(conversationId) ?? 0;
    if (seq > last) this.#high.set(conversationId, seq);
  }
}

/**
 * Reconnect backoff with full jitter (NFR-REL-4, doc §20.9).
 *
 * When a gateway instance dies, every socket it held reconnects at once. Without
 * jitter they retry in lockstep and the replacement instance is hit by the same
 * thundering herd that just killed its predecessor — and then that one dies too.
 *
 * Full jitter (random over the whole interval, not base ± a wiggle) is what actually
 * spreads the herd; the AWS architecture blog's measurements are the usual reference.
 * We take `random` as a parameter so the spread is testable rather than asserted.
 */
export function reconnectDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 30_000;
  const random = options.random ?? Math.random;

  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exponential);
}
