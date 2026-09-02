/**
 * The inbound half of the channel framework (INTEGRATION_CONTRACTS §9, Part IV §56).
 *
 * §9's rules for every channel adapter, in one sentence: canonical conversation, one
 * business thread across channels, **"duplicate webhooks absorbed idempotently"**,
 * `UNKNOWN` delivery triggers reconciliation rather than optimistic success.
 *
 * A `ChannelAdapter` knows one provider's dialect. It does not — and must not — own the
 * sequencing that makes a webhook safe to receive, because then every adapter would
 * reimplement it and the third one would get it subtly wrong. This module owns the
 * sequence; adapters supply the two provider-specific answers (is this signature valid,
 * what does this payload mean) and nothing else.
 *
 * ## Verify strictly before anything else
 *
 * A webhook endpoint is a URL anyone on the internet can post to. `verifyWebhook` runs
 * against the RAW body before the payload is parsed, let alone acted on: a signature
 * computed over a re-serialised body is not a signature, and a parse that happens first
 * is a parser exposed to unauthenticated input.
 *
 * Verification is FAIL_CLOSED in both directions that can go wrong — a `false` verdict
 * and an adapter that errors while deciding both reject. An adapter that cannot tell us
 * whether a request is genuine has told us not to trust it.
 *
 * ## Two dedupe levels, one of which is the boundary
 *
 * The per-EVENT `idempotencyKey` is the boundary. §9's contract calls it "stable per
 * provider event — the key that makes duplicate webhooks harmless", and it survives a
 * provider that re-batches the same events into a different delivery.
 *
 * The per-DELIVERY `providerEventId` claim is a fast path in front of it: it lets a
 * repeated delivery answer with the same result without re-parsing. It is deliberately
 * not load-bearing — remove it and the behaviour is still correct, only slower.
 */
import type {
  ChannelAdapter,
  InboundChannelEvent,
  Result,
  Timestamp,
  VerifiedWebhook,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

/** What the framework needs from the ledger. Implemented by `PgIdempotencyLedger`. */
export interface IdempotencyLedgerPort {
  claim(
    scope: string,
    key: string,
    at: Timestamp,
  ): Promise<
    | { readonly status: 'FRESH' }
    | { readonly status: 'DUPLICATE'; readonly entry: { readonly resultRef?: string } }
    | { readonly status: 'RECLAIMED'; readonly claimedAt: Timestamp }
  >;
  complete(scope: string, key: string, result: { resultRef?: string }): Promise<void>;
}

/** What the caller does with a normalised event — a Conversation command, in practice. */
export type InboundApplier = (event: InboundChannelEvent) => Promise<{ resultRef?: string }>;

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Buffer;
  /**
   * The provider's own id for this delivery, read from a header by the caller.
   *
   * Absent is allowed and is not an error — several providers do not send one. The
   * delivery-level fast path is simply skipped, and the per-event keys still absorb
   * duplicates.
   */
  readonly providerEventId?: string;
  readonly receivedAt: Timestamp;
}

export interface InboundOutcome {
  /** Events the applier actually ran. */
  readonly applied: number;
  /** Events skipped because their key was already completed. */
  readonly absorbed: number;
  /** True when the whole delivery was recognised as one already processed. */
  readonly duplicateDelivery: boolean;
}

export interface InboundPorts {
  readonly ledger: IdempotencyLedgerPort;
  readonly apply: InboundApplier;
  readonly now?: () => Date;
}

const deliveryScope = (channel: string): string => `channel.webhook.delivery:${channel}`;
const eventScope = (channel: string): string => `channel.webhook.event:${channel}`;

/**
 * Verifies, deduplicates and applies one webhook delivery.
 *
 * Returns an error only where the CALLER should refuse the request — a bad signature.
 * Everything else is an outcome, including "this was a duplicate and nothing happened",
 * because a provider that receives an error for a duplicate will retry it forever.
 */
export async function receiveWebhook(
  adapter: ChannelAdapter,
  delivery: WebhookDelivery,
  ports: InboundPorts,
): Promise<Result<InboundOutcome>> {
  const at = (ports.now?.() ?? new Date()).toISOString() as Timestamp;

  // 1. Signature, over the raw bytes, before anything reads the payload.
  const verified = await adapter.verifyWebhook(delivery.headers, delivery.rawBody);
  if (!verified.ok || verified.value !== true) {
    return err({
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'webhook signature could not be verified',
      retryable: false,
      // FAIL_CLOSED: an unverifiable request is treated as hostile, not as degraded.
      failureClass: 'FAIL_CLOSED',
      correlationId: delivery.providerEventId ?? adapter.channel,
    });
  }

  // 2. Delivery-level fast path. Only a COMPLETED claim short-circuits: a claim that was
  //    never completed is a first attempt that died, and the retry is how it recovers.
  if (delivery.providerEventId !== undefined) {
    const claim = await ports.ledger.claim(
      deliveryScope(adapter.channel),
      delivery.providerEventId,
      at,
    );
    if (claim.status === 'DUPLICATE') {
      return ok({ applied: 0, absorbed: 0, duplicateDelivery: true });
    }
  }

  const envelope: VerifiedWebhook = {
    providerEventId: delivery.providerEventId ?? `${adapter.channel}:${at}`,
    receivedAt: delivery.receivedAt,
    // Parsing is the adapter's, and it happens only after the signature held.
    payload: delivery.rawBody,
  };

  const normalised = await adapter.receiveWebhook(envelope);
  if (!normalised.ok) return normalised;

  let applied = 0;
  let absorbed = 0;

  for (const event of normalised.value) {
    const claim = await ports.ledger.claim(eventScope(adapter.channel), event.idempotencyKey, at);
    if (claim.status === 'DUPLICATE') {
      absorbed += 1;
      continue;
    }

    /**
     * `RECLAIMED` falls through to the applier on purpose.
     *
     * The row exists but no result was ever recorded, which means the first attempt did
     * not finish. §29.5's reasoning generalises: "a rare duplicate is acceptable, a lost
     * [event] is not". Skipping here would turn every mid-processing crash into a
     * silently dropped customer message.
     */
    const result = await ports.apply(event);
    // Completed only AFTER the applier returned. A `complete` before the work would make
    // the next delivery a no-op for work that never happened.
    await ports.ledger.complete(eventScope(adapter.channel), event.idempotencyKey, result);
    applied += 1;
  }

  if (delivery.providerEventId !== undefined) {
    await ports.ledger.complete(deliveryScope(adapter.channel), delivery.providerEventId, {
      resultRef: `applied:${applied}`,
    });
  }

  return ok({ applied, absorbed, duplicateDelivery: false });
}
