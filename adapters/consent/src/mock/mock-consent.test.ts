import { describe, expect, it } from 'vitest';
import { consentConformance, type CanonicalRef } from '@starlink/shared-contracts';
import { MockConsentClient } from './mock-consent.js';

const customerRef: CanonicalRef = { system: 'CCS', type: 'customer', id: 'c-1' };

consentConformance({ describe, it, expect: expect as never }, async () => ({
  adapter: MockConsentClient.strict(['service-update']),
  customerRef,
}));

describe('consent fails closed', () => {
  it('refuses to answer when the authority is unreachable, rather than assuming yes', async () => {
    // Part IV §62: if Consent/Contact Governance is unavailable, no new proactive
    // outbound contact that requires an eligibility decision may happen.
    const adapter = MockConsentClient.unavailable();
    const result = await adapter.checkOutbound({ customerRef, channel: 'WHATSAPP', purpose: 'campaign' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failureClass).toBe('FAIL_CLOSED');
      // Retryable, so the job fabric may try again — but never by proceeding.
      expect(result.error.retryable).toBe(true);
    }
  });

  it('denies an unlisted purpose even for a reachable customer', async () => {
    const adapter = MockConsentClient.strict(['service-update']);
    const result = await adapter.checkOutbound({ customerRef, channel: 'SMS', purpose: 'cross-sell' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowed).toBe(false);
      // A denial must say why, so the refusal is explainable to a supervisor.
      if (!result.value.allowed) expect(result.value.reason.length).toBeGreaterThan(0);
    }
  });

  it('allows an explicitly permitted purpose', async () => {
    const adapter = MockConsentClient.strict(['service-update']);
    const result = await adapter.checkOutbound({ customerRef, channel: 'EMAIL', purpose: 'service-update' });
    expect(result.ok && result.value.allowed).toBe(true);
  });

  it('re-checks eligibility for re-engagement separately from the original send', async () => {
    // Consent can be withdrawn between the conversation starting and the next contact,
    // which is why this is a distinct call rather than a cached answer.
    const adapter = MockConsentClient.strict([]);
    const result = await adapter.checkReEngagement({
      conversationId: crypto.randomUUID(),
      channel: 'WHATSAPP',
      purpose: 'follow-up',
    });
    expect(result.ok && result.value.allowed).toBe(false);
  });
});
