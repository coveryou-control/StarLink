/**
 * §9: "`UNKNOWN` delivery triggers reconciliation, never optimistic success."
 */
import { describe, expect, it } from 'vitest';
import type {
  ChannelAdapter,
  DeliveryStatus,
  ProviderAccept,
  ReconciliationReport,
  Result,
  Timestamp,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

import { needsReconciliation, reconcileChannels } from './reconcile.js';

const AT = '2026-08-28T09:00:00.000Z' as Timestamp;

const status = (s: DeliveryStatus) => ({ providerMessageId: 'p-1', status: s, occurredAt: AT });

class FixtureAdapter implements ChannelAdapter {
  constructor(
    readonly channel: ChannelAdapter['channel'],
    private readonly outcome: ReconciliationReport | 'ERROR' | 'THROW',
  ) {}

  async reconcile(): Promise<Result<ReconciliationReport>> {
    if (this.outcome === 'THROW') throw new Error('provider client exploded');
    return this.outcome === 'ERROR'
      ? err({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'timeout',
          retryable: true,
          failureClass: 'FAIL_DEGRADED',
          correlationId: 'test',
        })
      : ok(this.outcome);
  }
  async send(): Promise<Result<ProviderAccept>> {
    throw new Error('not used');
  }
  async verifyWebhook(): Promise<never> {
    throw new Error('not used');
  }
  async receiveWebhook(): Promise<never> {
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
  async health() {
    return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: AT };
  }
}

describe('an ambiguous provider result is never optimistic', () => {
  it('flags UNKNOWN for reconciliation', () => {
    expect(needsReconciliation(status('UNKNOWN'))).toBe(true);
  });

  it('leaves resolved statuses alone', () => {
    for (const s of ['ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'SUPERSEDED'] as const) {
      expect(needsReconciliation(status(s))).toBe(false);
    }
  });
});

describe('one provider failing does not stop the others', () => {
  it('reports per channel, and distinguishes a failed pass from a clean one', async () => {
    const results = await reconcileChannels(
      [
        new FixtureAdapter('WHATSAPP', { checked: 10, corrected: 3, stillUnknown: 1 }),
        new FixtureAdapter('SMS', 'ERROR'),
        new FixtureAdapter('EMAIL', 'THROW'),
      ],
      AT,
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      channel: 'WHATSAPP',
      report: { checked: 10, corrected: 3, stillUnknown: 1 },
    });
    // Reported, not thrown: a pass that failed must be visible as a failure rather than
    // as an absent number, which reads as "nothing left unknown".
    expect(results[1]?.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(results[2]?.errorCode).toBeDefined();
    expect(results[2]?.report).toBeUndefined();
  });
});
