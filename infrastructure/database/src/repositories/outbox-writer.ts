/**
 * The single funnel for writing a domain event to the transactional outbox.
 *
 * ## Why one funnel, and why it validates
 *
 * `MockEventPublisher` already validates against the catalogue — but it does so at
 * PUBLISH time, which is the wrong end for two reasons. By then the row is committed, so a
 * malformed payload cannot fail the request that produced it; and the failure surfaces as
 * a poison outbox row that retries and dead-letters, which is an operational incident
 * standing in for what is really a programming error.
 *
 * Validating here moves that to the write. A payload that does not match §10's catalogue
 * fails inside the caller's transaction, so nothing commits: no message, no state change,
 * no event. The caller learns immediately, and the outbox never contains a row a consumer
 * cannot read.
 *
 * The publisher's check stays. It guards a different boundary — rows written before this
 * existed, replays, and anything that reaches the bus by another route — and two checks at
 * two boundaries is the correct amount for a contract that crosses a process.
 *
 * ## Why it takes a client, never a pool
 *
 * Brief §17: an event that could commit separately from the state change it describes is
 * the drift the transactional outbox exists to prevent. Accepting a pool would make it
 * possible to write one without the other, which is the whole failure mode.
 */
import type pg from 'pg';
import { isKnownEvent, validateEventPayload, type UUID } from '@starlink/shared-contracts';

export interface OutboxEvent {
  /** Must be in §10's catalogue. An unknown name is refused, never passed through. */
  readonly eventName: string;
  readonly eventVersion?: number;
  /** `conversation` or `principal` — what the row is ABOUT, not who hears about it. */
  readonly aggregateType: 'conversation' | 'principal';
  readonly aggregateId: UUID;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
}

/**
 * Thrown when an event does not match the catalogue.
 *
 * A distinct class so a caller can tell a contract violation from a database failure:
 * the first is a bug to fix, the second is an outage to survive.
 */
export class UnpublishableEvent extends Error {
  constructor(
    readonly eventName: string,
    override readonly cause?: unknown,
  ) {
    super(
      `event "${eventName}" does not match the catalogue in @starlink/shared-contracts. ` +
        'Events are a contract (INTEGRATION_CONTRACTS §10, §14) — fix the payload or add ' +
        'the event additively; do not widen the schema to fit a caller.',
    );
    this.name = 'UnpublishableEvent';
  }
}

/** Validates against §10's catalogue and appends, in the caller's transaction. */
export async function appendOutboxIn(client: pg.PoolClient, event: OutboxEvent): Promise<void> {
  if (!isKnownEvent(event.eventName)) {
    throw new UnpublishableEvent(event.eventName);
  }
  try {
    validateEventPayload(event.eventName, event.payload);
  } catch (cause) {
    throw new UnpublishableEvent(event.eventName, cause);
  }

  await client.query(
    `INSERT INTO conversation.outbox
       (outbox_id, event_name, event_version, aggregate_type, aggregate_id, payload, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6)`,
    [
      event.eventName,
      event.eventVersion ?? 1,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
      event.correlationId,
    ],
  );
}
