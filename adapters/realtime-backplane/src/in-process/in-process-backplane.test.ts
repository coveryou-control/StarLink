import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@starlink/shared-contracts';
import { InProcessBackplane } from './in-process-backplane.js';
import { InProcessPresence } from './in-process-presence.js';

const CONVERSATION = '018f2c5a-cccc-7000-8000-00000000000a';
const OTHER_CONVERSATION = '018f2c5a-cccc-7000-8000-00000000000b';

const event = (over: Partial<RealtimeEvent> = {}): RealtimeEvent => ({
  eventId: crypto.randomUUID(),
  name: 'message.created.v1',
  channel: { kind: 'CONVERSATION', conversationId: CONVERSATION },
  seq: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'corr-1',
  payload: { messageId: 'm-1', conversationId: CONVERSATION },
  staffOnly: false,
  ...over,
});

describe('fan-out', () => {
  it('delivers to every subscriber on the channel', async () => {
    const backplane = new InProcessBackplane();
    const received: string[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, (e) =>
      received.push(`a:${e.eventId}`),
    );
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, (e) =>
      received.push(`b:${e.eventId}`),
    );

    const published = event();
    await backplane.publish(published);
    expect(received).toEqual([`a:${published.eventId}`, `b:${published.eventId}`]);
  });

  it('never delivers across channels', async () => {
    // The channel IS the authorization unit (§20.6), so leaking between channels
    // would be leaking between conversations.
    const backplane = new InProcessBackplane();
    const received: RealtimeEvent[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: OTHER_CONVERSATION }, (e) =>
      received.push(e),
    );
    await backplane.publish(event());
    expect(received).toHaveLength(0);
  });

  it('carries no message body — identifiers only (FR-RT-4)', async () => {
    const backplane = new InProcessBackplane();
    let seen: RealtimeEvent | undefined;
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, (e) => {
      seen = e;
    });
    await backplane.publish(event());
    expect(Object.keys(seen?.payload ?? {})).not.toContain('body');
  });

  it('keeps delivering when one subscriber throws', async () => {
    // Realtime is best effort; the message is already durable. One broken socket must
    // not stop the rest of the room from updating.
    const errors: string[] = [];
    const backplane = new InProcessBackplane({ onSubscriberError: (_e, ch) => errors.push(ch) });
    const delivered: string[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, () => {
      throw new Error('socket exploded');
    });
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, () =>
      delivered.push('ok'),
    );

    const result = await backplane.publish(event());
    expect(result.ok).toBe(true);
    expect(delivered).toEqual(['ok']);
    expect(errors).toHaveLength(1);
  });

  it('stops delivering after unsubscribe, and forgets the empty channel', async () => {
    const backplane = new InProcessBackplane();
    const received: RealtimeEvent[] = [];
    const sub = await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, (e) =>
      received.push(e),
    );
    if (!sub.ok) throw new Error('subscribe failed');

    sub.value();
    await backplane.publish(event());
    expect(received).toHaveLength(0);
    // No accumulation of one empty set per conversation ever opened.
    expect(backplane.localSubscriberCount()).toBe(0);
  });

  it('tolerates a subscriber unsubscribing mid-fan-out', async () => {
    const backplane = new InProcessBackplane();
    const delivered: string[] = [];
    const first = await backplane.subscribe(
      { kind: 'CONVERSATION', conversationId: CONVERSATION },
      () => {
        delivered.push('first');
        if (first.ok) first.value();
      },
    );
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: CONVERSATION }, () =>
      delivered.push('second'),
    );
    await expect(backplane.publish(event())).resolves.toMatchObject({ ok: true });
    expect(delivered).toEqual(['first', 'second']);
  });

  it('declares itself single-node so a cluster is never assumed', async () => {
    const health = await new InProcessBackplane().health();
    expect(health.authority).toBe('MOCK');
    expect(health.detail).toContain('single node');
  });
});

describe('presence is ephemeral and expires on the clock', () => {
  const PRINCIPAL = '018f2c5a-cccc-7000-8000-0000000000aa';

  it('reports a live lease', async () => {
    const presence = new InProcessPresence();
    await presence.heartbeat(PRINCIPAL, 'ONLINE', 30);
    const result = await presence.get([PRINCIPAL]);
    expect(result.ok && result.value[0]?.state).toBe('ONLINE');
  });

  it('expires without any sweep job running', async () => {
    // A crashed node must not leave someone ONLINE forever.
    let clock = 1_000_000;
    const presence = new InProcessPresence({ now: () => clock });
    await presence.heartbeat(PRINCIPAL, 'ONLINE', 10);
    clock += 11_000;
    const result = await presence.get([PRINCIPAL]);
    expect(result.ok && result.value[0]?.state).toBe('OFFLINE');
  });

  it('reports OFFLINE for someone never seen, rather than failing', async () => {
    // Presence grants nothing, so absent must read as the safe value.
    const presence = new InProcessPresence();
    const result = await presence.get([PRINCIPAL]);
    expect(result.ok && result.value[0]?.state).toBe('OFFLINE');
  });

  it('expires typing in seconds', async () => {
    let clock = 1_000_000;
    const presence = new InProcessPresence({ now: () => clock });
    await presence.setTyping(CONVERSATION, PRINCIPAL, 5);
    expect((await presence.getTyping(CONVERSATION)) as never).toMatchObject({ value: [PRINCIPAL] });
    clock += 6_000;
    const after = await presence.getTyping(CONVERSATION);
    expect(after.ok && after.value).toHaveLength(0);
  });

  it('keeps typing state per conversation', async () => {
    const presence = new InProcessPresence();
    await presence.setTyping(CONVERSATION, PRINCIPAL, 5);
    const other = await presence.getTyping(OTHER_CONVERSATION);
    expect(other.ok && other.value).toHaveLength(0);
  });
});
