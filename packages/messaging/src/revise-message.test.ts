/**
 * Correcting and deleting a message.
 *
 * The rules that matter are the ones about WHO and about what survives: a message is a
 * historical record somebody may later have to argue from (§24.9), so neither operation
 * destroys what was there, and neither is available to anybody but its author.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import { editMessage, redactMessage } from './revise-message.js';
import type { MessageRecord, MessageRevision, MessageStore, OutboxRow } from './ports.js';

const CONVERSATION = '018f2c5a-7000-7000-8000-0000000000c1' as UUID;
const MESSAGE = '018f2c5a-7000-7000-8000-0000000000m1'.replace('m', 'a') as UUID;
const AUTHOR = '018f2c5a-7000-7000-8000-00000000000a' as UUID;
const SOMEBODY_ELSE = '018f2c5a-7000-7000-8000-00000000000b' as UUID;

interface Harness {
  readonly store: MessageStore;
  readonly revisions: MessageRevision[];
  readonly outbox: OutboxRow[];
  readonly previewRefreshes: UUID[];
  readonly state: { message: MessageRecord | undefined };
}

function harness(over: Partial<MessageRecord> = {}): Harness {
  const revisions: MessageRevision[] = [];
  const outbox: OutboxRow[] = [];
  const previewRefreshes: UUID[] = [];
  const state = {
    message: {
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      seq: 1,
      visibility: 'INTERNAL' as const,
      senderPrincipalId: AUTHOR,
      senderKind: 'EMPLOYEE' as const,
      senderDisplayName: 'Author',
      body: 'the original text',
      createdAt: '2026-09-01T09:00:00.000Z' as Timestamp,
      ...over,
    } as MessageRecord | undefined,
  };

  const store = {
    transaction: async <T,>(work: (tx: never) => Promise<T>): Promise<T> =>
      work({
        loadMessageForRevision: async (conversationId: UUID) =>
          conversationId === CONVERSATION ? state.message : undefined,
        insertRevision: async (revision: MessageRevision) => {
          revisions.push(revision);
        },
        applyCorrection: async (_id: UUID, body: string, at: Timestamp) => {
          state.message = { ...state.message!, body, editedAt: at };
          return state.message;
        },
        applyRedaction: async (_id: UUID, at: Timestamp) => {
          state.message = { ...state.message!, body: '', redactedAt: at };
          return state.message;
        },
        refreshPreview: async () => {
          previewRefreshes.push(CONVERSATION);
        },
        appendOutbox: async (row: OutboxRow) => {
          outbox.push(row);
        },
      } as never),
  } as MessageStore;

  return { store, revisions, outbox, previewRefreshes, state };
}

const deps = () => ({
  now: () => new Date('2026-09-01T10:00:00.000Z'),
  newId: () => 'revision-1' as UUID,
});

describe('editMessage', () => {
  it('replaces the body and keeps the previous one', async () => {
    const h = harness();
    const result = await editMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, body: 'the corrected text', correlationId: 'c' },
      { store: h.store, ...deps() },
    );

    expect(result.ok).toBe(true);
    expect(h.state.message?.body).toBe('the corrected text');
    // The history is the point: a correction that discarded what was there would make the
    // record unarguable-from.
    expect(h.revisions).toEqual([
      {
        revisionId: 'revision-1',
        messageId: MESSAGE,
        kind: 'CORRECTION',
        previousBody: 'the original text',
        actorId: AUTHOR,
      },
    ]);
    expect(h.state.message?.editedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('refuses somebody editing a message that is not theirs', async () => {
    // Editing another person's words is impersonation. There is no role that makes it
    // acceptable, so this is checked against the sender rather than against a permission.
    const h = harness();
    const result = await editMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: SOMEBODY_ELSE, body: 'not mine', correlationId: 'c' },
      { store: h.store, ...deps() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_THE_SENDER');
    expect(h.state.message?.body, 'a refused edit changed the message').toBe('the original text');
    expect(h.revisions).toEqual([]);
  });

  it('refuses to edit a deleted message', async () => {
    // Re-populating the body would resurrect something somebody deliberately removed.
    const h = harness({ redactedAt: '2026-09-01T09:30:00.000Z' as Timestamp, body: '' });
    const result = await editMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, body: 'back again', correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ALREADY_REDACTED');
  });

  it('writes nothing when the text has not changed', async () => {
    /**
     * Opening the editor and pressing save must not stamp `edited_at`. Otherwise a message
     * is marked corrected when it was only looked at, and the history fills with revisions
     * whose previous body equals their new one.
     */
    const h = harness();
    const result = await editMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, body: '  the original text  ', correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNCHANGED');
    expect(h.revisions).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it('refuses an empty or over-long body without touching the store', async () => {
    const h = harness();
    for (const body of ['', '   ', 'x'.repeat(10_001)]) {
      const result = await editMessage(
        { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, body, correlationId: 'c' },
        { store: h.store, ...deps() },
      );
      expect(result.ok).toBe(false);
    }
    expect(h.revisions).toEqual([]);
  });

  it('emits an event carrying no message body', async () => {
    // §20.4 keeps content off the wire, and a correction is still content.
    const h = harness();
    await editMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, body: 'new words entirely', correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.eventName).toBe('message.revised.v1');
    expect(JSON.stringify(h.outbox[0]?.payload)).not.toContain('new words');
  });
});

describe('redactMessage', () => {
  it('blanks the body, keeps the row, and records what was there', async () => {
    const h = harness();
    const result = await redactMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, correlationId: 'c' },
      { store: h.store, ...deps() },
    );

    expect(result.ok).toBe(true);
    /**
     * The ROW survives. Deleting it would leave a gap in the per-conversation sequence —
     * which the client's gap detector reads as a missed message and re-fetches forever —
     * and would break any reply pointing at it.
     */
    expect(h.state.message).toBeDefined();
    expect(h.state.message?.body).toBe('');
    expect(h.state.message?.redactedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(h.revisions[0]?.kind).toBe('REDACTION');
    expect(h.revisions[0]?.previousBody).toBe('the original text');
    /**
     * The sidebar preview holds a copy of the newest message's text. Without this the
     * deleted words stay visible on every conversation list showing the thread — which
     * defeats the deletion in the place a colleague is most likely to see it.
     */
    expect(h.previewRefreshes, 'the conversation preview kept the deleted text').toEqual([
      CONVERSATION,
    ]);
  });

  it('refuses somebody deleting a message that is not theirs', async () => {
    /**
     * Deleting another person's message is moderation — a policy about who may remove
     * whose words, which nobody has decided. Not invented here.
     */
    const h = harness();
    const result = await redactMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: SOMEBODY_ELSE, correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_THE_SENDER');
    expect(h.state.message?.body).toBe('the original text');
  });

  it('is idempotent, and does not write a second revision', async () => {
    // A double click, or a retry over a slow network. Succeeding twice is right; recording
    // a redaction whose "previous body" is already empty is not.
    const h = harness({ redactedAt: '2026-09-01T09:30:00.000Z' as Timestamp, body: '' });
    const result = await redactMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(result.ok).toBe(true);
    expect(h.revisions).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it('refuses a message in another conversation', async () => {
    // Scoped by conversation, so authorizing against one thread cannot reach a message in
    // another.
    const h = harness();
    const result = await redactMessage(
      { conversationId: '018f2c5a-7000-7000-8000-0000000000c2' as UUID, messageId: MESSAGE, actorId: AUTHOR, correlationId: 'c' },
      { store: h.store, ...deps() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MESSAGE_NOT_FOUND');
  });

  it('locks the row it is about to revise', async () => {
    /**
     * Without `FOR UPDATE` two concurrent edits each record the other's text as the
     * previous one, leaving a history describing a sequence that never happened. The port
     * name carries the requirement; this asserts the operation actually calls it.
     */
    const load = vi.fn(async () => harness().state.message);
    const store = {
      transaction: async <T,>(work: (tx: never) => Promise<T>): Promise<T> =>
        work({
          loadMessageForRevision: load,
          insertRevision: async () => undefined,
          applyRedaction: async () => harness().state.message!,
          refreshPreview: async () => undefined,
          appendOutbox: async () => undefined,
        } as never),
    } as MessageStore;

    await redactMessage(
      { conversationId: CONVERSATION, messageId: MESSAGE, actorId: AUTHOR, correlationId: 'c' },
      { store, ...deps() },
    );
    expect(load).toHaveBeenCalledOnce();
  });
});
