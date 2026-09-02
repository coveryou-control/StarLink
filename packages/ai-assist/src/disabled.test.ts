/**
 * Part IV §68 gate 9, first clause: "human fallback works with AI entirely disabled."
 *
 * The gate is about the SHAPE of the failure, not about the absence of a provider.
 * Anything can be absent; what the gate asks is whether the rest of the product keeps
 * working when it is — and that depends on the provider refusing in a way callers are
 * obliged to handle. `FAIL_DEGRADED` is that obligation, and these tests pin it.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider, RedactedTranscriptRef, UUID } from '@starlink/shared-contracts';
import { DisabledAIProvider, isAiDisabled } from './disabled.js';

const REF: RedactedTranscriptRef = {
  conversationId: '018f2c5a-a1a1-7000-8000-000000000002' as UUID,
  upToSeq: 4,
  redactionProfile: 'starlink-redaction-v1',
};

/**
 * Every capability the contract declares, called the way a caller would.
 *
 * Enumerated as data so that a capability added to `AIProvider` and forgotten here is a
 * TypeScript error at the `satisfies` below — rather than an untested method that quietly
 * returns `undefined` when AI is off.
 */
const CAPABILITIES = {
  classifyIntent: (p: AIProvider) => p.classifyIntent(REF),
  summarise: (p: AIProvider) => p.summarise('HANDOFF', REF),
  draftReply: (p: AIProvider) => p.draftReply(REF),
  answerFromKnowledge: (p: AIProvider) => p.answerFromKnowledge('what is my premium?', 'PUBLIC'),
  assessRisk: (p: AIProvider) => p.assessRisk('DLP', REF),
  extractActions: (p: AIProvider) => p.extractActions(REF),
} satisfies Record<
  Exclude<keyof AIProvider, 'health'>,
  (provider: AIProvider) => Promise<{ ok: boolean }>
>;

describe('AI entirely disabled (§68 gate 9)', () => {
  it('refuses every capability, and never throws', async () => {
    const provider = new DisabledAIProvider();

    for (const [name, call] of Object.entries(CAPABILITIES)) {
      const result = await call(provider);

      expect(result.ok, `${name} did not refuse`).toBe(false);
      expect(isAiDisabled(result as never), `${name} refused for the wrong reason`).toBe(true);
    }
  });

  it('classifies the failure as FAIL_DEGRADED, which is what makes fallback obligatory', async () => {
    /**
     * The whole gate turns on this value. `FAIL_DEGRADED` is defined in
     * `shared-contracts` as "the feature disappears, the conversation continues" and
     * names AI in its definition. `FAIL_CLOSED` would tell callers to deny, which would
     * make an absent AI provider block human work — the exact inversion of gate 9.
     */
    const result = await new DisabledAIProvider().summarise('HANDOFF', REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.failureClass).toBe('FAIL_DEGRADED');
  });

  it('is not retryable — there is no provider to retry against', async () => {
    const result = await new DisabledAIProvider().draftReply(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A retryable refusal would put the job fabric into a loop against a decision.
    expect(result.error.retryable).toBe(false);
  });

  it('reports health as DOWN with MOCK authority, never as UP', async () => {
    /**
     * "Nothing is broken" is not the same as "the provider is up", and a dashboard
     * cannot tell the difference from a green tick. INTEGRATION_CONTRACTS §1 rule 4:
     * an interim implementation must never be mistakable for a canonical one.
     */
    const health = await new DisabledAIProvider().health();

    expect(health.status).toBe('DOWN');
    expect(health.authority).toBe('MOCK');
    expect(health.detail).toContain('N-05');
  });

  it('carries a fresh correlation id per refusal, not the one it was constructed with', async () => {
    let n = 0;
    const provider = new DisabledAIProvider({ correlationId: () => `req-${(n += 1)}` });

    const first = await provider.classifyIntent(REF);
    const second = await provider.classifyIntent(REF);

    expect(first.ok || second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.error.correlationId).toBe('req-1');
    expect(second.error.correlationId).toBe('req-2');
  });

  it('leaks nothing about the transcript into the refusal', async () => {
    /**
     * An error `detail` is a log field, and §32.2 forbids message content in logs at any
     * depth. The refusal knows which capability was asked for and nothing else — in
     * particular not the conversation id, which would put a customer reference into every
     * refusal line for a feature that is merely switched off.
     */
    const result = await new DisabledAIProvider().assessRisk('MIS_SELLING', REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain(REF.conversationId);
    expect(result.error.detail).toEqual({ capability: 'assessRisk' });
  });
});
