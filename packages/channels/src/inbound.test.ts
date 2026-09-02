/**
 * PHASE 8 EXIT CRITERION: duplicate-webhook idempotency.
 *
 * The plan's line is "Channel adapter framework hardened (webhook verify, idempotent
 * receive, reconcile)" with a duplicate-webhook idempotency test as the exit. §9's rule
 * is one clause — "duplicate webhooks absorbed idempotently" — and the whole risk is
 * that it is TRUE for the easy duplicate and false for the one that matters:
 *
 *   * the same delivery posted twice — easy, and the fast path handles it;
 *   * the same EVENT arriving in a differently-batched delivery — the real case, and the
 *     one a delivery-id check alone gets wrong;
 *   * a retry after the first attempt CRASHED — which must NOT be absorbed, because the
 *     retry is the only thing that can recover the message.
 *
 * The last one is why this framework claims and completes separately, and it is the case
 * a naive "insert if absent" gets exactly backwards.
 *
 * There is no channel adapter yet. D-01 answered web chat on our own website, which posts
 * to our own authenticated API rather than sending a provider webhook — so V1 may have no
 * inbound webhook at all (P8-9, open). The adapter here is therefore a fixture, and what
 * is proven is the framework's sequencing, not any provider's dialect.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChannelAdapter,
  InboundChannelEvent,
  Result,
  Timestamp,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

import { receiveWebhook, type IdempotencyLedgerPort } from './inbound.js';

const AT = '2026-08-28T09:00:00.000Z' as Timestamp;

/** The ledger, in memory, with the same claim/complete semantics as the SQL one. */
class FakeLedger implements IdempotencyLedgerPort {
  readonly rows = new Map<string, { claimedAt: Timestamp; resultRef?: string; done: boolean }>();

  async claim(scope: string, key: string, at: Timestamp) {
    const id = `${scope}|${key}`;
    const existing = this.rows.get(id);
    if (existing === undefined) {
      this.rows.set(id, { claimedAt: at, done: false });
      return { status: 'FRESH' as const };
    }
    return existing.done
      ? {
          status: 'DUPLICATE' as const,
          entry: existing.resultRef !== undefined ? { resultRef: existing.resultRef } : {},
        }
      : { status: 'RECLAIMED' as const, claimedAt: existing.claimedAt };
  }

  async complete(scope: string, key: string, result: { resultRef?: string }) {
    const id = `${scope}|${key}`;
    const row = this.rows.get(id);
    if (row === undefined) return;
    this.rows.set(id, { ...row, done: true, ...(result.resultRef !== undefined ? { resultRef: result.resultRef } : {}) });
  }
}

const messageEvent = (idempotencyKey: string, body: string): InboundChannelEvent => ({
  kind: 'MESSAGE',
  externalThreadId: 'thread-1',
  externalIdentity: { channel: 'WHATSAPP', externalId: '+910000000000' },
  occurredAt: AT,
  idempotencyKey,
  body,
});

/** A provider fixture. `signatureValid` and the event batch are the test's to set. */
class FixtureAdapter implements ChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  signatureValid = true;
  signatureThrows = false;
  batch: readonly InboundChannelEvent[] = [];
  /** Raw bodies the adapter was asked to verify, in order. */
  readonly verified: Buffer[] = [];
  parses = 0;

  async verifyWebhook(): Promise<Result<boolean>> {
    if (this.signatureThrows) {
      return err({
        code: 'VERIFY_FAILED',
        message: 'signing key unavailable',
        retryable: true,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'fixture',
      });
    }
    return ok(this.signatureValid);
  }

  async receiveWebhook(): Promise<Result<readonly InboundChannelEvent[]>> {
    this.parses += 1;
    return ok(this.batch);
  }

  async send(): Promise<never> {
    throw new Error('not used');
  }
  async mapExternalIdentity(): Promise<never> {
    throw new Error('not used');
  }
  async mapDeliveryStatus(): Promise<never> {
    throw new Error('not used');
  }
  async downloadMedia(): Promise<never> {
    throw new Error('not used');
  }
  async reconcile(): Promise<never> {
    throw new Error('not used');
  }
  async health() {
    return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: AT };
  }
}

const delivery = (id?: string) => ({
  headers: { 'x-signature': 'whatever' },
  rawBody: Buffer.from('{"raw":true}'),
  ...(id !== undefined ? { providerEventId: id } : {}),
  receivedAt: AT,
});

describe('a duplicate webhook is absorbed', () => {
  it('applies once when the same delivery arrives twice', async () => {
    const adapter = new FixtureAdapter();
    adapter.batch = [messageEvent('evt-1', 'hello')];
    const ledger = new FakeLedger();
    const applied: string[] = [];
    const ports = { ledger, apply: async (e: InboundChannelEvent) => { applied.push(e.idempotencyKey); return {}; } };

    const first = await receiveWebhook(adapter, delivery('delivery-A'), ports);
    const second = await receiveWebhook(adapter, delivery('delivery-A'), ports);

    expect(first.ok && first.value.applied).toBe(1);
    expect(second.ok && second.value.duplicateDelivery).toBe(true);
    expect(applied).toEqual(['evt-1']);
  });

  it('applies once when the same EVENT arrives in a different delivery', async () => {
    /**
     * The case a delivery-id check alone gets wrong, and the reason §9 puts the key on
     * the EVENT. A provider that retries a batch after adding a newer event re-sends the
     * old one under a new delivery id; absorbing on delivery id would apply it twice.
     */
    const adapter = new FixtureAdapter();
    const ledger = new FakeLedger();
    const applied: string[] = [];
    const ports = { ledger, apply: async (e: InboundChannelEvent) => { applied.push(e.idempotencyKey); return {}; } };

    adapter.batch = [messageEvent('evt-1', 'hello')];
    await receiveWebhook(adapter, delivery('delivery-A'), ports);

    // Re-batched: the same event, plus a new one, under a new delivery id.
    adapter.batch = [messageEvent('evt-1', 'hello'), messageEvent('evt-2', 'again')];
    const second = await receiveWebhook(adapter, delivery('delivery-B'), ports);

    expect(applied).toEqual(['evt-1', 'evt-2']);
    expect(second.ok && second.value).toMatchObject({ applied: 1, absorbed: 1 });
  });

  it('absorbs duplicates with no provider delivery id at all', async () => {
    // Several providers send no delivery identifier. The event key must carry it alone.
    const adapter = new FixtureAdapter();
    adapter.batch = [messageEvent('evt-1', 'hello')];
    const ledger = new FakeLedger();
    const applied: string[] = [];
    const ports = { ledger, apply: async (e: InboundChannelEvent) => { applied.push(e.idempotencyKey); return {}; } };

    await receiveWebhook(adapter, delivery(), ports);
    await receiveWebhook(adapter, delivery(), ports);

    expect(applied).toEqual(['evt-1']);
  });
});

describe('a retry after a crash is NOT absorbed', () => {
  it('reprocesses an event whose first attempt never completed', async () => {
    /**
     * The failure this whole two-write design exists for. A provider retries because it
     * did not get a 2xx, and the commonest reason for that is a crash partway through.
     * A single insert-if-absent would treat the retry as a duplicate and drop the
     * customer's message — quietly, and with a green ledger row to prove it was handled.
     */
    const adapter = new FixtureAdapter();
    adapter.batch = [messageEvent('evt-1', 'hello')];
    const ledger = new FakeLedger();

    let attempts = 0;
    const crashing = {
      ledger,
      apply: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('worker died mid-apply');
        return {};
      },
    };

    await expect(receiveWebhook(adapter, delivery('delivery-A'), crashing)).rejects.toThrow();

    // The provider retries the same delivery.
    const retry = await receiveWebhook(adapter, delivery('delivery-A'), crashing);

    expect(attempts).toBe(2);
    expect(retry.ok && retry.value.applied).toBe(1);
  });
});

describe('verification comes first, and fails closed', () => {
  it('refuses an invalid signature without parsing the payload', async () => {
    const adapter = new FixtureAdapter();
    adapter.signatureValid = false;
    adapter.batch = [messageEvent('evt-1', 'hello')];
    const ledger = new FakeLedger();
    let applied = 0;

    const result = await receiveWebhook(adapter, delivery('delivery-A'), {
      ledger,
      apply: async () => {
        applied += 1;
        return {};
      },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    // Neither parsed nor applied, and nothing was written to the ledger — an unverified
    // request must not be able to consume an idempotency key and thereby suppress the
    // genuine delivery that follows it.
    expect(adapter.parses).toBe(0);
    expect(applied).toBe(0);
    expect(ledger.rows.size).toBe(0);
  });

  it('refuses when the adapter cannot decide', async () => {
    // An adapter that errors while verifying has told us it cannot vouch for the request.
    const adapter = new FixtureAdapter();
    adapter.signatureThrows = true;
    const ledger = new FakeLedger();

    const result = await receiveWebhook(adapter, delivery('delivery-A'), {
      ledger,
      apply: async () => ({}),
    });

    expect(!result.ok && result.error.failureClass).toBe('FAIL_CLOSED');
    expect(adapter.parses).toBe(0);
  });
});
