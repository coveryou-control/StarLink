/**
 * Conversation and participation rules.
 *
 * These are business rules that must survive interpretation, so they are tested as
 * rules — against an in-memory store — rather than inferred from SQL behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationType, PrincipalKind, UUID } from '@starlink/shared-contracts';
import {
  addParticipant,
  createInternalConversation,
  removeParticipant,
  renameConversation,
  MAX_TITLE_LENGTH,
} from './conversations.js';
import type { ConversationStore, ConversationWriteTransaction, NewParticipant, OutboxRow } from './ports.js';

const ALICE = '018f2c5a-8888-7000-8000-00000000000a';
const BOB = '018f2c5a-8888-7000-8000-00000000000b';
const CARA = '018f2c5a-8888-7000-8000-00000000000c';
const CUSTOMER = '018f2c5a-8888-7000-8000-00000000000f';

interface Conv {
  id: UUID;
  type: ConversationType;
  title?: string | undefined;
  participants: NewParticipant[];
  ended: Set<UUID>;
  messageCount: number;
}

function createStore(seed: Conv[] = []) {
  const conversations = new Map<UUID, Conv>(seed.map((c) => [c.id, c]));
  const outbox: OutboxRow[] = [];
  /** Every `effective_from` the domain handed the store, for the clock-source test. */
  const stampedAt: string[] = [];
  /** What the thread was told about its own membership. */
  const systemMessages: { conversationId: UUID; body: string }[] = [];

  const store: ConversationStore = {
    async transaction(work) {
      const tx: ConversationWriteTransaction = {
        /**
         * The membership note, recorded so a test can assert what the thread was told.
         *
         * It counts as a message, because it is one: `countMessages` is what BR-07 reports
         * as "history exposed", and a note that did not count would make the next add
         * under-report by one for every add before it.
         */
        async appendSystemMessage(conversationId, body) {
          const found = conversations.get(conversationId);
          if (found === undefined) return;
          found.messageCount += 1;
          systemMessages.push({ conversationId, body });
        },
        async setTitle(conversationId, title) {
          const found = conversations.get(conversationId);
          if (found === undefined) return false;
          found.title = title;
          return true;
        },
        async promoteDirectToGroup(conversationId) {
          const found = conversations.get(conversationId);
          // Mirrors the statement's own WHERE clause: a promotion that fired on anything
          // but a direct conversation would let this fake pass a domain that should fail.
          if (found !== undefined && found.type === 'INTERNAL_DIRECT') found.type = 'INTERNAL_GROUP';
        },
        async findDirectConversation(a, b) {
          for (const c of conversations.values()) {
            if (c.type !== 'INTERNAL_DIRECT') continue;
            const ids = c.participants.map((p) => p.principalId).sort();
            if (ids.length === 2 && ids[0] === [a, b].sort()[0] && ids[1] === [a, b].sort()[1]) return c.id;
          }
          return undefined;
        },
        async insertConversation(conversation) {
          stampedAt.push(conversation.createdAt);
          conversations.set(conversation.conversationId, {
            id: conversation.conversationId,
            type: conversation.conversationType,
            participants: [...conversation.participants],
            ended: new Set(),
            messageCount: 0,
          });
        },
        async listParticipants(conversationId) {
          const c = conversations.get(conversationId);
          return c === undefined ? [] : c.participants.filter((p) => !c.ended.has(p.principalId));
        },
        async addParticipant(conversationId, participant, _addedBy, at) {
          stampedAt.push(at);
          conversations.get(conversationId)?.participants.push(participant);
        },
        async endParticipation(conversationId, principalId) {
          const c = conversations.get(conversationId);
          if (c === undefined) return false;
          if (!c.participants.some((p) => p.principalId === principalId) || c.ended.has(principalId)) {
            return false;
          }
          c.ended.add(principalId);
          return true;
        },
        async loadConversationType(conversationId) {
          return conversations.get(conversationId)?.type;
        },
        async countMessages(conversationId) {
          return conversations.get(conversationId)?.messageCount ?? 0;
        },
        async appendOutbox(row) {
          outbox.push(row);
        },
      };
      return work(tx);
    },
  };

  return { store, conversations, outbox, stampedAt, systemMessages };
}

const deps = (store: ConversationStore) => {
  let n = 0;
  return {
    store,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    newId: () => `018f2c5a-9999-7000-8000-${String(++n).padStart(12, '0')}` as UUID,
  };
};

const kinds = (over: Record<UUID, PrincipalKind> = {}): Record<UUID, PrincipalKind> => ({
  [ALICE]: 'EMPLOYEE',
  [BOB]: 'EMPLOYEE',
  [CARA]: 'EMPLOYEE',
  [CUSTOMER]: 'CUSTOMER',
  ...over,
});

describe('creating internal conversations', () => {
  it('creates a direct conversation with both participants', async () => {
    const { store, conversations } = createStore();
    const result = await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: ALICE, participantIds: [BOB], participantKinds: kinds(), correlationId: 'c' },
      deps(store),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(conversations.get(result.conversationId)?.participants).toHaveLength(2);
  });

  it('returns the SAME thread when a direct conversation is opened twice', async () => {
    // "Open a DM with X" is a navigation action performed many times; two histories
    // would mean each colleague sees half the conversation.
    const { store } = createStore();
    const d = deps(store);
    const first = await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: ALICE, participantIds: [BOB], participantKinds: kinds(), correlationId: 'c' },
      d,
    );
    const second = await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: BOB, participantIds: [ALICE], participantKinds: kinds(), correlationId: 'c' },
      d,
    );
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.existing).toBe(true);
    }
  });

  it('refuses a customer in an internal conversation, by any path (BR-08)', async () => {
    const { store, conversations } = createStore();
    const result = await createInternalConversation(
      {
        type: 'INTERNAL_GROUP',
        createdBy: ALICE,
        participantIds: [BOB, CUSTOMER],
        participantKinds: kinds(),
        title: 'Case discussion',
        correlationId: 'c',
      },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CUSTOMER_IN_INTERNAL_CONVERSATION');
    expect(conversations.size).toBe(0);
  });

  it('requires exactly one other person for a direct conversation', async () => {
    const { store } = createStore();
    const result = await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: ALICE, participantIds: [BOB, CARA], participantKinds: kinds(), correlationId: 'c' },
      deps(store),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a conversation with only yourself', async () => {
    const { store } = createStore();
    const result = await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: ALICE, participantIds: [ALICE], participantKinds: kinds(), correlationId: 'c' },
      deps(store),
    );
    expect(result.ok).toBe(false);
  });

  it('requires a title for a group', async () => {
    const { store } = createStore();
    const result = await createInternalConversation(
      { type: 'INTERNAL_GROUP', createdBy: ALICE, participantIds: [BOB], participantKinds: kinds(), correlationId: 'c' },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TITLE_REQUIRED_FOR_GROUP');
  });

  it('emits a creation event with no message content', async () => {
    const { store, outbox } = createStore();
    await createInternalConversation(
      { type: 'INTERNAL_DIRECT', createdBy: ALICE, participantIds: [BOB], participantKinds: kinds(), correlationId: 'c' },
      deps(store),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventName).toBe('conversation.created.v1');
  });
});

describe('adding a participant (BR-07)', () => {
  const seeded = (): Conv => ({
    id: 'conv-1' as UUID,
    type: 'INTERNAL_GROUP',
    participants: [
      { principalId: ALICE, principalKind: 'EMPLOYEE', role: 'CREATOR', replyAuthority: false },
    ],
    ended: new Set(),
    messageCount: 42,
  });

  it('REFUSES unless history exposure was acknowledged', async () => {
    // The interface must say so before the action. A server that proceeds anyway
    // makes the warning optional, which is the same as not having it.
    const { store } = createStore([seeded()]);
    const result = await addParticipant(
      {
        conversationId: 'conv-1' as UUID,
        principalId: BOB,
        principalKind: 'EMPLOYEE',
        addedBy: ALICE,
        historyExposureAcknowledged: false,
        correlationId: 'c',
      },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('HISTORY_EXPOSURE_NOT_ACKNOWLEDGED');
  });

  it('reports how much history is exposed when it succeeds', async () => {
    const { store } = createStore([seeded()]);
    const result = await addParticipant(
      {
        conversationId: 'conv-1' as UUID,
        principalId: BOB,
        principalKind: 'EMPLOYEE',
        addedBy: ALICE,
        historyExposureAcknowledged: true,
        correlationId: 'c',
      },
      deps(store),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messagesExposed).toBe(42);
  });

  it('refuses a customer added to an internal thread', async () => {
    const { store } = createStore([seeded()]);
    const result = await addParticipant(
      {
        conversationId: 'conv-1' as UUID,
        principalId: CUSTOMER,
        principalKind: 'CUSTOMER',
        addedBy: ALICE,
        historyExposureAcknowledged: true,
        correlationId: 'c',
      },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CUSTOMER_IN_INTERNAL_CONVERSATION');
  });

  it('refuses someone outside the conversation adding people to it (BR-05)', async () => {
    const { store } = createStore([seeded()]);
    const result = await addParticipant(
      {
        conversationId: 'conv-1' as UUID,
        principalId: CARA,
        principalKind: 'EMPLOYEE',
        addedBy: BOB,
        historyExposureAcknowledged: true,
        correlationId: 'c',
      },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ADDER_NOT_PARTICIPANT');
  });
});

describe('removing a participant (BR-09)', () => {
  const seeded = (): Conv => ({
    id: 'conv-1' as UUID,
    type: 'INTERNAL_GROUP',
    participants: [
      { principalId: ALICE, principalKind: 'EMPLOYEE', role: 'CREATOR', replyAuthority: false },
      { principalId: BOB, principalKind: 'EMPLOYEE', role: 'PARTICIPANT', replyAuthority: false },
    ],
    ended: new Set(),
    messageCount: 3,
  });

  it('ends future access without deleting the participation record', async () => {
    // Who COULD have read what must stay answerable after the fact (§24.3).
    const { store, conversations } = createStore([seeded()]);
    const result = await removeParticipant(
      { conversationId: 'conv-1' as UUID, principalId: BOB, removedBy: ALICE, correlationId: 'c' },
      deps(store),
    );
    expect(result.ok).toBe(true);
    const conv = conversations.get('conv-1' as UUID)!;
    expect(conv.participants.some((p) => p.principalId === BOB)).toBe(true);
    expect(conv.ended.has(BOB)).toBe(true);
  });

  it('is not repeatable against someone already removed', async () => {
    const { store } = createStore([seeded()]);
    const d = deps(store);
    await removeParticipant({ conversationId: 'conv-1' as UUID, principalId: BOB, removedBy: ALICE, correlationId: 'c' }, d);
    const again = await removeParticipant(
      { conversationId: 'conv-1' as UUID, principalId: BOB, removedBy: ALICE, correlationId: 'c' },
      d,
    );
    expect(again.ok).toBe(false);
  });
});

/**
 * Regression: participation periods must be stamped from ONE clock.
 *
 * Found when a durability test failed with an inexplicable 404. The dev machine's clock
 * was ~57 seconds behind the database's; participation START was stamped by the database
 * (`DEFAULT now()`), participation END by the application (`endParticipation(..., at)`),
 * and `decide()` evaluated the period against the application clock. So a freshly added
 * participant — including the person who had just created the conversation — was refused
 * their own thread until the skew elapsed, then silently started working.
 *
 * Well-synchronised servers hide this: the window shrinks to milliseconds, which is
 * still nonzero and still lands on whoever sends a message immediately after being
 * added. The fix is not tighter NTP, it is not asking two clocks the same question.
 */
describe('participation periods are stamped from the application clock', () => {
  const APP_NOW = '2026-08-25T12:00:00.000Z';

  const existingGroup = (): Conv => ({
    id: 'conv-clock' as UUID,
    type: 'INTERNAL_GROUP',
    participants: [
      { principalId: ALICE as UUID, principalKind: 'EMPLOYEE', role: 'CREATOR', replyAuthority: false },
    ],
    ended: new Set<UUID>(),
    messageCount: 3,
  });

  it('stamps conversation creation from deps.now(), not the database default', async () => {
    const { store, stampedAt } = createStore();

    await createInternalConversation(
      {
        type: 'INTERNAL_GROUP',
        createdBy: ALICE,
        participantIds: [BOB],
        participantKinds: kinds(),
        title: 'Clock check',
        correlationId: 'c',
      },
      deps(store),
    );

    expect(stampedAt).toEqual([APP_NOW]);
  });

  it('stamps a later participant addition from deps.now() too', async () => {
    const { store, stampedAt } = createStore([existingGroup()]);

    const result = await addParticipant(
      {
        conversationId: 'conv-clock' as UUID,
        principalId: CARA,
        principalKind: 'EMPLOYEE',
        addedBy: ALICE,
        historyExposureAcknowledged: true,
        correlationId: 'c',
      },
      deps(store),
    );

    expect(result.ok).toBe(true);
    expect(stampedAt).toEqual([APP_NOW]);
  });

  it('never leaves the store to default the timestamp', async () => {
    // The actual defect was an ABSENT value, so asserting "present and non-empty" is
    // the assertion that would have caught it.
    const { store, stampedAt } = createStore();

    await createInternalConversation(
      {
        type: 'INTERNAL_DIRECT',
        createdBy: ALICE,
        participantIds: [BOB],
        participantKinds: kinds(),
        correlationId: 'c',
      },
      deps(store),
    );

    expect(stampedAt.length).toBeGreaterThan(0);
    expect(stampedAt.every((at) => typeof at === 'string' && at.length > 0)).toBe(true);
  });
});

/**
 * Renaming a group.
 *
 * The rules that are NOT about validation are the interesting ones: which conversations
 * may be renamed at all, and by whom. Both are refused in the domain rather than in the
 * controller, because the controller is one caller.
 */
describe('renameConversation', () => {
  const GROUP = '018f2c5a-9999-7000-8000-0000000000g1'.replace('g', 'a') as UUID;

  const store = (over: {
    type?: string;
    participants?: readonly string[];
    updated?: boolean;
  } = {}): { store: ConversationStore; titles: string[] } => {
    const titles: string[] = [];
    return {
      titles,
      store: {
        transaction: async (work) =>
          work({
            findDirectConversation: async () => undefined,
            insertConversation: async () => undefined,
            listParticipants: async () =>
              (over.participants ?? [ALICE]).map((principalId) => ({
                principalId: principalId as UUID,
                principalKind: 'EMPLOYEE' as const,
                role: 'PARTICIPANT',
                replyAuthority: false,
              })),
            addParticipant: async () => undefined,
            endParticipation: async () => true,
            countMessages: async () => 0,
            loadConversationType: async () => (over.type ?? 'INTERNAL_GROUP') as never,
            setTitle: async (_id: UUID, title: string | undefined) => {
              if (over.updated === false) return false;
              titles.push(title ?? '');
              return true;
            },
          } as never),
      } as ConversationStore,
    };
  };

  const rename = (title: string, by: string, over = {}) => {
    const built = store(over);
    return renameConversation(
      { conversationId: GROUP, title, renamedBy: by as UUID, correlationId: 'c-1' },
      { store: built.store, now: () => new Date('2026-09-01T10:00:00Z'), newId: () => 'x' as UUID },
    ).then((result) => ({ result, titles: built.titles }));
  };

  it('renames a group a participant is in', async () => {
    const { result, titles } = await rename('  Q3 renewals  ', ALICE);
    expect(result.ok).toBe(true);
    // Trimmed on the way in: a title of spaces renders as a blank row nobody can click.
    expect(titles).toEqual(['Q3 renewals']);
  });

  it('refuses somebody who is not in the conversation', async () => {
    const { result } = await rename('Anything', CARA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_A_PARTICIPANT');
  });

  it('refuses a one-to-one', async () => {
    /**
     * A direct message is named after the person you are talking to. A title would
     * override that with something only one of the two chose, and the other would see
     * their colleague's conversation renamed under them.
     */
    const { result } = await rename('My private label', ALICE, { type: 'INTERNAL_DIRECT' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AN_INTERNAL_GROUP');
  });

  it('refuses a customer conversation', async () => {
    // §21.7 names those by case and customer; a staff-chosen label on a record the
    // customer is party to is not a rename, it is a relabelling of their history.
    const { result } = await rename('Anything', ALICE, { type: 'CUSTOMER_SERVICE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AN_INTERNAL_GROUP');
  });

  it('refuses an empty or over-long title without touching the store', async () => {
    for (const bad of ['', '   ', 'x'.repeat(MAX_TITLE_LENGTH + 1)]) {
      const { result, titles } = await rename(bad, ALICE);
      expect(result.ok, JSON.stringify(bad.slice(0, 12))).toBe(false);
      if (!result.ok) expect(result.reason).toBe('TITLE_INVALID');
      expect(titles).toEqual([]);
    }
  });

  it('reports a conversation that vanished under it', async () => {
    const { result } = await rename('Anything', ALICE, { updated: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CONVERSATION_NOT_FOUND');
  });
});


/**
 * A one-to-one that acquires a third person becomes a group.
 *
 * Not cosmetic. `renameConversation` refuses anything that is not an `INTERNAL_GROUP`, so
 * before this a thread could have three members, be named after all three, and still have
 * no way to be given a name of its own — ever.
 */
describe('addParticipant — promotion', () => {
  const CONVERSATION = '018f2c5a-9999-7000-8000-0000000000d1'.replace('d', 'a') as UUID;

  const harness = (type: string, existing: readonly string[]) => {
    const promoted: UUID[] = [];
    const added: string[] = [];
    const store = {
      transaction: async (work: (tx: never) => unknown) =>
        work({
          findDirectConversation: async () => undefined,
          insertConversation: async () => undefined,
          listParticipants: async () =>
            existing.map((principalId) => ({
              principalId: principalId as UUID,
              principalKind: 'EMPLOYEE' as const,
              role: 'PARTICIPANT',
              replyAuthority: false,
            })),
          addParticipant: async (_id: UUID, participant: { principalId: string }) => {
            added.push(participant.principalId);
          },
          endParticipation: async () => true,
          countMessages: async () => 3,
          loadConversationType: async () => type as never,
          setTitle: async () => true,
          promoteDirectToGroup: async (id: UUID) => {
            promoted.push(id);
          },
        } as never),
    } as ConversationStore;
    return { store, promoted, added };
  };

  const add = (type: string, existing: readonly string[], who: string) => {
    const built = harness(type, existing);
    return addParticipant(
      {
        conversationId: CONVERSATION,
        principalId: who as UUID,
        principalKind: 'EMPLOYEE',
        addedBy: ALICE,
        historyExposureAcknowledged: true,
        correlationId: 'c-1',
      },
      { store: built.store, now: () => new Date('2026-09-01T10:00:00Z'), newId: () => 'x' as UUID },
    ).then((result) => ({ result, ...built }));
  };

  it('promotes a direct conversation the moment it has a third member', async () => {
    const { result, promoted, added } = await add('INTERNAL_DIRECT', [ALICE, BOB], CARA);
    expect(result.ok).toBe(true);
    expect(added).toEqual([CARA]);
    expect(promoted, 'a three-person thread stayed a one-to-one').toEqual([CONVERSATION]);
  });

  it('leaves a group alone', async () => {
    // Idempotence at the domain level as well as in the statement: promoting something
    // already promoted would be a write per participant added, for ever.
    const { promoted } = await add('INTERNAL_GROUP', [ALICE, BOB], CARA);
    expect(promoted).toEqual([]);
  });

  it('does not promote on a refused add', async () => {
    /**
     * The acknowledgement gate is BR-07's, and it must fail closed all the way: a refused
     * add that still changed the conversation's kind would be the server half-performing an
     * operation it declined.
     */
    const built = harness('INTERNAL_DIRECT', [ALICE, BOB]);
    const result = await addParticipant(
      {
        conversationId: CONVERSATION,
        principalId: CARA,
        principalKind: 'EMPLOYEE',
        addedBy: ALICE,
        historyExposureAcknowledged: false,
        correlationId: 'c-1',
      },
      { store: built.store, now: () => new Date('2026-09-01T10:00:00Z'), newId: () => 'x' as UUID },
    );
    expect(result.ok).toBe(false);
    expect(built.promoted).toEqual([]);
    expect(built.added).toEqual([]);
  });

  it('never promotes a customer conversation', async () => {
    // The kind guard is in the SQL as well, but a domain that would ask is a domain one
    // refactor away from a customer thread being retyped as an internal group.
    const { promoted } = await add('CUSTOMER', [ALICE, BOB], CARA);
    expect(promoted).toEqual([]);
  });
});
