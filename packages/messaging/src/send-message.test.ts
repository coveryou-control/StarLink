/**
 * Message write path invariants.
 *
 * An in-memory store stands in for PostgreSQL so these can assert ORDERING and
 * IDEMPOTENCY precisely — including that the outbox row is written inside the same
 * transaction, and that a rollback leaves neither the message nor the event. The same
 * guarantees are separately proven against real PostgreSQL by the Phase 1 spikes.
 */
import { describe, expect, it } from 'vitest';
import type { ActorContext } from '@starlink/conversation-domain';
import type { MessageVisibility, UUID } from '@starlink/shared-contracts';
import type {
  ConversationRecord,
  InsertMessage,
  MessageRecord,
  MessageStore,
  MessageWriteTransaction,
  OutboxRow,
  ParticipantRecord,
} from './ports.js';
import { sendMessage } from './send-message.js';

const CONVERSATION_ID = '018f2c5a-4444-7000-8000-000000000001';
const OWNER_ID = '018f2c5a-4444-7000-8000-0000000000aa';
const OUTSIDER_ID = '018f2c5a-4444-7000-8000-0000000000bb';
const _PAST = '2026-01-01T00:00:00.000Z';

interface StoreState {
  conversation: ConversationRecord | undefined;
  participants: Map<UUID, ParticipantRecord>;
  messages: MessageRecord[];
  outbox: OutboxRow[];
  previews: string[];
  /** Owner ids for which §21.4's `assigned → active` was attempted. */
  activations: string[];
  committed: boolean;
}

function createStore(over: Partial<ConversationRecord> = {}): { store: MessageStore; state: StoreState } {
  const state: StoreState = {
    conversation: {
      conversationId: CONVERSATION_ID,
      conversationType: 'CUSTOMER_SERVICE',
      sensitivity: 'ORDINARY',
      lastSeq: 0,
      currentOwnerId: OWNER_ID,
      customerRef: 'CCS:customer:c-1',
      owningTeamId: 'support',
      ...over,
    },
    participants: new Map(),
    messages: [],
    outbox: [],
    previews: [],
    activations: [],
    committed: false,
  };

  const store: MessageStore = {
    async transaction(work) {
      // Staged, then swapped in on success — so a throw leaves neither the message
      // nor its outbox row, exactly like a rollback.
      const stagedMessages: MessageRecord[] = [];
      const stagedOutbox: OutboxRow[] = [];
      const stagedPreviews: string[] = [];
      const stagedActivations: string[] = [];
      let seq = state.conversation?.lastSeq ?? 0;

      const tx: MessageWriteTransaction = {
        async loadConversationForUpdate() {
          return state.conversation;
        },
        async loadParticipant(_conversationId, principalId) {
          return state.participants.get(principalId);
        },
        /** Live participants, for mention validation and `@all` expansion. */
        async listParticipantIds() {
          return [...state.participants.keys()];
        },
        async findByClientMessageId(_c, senderPrincipalId, clientMessageId) {
          return state.messages.find(
            (m) => m.senderPrincipalId === senderPrincipalId && m.body !== '' && m.clientKey === clientMessageId,
          ) as MessageRecord | undefined;
        },
        async findMessageInConversation(_c, messageId) {
          return [...state.messages, ...stagedMessages].find((m) => m.messageId === messageId);
        },
        async nextSequence() {
          seq += 1;
          return seq;
        },
        async insertMessage(message: InsertMessage & { seq: number }) {
          const record = {
            messageId: message.messageId,
            conversationId: message.conversationId,
            seq: message.seq,
            visibility: message.visibility,
            senderPrincipalId: message.senderPrincipalId,
            senderKind: message.senderKind,
            senderDisplayName: message.senderDisplayName,
            body: message.body,
            replyToMessageId: message.replyToMessageId,
            createdAt: '2026-08-25T10:00:00.000Z',
            clientKey: message.clientMessageId,
            // Carried like the real store does, so a test can assert what was written.
            ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
            /* Threading, carried the same way — and `alsoSendToChannel` only alongside a
               parent, which is the pairing the real store enforces in SQL. */
            ...(message.threadParentId !== undefined
              ? {
                  threadParentId: message.threadParentId,
                  ...(message.alsoSendToChannel === true ? { alsoSendToChannel: true } : {}),
                }
              : {}),
          } as MessageRecord & { clientKey?: string };
          stagedMessages.push(record);
          return record;
        },
        async appendOutbox(row) {
          stagedOutbox.push(row);
        },
        async touchConversation(_c, _at, preview) {
          stagedPreviews.push(preview);
        },
        /**
         * §21.4's `assigned → active`, recorded so the tests can assert WHEN it fires.
         *
         * The double mirrors the real conditional — only from ASSIGNED — rather than
         * always returning true, because the interesting property is that the second
         * reply does NOT move anything.
         */
        async activateOnOwnerReply(input) {
          stagedActivations.push(input.ownerId);
          if (state.conversation?.state !== 'ASSIGNED') return false;
          state.conversation = { ...state.conversation, state: 'ACTIVE' };
          return true;
        },
      };

      const result = await work(tx);
      state.messages.push(...stagedMessages);
      state.outbox.push(...stagedOutbox);
      state.previews.push(...stagedPreviews);
      state.activations.push(...stagedActivations);
      state.committed = true;
      if (state.conversation !== undefined) {
        state.conversation = { ...state.conversation, lastSeq: seq };
      }
      return result;
    },
  };

  return { store, state };
}

/**
 * One counter for the whole file, not one per call.
 *
 * `deps()` is called fresh for every send, so a counter created inside it reset to zero
 * each time and EVERY message came out with the same id. Nothing noticed while no test
 * looked up a message by the id of another — the moment one did (threads: is this root
 * itself a reply?), the lookup found the first message ever written and answered about
 * that one instead.
 *
 * Still deterministic, which is the property the fixed ids were for.
 */
let nextId = 0;

const deps = (_state?: StoreState) => ({
  store: undefined as never,
  now: () => new Date('2026-08-25T10:00:00.000Z'),
  newId: () => `018f2c5a-5555-7000-8000-${String(++nextId).padStart(12, '0')}`,
});

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: OWNER_ID,
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: ['support'],
  departments: ['service'],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

const send = (
  store: MessageStore,
  over: Partial<Parameters<typeof sendMessage>[0]> = {},
) =>
  sendMessage(
    {
      conversationId: CONVERSATION_ID,
      actor: actor(),
      senderDisplayName: 'Owner Agent',
      body: 'hello there',
      visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
      correlationId: 'corr-1',
      ...over,
    },
    { store, now: deps().now, newId: deps().newId },
  );

describe('authorization is evaluated before anything is written', () => {
  it('refuses a non-participant with no scope, and writes nothing', async () => {
    const { store, state } = createStore();
    const result = await send(store, { actor: actor({ principalId: OUTSIDER_ID }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AUTHORIZED');
    expect(state.messages).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('lets the owner send to the customer', async () => {
    const { store, state } = createStore();
    const result = await send(store);
    expect(result.ok).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it('refuses a customer principal writing an internal note, before touching the store', async () => {
    const { store, state } = createStore();
    const result = await send(store, {
      actor: actor({ principalId: 'cust-1', kind: 'CUSTOMER', assurance: 'VERIFIED_CUSTOMER' }),
      visibility: 'INTERNAL',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CUSTOMER_CANNOT_SEND_INTERNAL');
    expect(state.committed).toBe(false);
  });
});

describe('persist-before-publish (P-05)', () => {
  it('writes the message and its outbox row in the same transaction', async () => {
    const { store, state } = createStore();
    await send(store);
    expect(state.messages).toHaveLength(1);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.eventName).toBe('message.created.v1');
  });

  it('puts no message body on the event', async () => {
    // Brief §45: IDs and classifications only — the event fabric has a wider
    // access list than the message store.
    const { store, state } = createStore();
    await send(store, { body: 'my policy number is ABCDE1234F' });
    const payload = state.outbox[0]?.payload ?? {};
    expect(JSON.stringify(payload)).not.toContain('ABCDE1234F');
    expect(Object.keys(payload)).toContain('messageId');
  });

  it('leaves neither the message nor the event when the transaction throws', async () => {
    const { store, state } = createStore();
    const exploding: MessageStore = {
      transaction: (work) =>
        store.transaction(async (tx) => {
          await work(tx);
          throw new Error('commit failed');
          return result;
        }),
    };
    await expect(send(exploding)).rejects.toThrow('commit failed');
    expect(state.messages).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });
});

describe('idempotency (brief §15, §34.7)', () => {
  it('returns the original message when the same key is retried', async () => {
    const { store, state } = createStore();
    const first = await send(store, { clientMessageId: 'client-key-1' });
    const retry = await send(store, { clientMessageId: 'client-key-1' });

    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.duplicate).toBe(true);
      expect(retry.message.messageId).toBe(first.message.messageId);
    }
    // The decisive assertion: a network retry must not duplicate a customer's message.
    expect(state.messages).toHaveLength(1);
    expect(state.outbox).toHaveLength(1);
  });

  it('treats a different key as a genuinely new message', async () => {
    const { store, state } = createStore();
    await send(store, { clientMessageId: 'k1' });
    await send(store, { clientMessageId: 'k2' });
    expect(state.messages).toHaveLength(2);
  });
});

describe('visibility and previews', () => {
  it('keeps internal-note text out of the conversation preview', async () => {
    // The preview is denormalised onto the conversation and is read on
    // customer-facing surfaces, so it must never carry staff text.
    const { store, state } = createStore();
    await send(store, { visibility: 'INTERNAL', body: 'customer sounds litigious' });
    expect(state.previews[0]).toBe('');
  });

  it('writes a preview for customer-visible messages', async () => {
    const { store, state } = createStore();
    await send(store, { body: 'we have received your documents' });
    expect(state.previews[0]).toContain('received your documents');
  });

  it('writes a preview for a message in an INTERNAL conversation', async () => {
    /**
     * Every message in a colleague thread is INTERNAL by construction, so a rule keyed on
     * message visibility alone suppressed all of them and an internal thread's preview
     * was permanently empty. There is no customer in an internal conversation and no
     * customer surface that renders it, so the rule 5 marker protects nothing here and
     * costs the sidebar its only line of content.
     */
    const { store, state } = createStore({ conversationType: 'INTERNAL_DIRECT' });
    await send(store, { visibility: 'INTERNAL', body: 'can you take the Nair renewal' });
    expect(state.previews[0]).toContain('take the Nair renewal');
  });

  it('still suppresses the preview for a note on a customer conversation of any kind', async () => {
    /**
     * The control for the case above. The relaxation must be keyed on the conversation
     * being internal, not on the message being a note — if it read the other way round,
     * every customer conversation in every list would carry staff text.
     */
    for (const conversationType of [
      'CUSTOMER_SERVICE',
      'CUSTOMER_CLAIM',
      'CUSTOMER_GRIEVANCE',
    ] as const) {
      const { store, state } = createStore({ conversationType });
      await send(store, { visibility: 'INTERNAL', body: 'customer sounds litigious' });
      expect(state.previews[0], `${conversationType} leaked a note into its preview`).toBe('');
    }
  });
});

describe('validation', () => {
  it('refuses an empty or whitespace-only body', async () => {
    const { store } = createStore();
    for (const body of ['', '   ', '\n\t']) {
      const result = await send(store, { body });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('EMPTY_BODY');
    }
  });

  it('bounds body length server-side', async () => {
    const { store } = createStore();
    const result = await sendMessage(
      {
        conversationId: CONVERSATION_ID,
        actor: actor(),
        senderDisplayName: 'Owner Agent',
        body: 'x'.repeat(50),
        visibility: 'CUSTOMER_VISIBLE',
        correlationId: 'c',
      },
      { store, now: deps().now, newId: deps().newId, maxBodyLength: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('BODY_TOO_LONG');
  });

  it('refuses a reply to a message in another conversation', async () => {
    const { store } = createStore();
    const result = await send(store, { replyToMessageId: '018f2c5a-9999-7000-8000-000000000001' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('REPLY_TARGET_NOT_IN_CONVERSATION');
  });

  it('refuses a customer-visible reply that quotes an internal note', async () => {
    const { store } = createStore();
    const note = await send(store, { visibility: 'INTERNAL', body: 'internal context' });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const result = await send(store, {
      visibility: 'CUSTOMER_VISIBLE',
      replyToMessageId: note.message.messageId,
    });
    expect(result.ok).toBe(false);
  });
});

/**
 * Threading, and the three ways it must refuse.
 *
 * A thread is CONTAINMENT — the reply leaves the channel's timeline and lives inside the
 * root's — so every one of these is a message ending up somewhere nobody expects it, which
 * is a worse failure than a refused send.
 */
describe('threads', () => {
  it('accepts a reply into a root in this conversation', async () => {
    const { store } = createStore();
    const root = await send(store, { body: 'the question' });
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    const reply = await send(store, {
      body: 'the answer',
      threadParentId: root.message.messageId,
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.message.threadParentId).toBe(root.message.messageId);
    /* Off unless asked for. A threaded reply is out of the channel by definition, and the
       flag is the exception somebody chooses one message at a time. */
    expect(reply.message.alsoSendToChannel ?? false).toBe(false);
  });

  it('carries "also send to channel" only when it is asked for', async () => {
    const { store } = createStore();
    const root = await send(store, { body: 'the question' });
    if (!root.ok) return;

    const reply = await send(store, {
      body: 'everyone should see this',
      threadParentId: root.message.messageId,
      alsoSendToChannel: true,
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.message.alsoSendToChannel).toBe(true);
  });

  it('refuses a root in another conversation', async () => {
    /**
     * The same rule a quote target obeys, and for a stronger reason: a threaded reply is
     * READ through its root, so a root in a thread the sender cannot see would put their
     * words under a message they were never shown.
     */
    const { store } = createStore();
    const result = await send(store, {
      threadParentId: '018f2c5a-9999-7000-8000-000000000002',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('THREAD_ROOT_INVALID');
  });

  it('refuses a thread on a threaded reply — one level, always', async () => {
    /**
     * A thread of threads is a tree, and a tree is not readable in a 320px column. Refused
     * in the domain rather than discouraged in the interface: the depth would otherwise be
     * whatever the last client to be written happened to allow.
     */
    const { store } = createStore();
    const root = await send(store, { body: 'the question' });
    if (!root.ok) return;
    const reply = await send(store, {
      body: 'the answer',
      threadParentId: root.message.messageId,
    });
    if (!reply.ok) return;

    const nested = await send(store, {
      body: 'a reply to the reply',
      threadParentId: reply.message.messageId,
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.reason).toBe('THREAD_ROOT_INVALID');
  });

  it('refuses a customer-visible reply inside an internal root', async () => {
    /**
     * Rule 5, applied to containment. A thread is read with its root above it, so a
     * customer-visible reply under an internal note would put staff-only text on the
     * customer's screen as the context for the reply they were sent.
     */
    const { store } = createStore();
    const note = await send(store, { visibility: 'INTERNAL', body: 'staff only' });
    if (!note.ok) return;

    const result = await send(store, {
      visibility: 'CUSTOMER_VISIBLE',
      threadParentId: note.message.messageId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('THREAD_ROOT_INVALID');
  });
});

describe('sequencing', () => {
  it('allocates a monotonic per-conversation sequence', async () => {
    const { store, state } = createStore();
    await send(store, { clientMessageId: 'a' });
    await send(store, { clientMessageId: 'b' });
    await send(store, { clientMessageId: 'c' });
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('freezes the sender display name onto the message', async () => {
    // A later rename must not rewrite history (doc §24.9).
    const { store, state } = createStore();
    await send(store, { senderDisplayName: 'Priya (Support)' });
    expect(state.messages[0]?.senderDisplayName).toBe('Priya (Support)');
  });
});

/**
 * PHASE 4 EXIT CRITERION: assurance-gating reaches the write path.
 *
 * `assurance-ladder.test.ts` proves the rule inside `decide()`. These prove the plumbing
 * carries it — a correct rule that the caller never passes is not enforcement.
 *
 * The important one is the default. When a Phase 10 route that reaches policy or claim
 * data calls `sendMessage` and its author does not think about assurance, the omission
 * must fail closed. If it defaulted open, every future customer write would be
 * unguarded until someone remembered, and the code would read fine in review.
 */
describe('customer assurance gating on the write path', () => {
  const customerActor = (assurance?: string) =>
    actor({
      principalId: 'cust-1',
      kind: 'CUSTOMER',
      teams: [],
      departments: [],
      ...(assurance !== undefined ? { assurance: assurance as never } : {}),
    });

  /** A customer conversation the actor genuinely participates in. */
  const asParticipant = () => {
    const built = createStore();
    built.state.participants.set('cust-1', {
      principalId: 'cust-1',
      principalKind: 'CUSTOMER',
      role: 'CUSTOMER',
      replyAuthority: true,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    return built;
  };

  it('refuses an ANONYMOUS customer when the caller declares no requirement', async () => {
    const { store, state } = asParticipant();

    const result = await send(store, {
      actor: customerActor('ANONYMOUS'),
      visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AUTHORIZED');
    // Nothing written. NOT `state.committed`: that flag means the transaction callback
    // returned without throwing, which an authorization refusal does — it returns a
    // result rather than raising. What matters is that no row exists.
    expect(state.messages).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  it('admits the same send once the caller declares ANONYMOUS deliberately', async () => {
    // §21.5: ordinary chat precedes identity. The customer surface states this
    // explicitly, which is visible in review in a way a default never is.
    const { store } = asParticipant();

    const result = await send(store, {
      actor: customerActor('ANONYMOUS'),
      visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
      requiredAssurance: 'ANONYMOUS',
    });

    expect(result.ok).toBe(true);
  });

  it('admits a VERIFIED_CUSTOMER under the strict default', async () => {
    const { store } = asParticipant();

    const result = await send(store, {
      actor: customerActor('VERIFIED_CUSTOMER'),
      visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
    });

    expect(result.ok).toBe(true);
  });

  it('still refuses a non-participant however high their assurance', async () => {
    // Assurance answers "who are you", participation answers "is this yours". The
    // second is not purchasable with the first.
    const { store, state } = createStore();

    const result = await send(store, {
      actor: customerActor('AUTHENTICATED_CUSTOMER'),
      visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
      requiredAssurance: 'ANONYMOUS',
    });

    expect(result.ok).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });
});

describe('§21.4 assigned → active — the arrival half of the lifecycle', () => {
  /**
   * This is the transition that was missing entirely. Nothing wrote QUEUED or ASSIGNED,
   * and nothing moved a conversation to ACTIVE on the way in — so a real conversation sat
   * at NEW from intake until somebody tried to resolve it, which §21.4 forbids
   * (`NEW → RESOLVED` is not a row). The resolve endpoint was therefore unreachable on
   * any conversation the product had actually created, and its own tests could not see
   * that because they seeded ACTIVE directly. Golden test G-15 found it by walking the
   * whole workflow.
   */
  it("fires on the owner's first customer-visible reply", async () => {
    const { store, state } = createStore({ state: 'ASSIGNED' });

    const result = await send(store);

    expect(result.ok).toBe(true);
    expect(state.activations).toEqual([OWNER_ID]);
    expect(state.conversation?.state).toBe('ACTIVE');
  });

  it('does not fire for an internal note — that is not a reply to anybody', async () => {
    // §21.4 says "the reply itself" makes a conversation active. A colleague adding
    // context has told the customer nothing, so the state must not claim otherwise.
    const { store, state } = createStore({ state: 'ASSIGNED' });

    await send(store, { visibility: 'INTERNAL' as MessageVisibility });

    expect(state.activations).toEqual([]);
    expect(state.conversation?.state).toBe('ASSIGNED');
  });

  it('is attempted once, and moves nothing on the second reply', async () => {
    // The store's conditional is what makes it idempotent; this pins that a second reply
    // is a normal no-op rather than an error or a duplicate episode.
    const { store, state } = createStore({ state: 'ASSIGNED' });

    await send(store);
    await send(store, { body: 'and one more thing' });

    expect(state.conversation?.state).toBe('ACTIVE');
    expect(state.messages).toHaveLength(2);
  });
});

/**
 * Mentions, at the send path.
 *
 * `validateMentions` is unit-tested on its own; these are about the WIRING — that the
 * validation runs against the conversation's live participants, that the recipients come
 * back for the caller to notify, and that a refusal stops the write rather than storing a
 * mention nobody checked.
 */
describe('mentions', () => {
  const COLLEAGUE_ID = '018f2c5a-4444-7000-8000-0000000000cc';
  const participant = (principalId: string, over: { replyAuthority?: boolean } = {}) => ({
    principalId,
    principalKind: 'EMPLOYEE' as const,
    role: 'PARTICIPANT',
    replyAuthority: over.replyAuthority ?? false,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  it('stores a valid mention and reports who to notify', async () => {
    const { store, state } = createStore({ conversationType: 'INTERNAL_GROUP' });
    state.participants.set(OWNER_ID, participant(OWNER_ID, { replyAuthority: true }));
    state.participants.set(COLLEAGUE_ID, participant(COLLEAGUE_ID));

    const result = await send(store, {
      body: '@Colleague please look',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'PRINCIPAL', principalId: COLLEAGUE_ID, offset: 0, length: 10 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mentioned).toEqual([COLLEAGUE_ID]);
    expect(state.messages[0]?.mentions).toHaveLength(1);
  });

  it('refuses a mention of somebody who is not in the conversation, writing nothing', async () => {
    /**
     * The refusal must happen BEFORE the insert. A stored mention of an outsider would be
     * a notification pointing at a thread `decide()` then refuses them — which tells them
     * a conversation exists and who is in it.
     */
    const { store, state } = createStore({ conversationType: 'INTERNAL_GROUP' });
    state.participants.set(OWNER_ID, participant(OWNER_ID, { replyAuthority: true }));

    const result = await send(store, {
      body: '@Outsider hello',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'PRINCIPAL', principalId: OUTSIDER_ID, offset: 0, length: 9 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MENTION_NOT_A_PARTICIPANT');
    expect(state.messages, 'a refused mention still wrote a message').toHaveLength(0);
  });

  it('expands @all to the other participants in a group', async () => {
    const { store, state } = createStore({ conversationType: 'INTERNAL_GROUP' });
    state.participants.set(OWNER_ID, participant(OWNER_ID, { replyAuthority: true }));
    state.participants.set(COLLEAGUE_ID, participant(COLLEAGUE_ID));

    const result = await send(store, {
      body: '@all standup at 10',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'ALL', offset: 0, length: 4 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The sender is never in the list: NEVER_NOTIFIED includes OWN_ACTION.
    expect(result.mentioned).toEqual([COLLEAGUE_ID]);
  });

  it('refuses @all outside an internal group', async () => {
    // On a one-to-one it means the one person already reading it; on a customer
    // conversation the participant set includes somebody outside the company.
    const { store } = createStore({ conversationType: 'CUSTOMER_SERVICE' });
    const result = await send(store, {
      body: '@all hello',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'ALL', offset: 0, length: 4 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MENTION_ALL_NOT_PERMITTED');
  });

  it('reports no recipients when a message mentions nobody', async () => {
    const { store } = createStore();
    const result = await send(store, { body: 'ordinary message' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mentioned).toBeUndefined();
  });
});
