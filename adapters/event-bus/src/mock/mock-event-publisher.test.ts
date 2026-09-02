import { describe, expect, it } from 'vitest';
import type { DomainEventEnvelope } from '@starlink/shared-contracts';
import { MockEventPublisher } from './mock-event-publisher.js';

const envelope = (over: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope => ({
  eventId: crypto.randomUUID(),
  name: 'message.created.v1',
  version: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'corr-1',
  payload: {
    messageId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    seq: 1,
    senderKind: 'EMPLOYEE',
    visibility: 'CUSTOMER_VISIBLE',
    channel: 'WEBSITE',
    hasAttachments: false,
  },
  ...over,
});

describe('event publication', () => {
  it('accepts a well-formed catalogue event', async () => {
    const publisher = new MockEventPublisher();
    const result = await publisher.publish([envelope()]);
    expect(result.ok).toBe(true);
    expect(publisher.publishedEvents('message.created.v1').length).toBe(1);
  });

  it('rejects an event that is not in the catalogue', async () => {
    // Catching this in Phase 1 rather than at CCS integration in Phase 10 is the whole
    // reason the mock validates instead of merely recording.
    const publisher = new MockEventPublisher();
    const result = await publisher.publish([envelope({ name: 'conversation.vanished.v1' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_EVENT');
  });

  it('rejects a malformed payload', async () => {
    const publisher = new MockEventPublisher();
    const result = await publisher.publish([envelope({ payload: { messageId: 'not-a-uuid' } })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_EVENT_PAYLOAD');
  });

  it('classifies a transport failure as retryable and queued, never lost', async () => {
    // The business fact is already committed; the relay retries. A publish failure
    // must never read as a reason to undo or drop the event (brief §17).
    const publisher = new MockEventPublisher();
    publisher.failNextPublishes(1);
    const first = await publisher.publish([envelope()]);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.retryable).toBe(true);
      expect(first.error.failureClass).toBe('FAIL_QUEUED');
    }
    const retry = await publisher.publish([envelope()]);
    expect(retry.ok).toBe(true);
  });

  it('carries no message body into the enterprise fabric', async () => {
    // Brief §45: IDs, classifications and metadata only. The event fabric has a wider
    // access list than the message store.
    const publisher = new MockEventPublisher();
    await publisher.publish([envelope()]);
    const [published] = publisher.publishedEvents();
    expect(published).toBeDefined();
    expect(Object.keys(published?.payload ?? {})).not.toContain('body');
  });
});
