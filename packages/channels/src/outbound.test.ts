/**
 * The two gates in front of every customer-channel send.
 *
 * Rule 5 of the project's non-negotiables: "A customer can never see an internal note.
 * If visibility cannot be established, the send fails." And Part IV §58's consent rule:
 * "if eligibility cannot be established, no new proactive outbound contact happens."
 *
 * Both are tested by asserting the adapter was NOT called. A refusal that still reached
 * the provider would be a leak with a tidy error message attached.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChannelAdapter,
  ConsentEligibilityClient,
  Eligibility,
  OutboundChannelMessage,
  ProviderAccept,
  Result,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

import { sendOnChannel } from './outbound.js';

const AT = '2026-08-28T09:00:00.000Z' as Timestamp;
const CONVERSATION = '018f2c5a-6070-7000-8000-000000000001' as UUID;
const MESSAGE = '018f2c5a-6070-7000-8000-000000000002' as UUID;
const SESSION = '018f2c5a-6070-7000-8000-000000000003' as UUID;

class FixtureAdapter implements ChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  sends = 0;

  async send(): Promise<Result<ProviderAccept>> {
    this.sends += 1;
    return ok({ providerMessageId: 'p-1', acceptedAt: AT });
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
  async reconcile(): Promise<never> {
    throw new Error('not used');
  }
  async health() {
    return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: AT };
  }
}

const consentThat = (answer: Eligibility | 'ERROR'): ConsentEligibilityClient => ({
  async checkOutbound() {
    return answer === 'ERROR'
      ? err({
          code: 'CONSENT_UNAVAILABLE',
          message: 'engine down',
          retryable: true,
          failureClass: 'FAIL_CLOSED',
          correlationId: 'test',
        })
      : ok(answer);
  },
  async checkReEngagement() {
    return answer === 'ERROR'
      ? err({
          code: 'CONSENT_UNAVAILABLE',
          message: 'engine down',
          retryable: true,
          failureClass: 'FAIL_CLOSED',
          correlationId: 'test',
        })
      : ok(answer);
  },
  async health() {
    return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: AT };
  },
});

const message = (visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE'): OutboundChannelMessage => ({
  messageId: MESSAGE,
  conversationId: CONVERSATION,
  channelSessionId: SESSION,
  visibility,
  body: 'your claim has been registered',
});

describe('gate 1 — visibility', () => {
  it('refuses an internal note before the adapter is called', async () => {
    const adapter = new FixtureAdapter();

    const result = await sendOnChannel(
      adapter,
      message('INTERNAL'),
      'key-1',
      { purpose: 'claim.update', kind: 'REENGAGEMENT' },
      { consent: consentThat({ allowed: true }) },
    );

    expect(!result.ok && result.error.code).toBe('OUTBOUND_VISIBILITY_REFUSED');
    expect(!result.ok && result.error.failureClass).toBe('FAIL_CLOSED');
    // The gate is only a gate if the provider never saw it.
    expect(adapter.sends).toBe(0);
  });
});

describe('gate 2 — consent', () => {
  it('sends when eligibility is granted', async () => {
    const adapter = new FixtureAdapter();
    const result = await sendOnChannel(
      adapter,
      message('CUSTOMER_VISIBLE'),
      'key-1',
      { purpose: 'claim.update', kind: 'REENGAGEMENT' },
      { consent: consentThat({ allowed: true }) },
    );
    expect(result.ok).toBe(true);
    expect(adapter.sends).toBe(1);
  });

  it('refuses when consent is withheld, and does not retry', async () => {
    const adapter = new FixtureAdapter();
    const result = await sendOnChannel(
      adapter,
      message('CUSTOMER_VISIBLE'),
      'key-1',
      { purpose: 'marketing.nudge', kind: 'REENGAGEMENT' },
      { consent: consentThat({ allowed: false, reason: 'WITHDRAWN' }) },
    );

    expect(!result.ok && result.error.code).toBe('OUTBOUND_CONSENT_DENIED');
    // Retryable would be worse than the refusal itself: a retry loop against a withdrawn
    // consent is how somebody who opted out gets contacted anyway.
    expect(!result.ok && result.error.retryable).toBe(false);
    expect(adapter.sends).toBe(0);
  });

  it('refuses when the consent engine cannot answer', async () => {
    // "Channel availability is never permission." An engine that is down has not said yes.
    const adapter = new FixtureAdapter();
    const result = await sendOnChannel(
      adapter,
      message('CUSTOMER_VISIBLE'),
      'key-1',
      { purpose: 'claim.update', kind: 'REENGAGEMENT' },
      { consent: consentThat('ERROR') },
    );

    expect(!result.ok && result.error.code).toBe('OUTBOUND_CONSENT_UNAVAILABLE');
    expect(!result.ok && result.error.failureClass).toBe('FAIL_CLOSED');
    expect(adapter.sends).toBe(0);
  });

  it('refuses proactive contact with no customer reference', async () => {
    const adapter = new FixtureAdapter();
    const result = await sendOnChannel(
      adapter,
      message('CUSTOMER_VISIBLE'),
      'key-1',
      { purpose: 'renewal.reminder', kind: 'PROACTIVE' },
      { consent: consentThat({ allowed: true }) },
    );

    expect(!result.ok && result.error.code).toBe('OUTBOUND_CONSENT_SUBJECT_MISSING');
    expect(adapter.sends).toBe(0);
  });
});
