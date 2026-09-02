import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftStore, createDraftAutosaver, draftKey } from './drafts';

const ALICE = 'principal-alice';
const BOB = 'principal-bob';
const CONVERSATION = 'conv-1';

async function wipe(): Promise<void> {
  await DraftStore.clearAllFor(ALICE);
  await DraftStore.clearAllFor(BOB);
}

describe('DraftStore', () => {
  beforeEach(wipe);

  it('round-trips a draft', async () => {
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'half a thought',
      visibility: 'CUSTOMER_VISIBLE',
    });

    const loaded = await DraftStore.load(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE');

    expect(loaded?.body).toBe('half a thought');
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it('never surfaces another person’s draft on a shared machine', async () => {
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'alice was mid-sentence about a sensitive claim',
      visibility: 'INTERNAL',
    });

    // Bob signs in on the same browser and opens the same conversation.
    const asBob = await DraftStore.load(BOB, CONVERSATION, 'INTERNAL');

    expect(asBob).toBeUndefined();
  });

  it('keeps the internal note and the customer reply as separate drafts', async () => {
    // These are genuinely different texts with different audiences. Sharing one slot
    // would let a half-written internal note become the body of a customer reply.
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'customer: we are looking into it',
      visibility: 'CUSTOMER_VISIBLE',
    });
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'internal: policy looks mis-sold, escalate',
      visibility: 'INTERNAL',
    });

    expect((await DraftStore.load(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE'))?.body).toBe(
      'customer: we are looking into it',
    );
    expect((await DraftStore.load(ALICE, CONVERSATION, 'INTERNAL'))?.body).toBe(
      'internal: policy looks mis-sold, escalate',
    );
  });

  it('deletes rather than stores when the composer is cleared', async () => {
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'something',
      visibility: 'INTERNAL',
    });
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: '   ',
      visibility: 'INTERNAL',
    });

    // Clearing the box must leave no trace that the person was typing here.
    expect(await DraftStore.load(ALICE, CONVERSATION, 'INTERNAL')).toBeUndefined();
  });

  it('clears the draft once the text has become a message', async () => {
    await DraftStore.save({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'sent now',
      visibility: 'CUSTOMER_VISIBLE',
    });

    await DraftStore.clear(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE');

    expect(await DraftStore.load(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE')).toBeUndefined();
  });

  it('wipes every draft for a principal on sign-out, leaving other principals alone', async () => {
    await DraftStore.save({
      principalId: ALICE,
      conversationId: 'conv-1',
      body: 'a',
      visibility: 'INTERNAL',
    });
    await DraftStore.save({
      principalId: ALICE,
      conversationId: 'conv-2',
      body: 'b',
      visibility: 'CUSTOMER_VISIBLE',
    });
    await DraftStore.save({
      principalId: BOB,
      conversationId: 'conv-1',
      body: 'bob keeps his',
      visibility: 'INTERNAL',
    });

    const removed = await DraftStore.clearAllFor(ALICE);

    expect(removed).toBe(2);
    expect(await DraftStore.load(ALICE, 'conv-1', 'INTERNAL')).toBeUndefined();
    expect(await DraftStore.load(ALICE, 'conv-2', 'CUSTOMER_VISIBLE')).toBeUndefined();
    expect((await DraftStore.load(BOB, 'conv-1', 'INTERNAL'))?.body).toBe('bob keeps his');
  });

  it('scopes the key by principal, conversation and visibility', () => {
    expect(draftKey(ALICE, CONVERSATION, 'INTERNAL')).not.toBe(
      draftKey(BOB, CONVERSATION, 'INTERNAL'),
    );
    expect(draftKey(ALICE, CONVERSATION, 'INTERNAL')).not.toBe(
      draftKey(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE'),
    );
  });
});

/**
 * Fake ONLY the debounce timer. Vitest's default also fakes `setImmediate`, which is
 * how `fake-indexeddb` settles its transactions — freezing it deadlocks any `await` on
 * a draft read, which is exactly the assertion these tests exist to make.
 */
const fakeDebounceTimerOnly = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

describe('createDraftAutosaver', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await wipe();
  });

  it('coalesces a burst of keystrokes into one write', async () => {
    fakeDebounceTimerOnly();
    const autosaver = createDraftAutosaver(400);

    for (const body of ['h', 'he', 'hel', 'hell', 'hello']) {
      autosaver.schedule({
        principalId: ALICE,
        conversationId: CONVERSATION,
        body,
        visibility: 'INTERNAL',
      });
      await vi.advanceTimersByTimeAsync(50);
    }

    // Still inside the debounce window — nothing written yet.
    expect(await DraftStore.load(ALICE, CONVERSATION, 'INTERNAL')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect((await DraftStore.load(ALICE, CONVERSATION, 'INTERNAL'))?.body).toBe('hello');
  });

  it('flush() persists immediately, so navigating away does not lose the text', async () => {
    const autosaver = createDraftAutosaver(10_000);

    autosaver.schedule({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'about to switch threads',
      visibility: 'CUSTOMER_VISIBLE',
    });
    await autosaver.flush();

    expect((await DraftStore.load(ALICE, CONVERSATION, 'CUSTOMER_VISIBLE'))?.body).toBe(
      'about to switch threads',
    );
  });

  it('cancel() drops the pending write', async () => {
    fakeDebounceTimerOnly();
    const autosaver = createDraftAutosaver(100);

    autosaver.schedule({
      principalId: ALICE,
      conversationId: CONVERSATION,
      body: 'discard me',
      visibility: 'INTERNAL',
    });
    autosaver.cancel();
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(await DraftStore.load(ALICE, CONVERSATION, 'INTERNAL')).toBeUndefined();
  });

  it('flush() is a no-op when nothing is pending', async () => {
    const autosaver = createDraftAutosaver();
    await expect(autosaver.flush()).resolves.toBeUndefined();
  });
});
