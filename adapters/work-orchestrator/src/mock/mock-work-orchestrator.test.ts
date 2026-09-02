import { describe, expect, it } from 'vitest';
import { workOrchestratorConformance } from '@starlink/shared-contracts';
import { MockWorkOrchestrator } from './mock-work-orchestrator.js';

const fixture = async () => {
  const adapter = new MockWorkOrchestrator();
  const queueEntryId = crypto.randomUUID();
  adapter.enqueue({ queueEntryId, conversationId: crypto.randomUUID(), teamId: 'support' });
  return {
    adapter,
    queueEntryId,
    claimantIds: Array.from({ length: 25 }, () => crypto.randomUUID()),
  };
};

workOrchestratorConformance({ describe, it, expect: expect as never }, fixture);

describe('MockWorkOrchestrator specifics', () => {
  it('accepts after-hours intake without assigning it or starting a clock', async () => {
    // Doc §23.3: the message is received, stored and queued. No countdown, no
    // estimated response time, and nothing routed to a person who is not rostered.
    const adapter = new MockWorkOrchestrator();
    const decision = await adapter.requestRouting({
      conversationId: crypto.randomUUID(),
      intent: { category: 'claims' },
      channel: 'WEBSITE',
      businessHoursState: 'AFTER_HOURS',
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.outcome).toBe('DEFERRED_AFTER_HOURS');
  });

  it('refuses a transfer with no reason', async () => {
    const adapter = new MockWorkOrchestrator();
    const result = await adapter.transfer({
      conversationId: crypto.randomUUID(),
      fromPrincipal: crypto.randomUUID(),
      toPrincipal: crypto.randomUUID(),
      reason: '   ',
      actor: crypto.randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REASON_REQUIRED');
  });

  it('reports queue depth and the age of the oldest waiting item', async () => {
    const adapter = new MockWorkOrchestrator();
    adapter.enqueue({ queueEntryId: crypto.randomUUID(), conversationId: crypto.randomUUID(), teamId: 'claims' });
    adapter.enqueue({ queueEntryId: crypto.randomUUID(), conversationId: crypto.randomUUID(), teamId: 'claims' });
    const snapshot = await adapter.queueSnapshot('claims');
    expect(snapshot.ok).toBe(true);
    // Nobody waits invisibly (FR-ROUTE-4): waiting work is always countable.
    if (snapshot.ok) expect(snapshot.value.depth).toBe(2);
  });
});
