/**
 * Deduplication, coalescing and the retry ladder (doc §29.4, §29.5, §29.6).
 *
 * ## At-least-once, and why that is the right way round
 *
 * §29.5 states the trade explicitly rather than leaving it to be discovered:
 *
 * > "At-least-once is the honest guarantee — a rare duplicate email is acceptable, a lost
 * > assignment notification is not."
 *
 * So a worker that delivers and then crashes before marking the row will deliver again.
 * Everything below is arranged around making that rare and harmless rather than around
 * pretending it cannot happen.
 *
 * ## The three suppressions, which are different things
 *
 *   * **Dedupe** — the same event notified twice. Suppressed on
 *     `(recipient, event, target)` within a short window, by a partial unique index in
 *     the schema, so two writers racing produce one row rather than two notifications.
 *   * **Coalescing** — a storm from one conversation. §29.5: *"'3 new messages', not
 *     three notifications."* This is not deduplication: the events are genuinely
 *     different and all of them happened; what is collapsed is the TELLING.
 *   * **Preference** — the recipient does not want this channel at all (§29.6), which is
 *     decided before a row is ever written.
 *
 * Conflating dedupe and coalescing is the easy mistake, and the symptom is losing real
 * events: dedupe drops a duplicate, coalescing summarises a set. A summary that dropped
 * two of three messages would be wrong in a way a count makes visible.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { NotificationChannel, NotifiableEvent } from './matrix.js';

export type NotificationState = 'PENDING' | 'PROCESSING' | 'SENT' | 'RETRYING' | 'DEAD_LETTER';

/** What an adapter reports back. §29.3: every adapter answers in the same three ways. */
export type DeliveryOutcome =
  | { readonly outcome: 'DELIVERED' }
  /** Transient — a provider outage, a timeout. Rows accumulate and drain on recovery. */
  | { readonly outcome: 'RETRYABLE'; readonly errorCode: string }
  /**
   * §29.6: "Permanent failure (invalid address) — row dead-lettered, principal flagged
   * for administrative attention. Not retried forever."
   */
  | { readonly outcome: 'PERMANENT_FAILURE'; readonly errorCode: string };

export interface NotificationRow {
  readonly notificationId: UUID;
  readonly recipientId: UUID;
  readonly channel: NotificationChannel;
  readonly event: NotifiableEvent;
  readonly targetRef?: string;
  readonly state: NotificationState;
  readonly attempts: number;
  readonly dedupeKey?: string;
}

/**
 * The dedupe key: `(recipient, event, target)`, exactly as §29.5 specifies.
 *
 * Windowed by the CALLER rather than encoded here, because "a short window" is an
 * operational number and burying it in a key would make it unchangeable without a
 * migration. The schema's partial unique index excludes dead-lettered rows, so a failed
 * notification does not block a later legitimate retry of the same event.
 */
export const dedupeKeyFor = (
  recipientId: UUID,
  event: NotifiableEvent,
  targetRef: string | undefined,
  windowStart: Timestamp,
): string => `${recipientId}:${event}:${targetRef ?? '-'}:${windowStart}`;

/**
 * The start of the dedupe window containing `at`.
 *
 * Bucketed rather than sliding: a sliding window needs a range query per write, while a
 * bucket makes the key deterministic and lets the DATABASE enforce uniqueness. The cost
 * is that two events either side of a boundary both send — which is the failure direction
 * §29.5 already accepts ("a rare duplicate is acceptable").
 */
export const windowStartFor = (at: Timestamp, windowSeconds: number): Timestamp => {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(Date.parse(at) / ms) * ms).toISOString() as Timestamp;
};

/**
 * Exponential backoff with a ceiling, and full jitter.
 *
 * Jitter matters more than the curve. A provider outage puts every pending row on the
 * same schedule, and without jitter they all retry in the same instant on recovery —
 * turning a recovery into a second outage. The same reasoning as the realtime client's
 * reconnect backoff, and the same shape.
 */
export function nextAttemptDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
  return Math.floor(random() * base);
}

export interface RetryPolicy {
  /** After this many failures the row is dead-lettered. §29.6: "not retried forever". */
  readonly maxAttempts: number;
}

export type NextStep =
  | { readonly next: 'SENT' }
  | { readonly next: 'RETRYING'; readonly delayMs: number }
  | { readonly next: 'DEAD_LETTER'; readonly reason: string };

/**
 * What to do with a row after an attempt.
 *
 * A permanent failure dead-letters immediately — retrying an invalid address is spending
 * the retry budget on something that cannot succeed, and it delays every row behind it.
 */
export function afterAttempt(
  row: Pick<NotificationRow, 'attempts'>,
  outcome: DeliveryOutcome,
  policy: RetryPolicy,
  random: () => number = Math.random,
): NextStep {
  if (outcome.outcome === 'DELIVERED') return { next: 'SENT' };

  if (outcome.outcome === 'PERMANENT_FAILURE') {
    return { next: 'DEAD_LETTER', reason: outcome.errorCode };
  }

  const attempts = row.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    // Exhausted rather than impossible — a distinct reason, because the operational
    // response differs: one needs the address fixed, the other needs the provider looked
    // at. §32.4 alerts on the count either way.
    return { next: 'DEAD_LETTER', reason: `RETRIES_EXHAUSTED:${outcome.errorCode}` };
  }
  return { next: 'RETRYING', delayMs: nextAttemptDelayMs(attempts, random) };
}

/**
 * Coalescing lives in the DATABASE, not here (§29.5).
 *
 * There was an in-memory `coalesce()` in this file that collapsed a list of events into
 * one per (recipient, event, target) with a count. Nothing ever called it, and nothing
 * could have: the events it was meant to fold arrive in separate requests, minutes apart
 * and possibly in different processes, so by the time one function could see them all
 * they would already have been delivered.
 *
 * `PgNotificationOutbox.enqueue` does it instead — a conflict on the dedupe key
 * increments `coalesced_count` on the row that is still waiting. That gives §29.5's
 * **"'3 new messages', not three notifications"** with a count that survives a restart,
 * which an in-memory tally would not.
 */
