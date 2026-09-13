import { describe, expect, it } from 'vitest';
import type { UUID } from '@starlink/shared-contracts';

import { leaveConversation } from './conversations.js';
import type { ConversationStore, NewParticipant } from './ports.js';

/**
 * Leaving a group.
 *
 * The cases that matter are the ones about what leaving must NOT become: a way to remove
 * somebody else, a way out of a conversation somebody is accountable for, or a way to
 * strand a group with no administrator.
 */

const ALICE = '018f2c5a-7777-7000-8000-00000000000a' as UUID;
const BOB = '018f2c5a-7777-7000-8000-00000000000b' as UUID;
const CAROL = '018f2c5a-7777-7000-8000-00000000000c' as UUID;
const GROUP = '018f2c5a-7777-7000-8000-0000000000c0' as UUID;

interface Recorded {
  readonly ended: { principalId: UUID }[];
  readonly roles: { principalId: UUID; role: string }[];
}

const build = (
  options: {
    type?: string;
    participants?: readonly { id: UUID; role: string }[];
    endSucceeds?: boolean;
  } = {},
): { store: ConversationStore; recorded: Recorded } => {
  const recorded: Recorded = { ended: [], roles: [] };
  const people = options.participants ?? [
    { id: ALICE, role: 'CREATOR' },
    { id: BOB, role: 'PARTICIPANT' },
  ];

  const store = {
    transaction: async (work: (tx: unknown) => unknown) =>
      work({
        loadConversationType: async () => options.type ?? 'INTERNAL_GROUP',
        listParticipants: async (): Promise<readonly NewParticipant[]> =>
          people.map((p) => ({
            principalId: p.id,
            principalKind: 'EMPLOYEE' as const,
            role: p.role,
            replyAuthority: false,
          })),
        endParticipation: async (_c: UUID, principalId: UUID) => {
          if (options.endSucceeds === false) return false;
          recorded.ended.push({ principalId });
          return true;
        },
        setParticipantRole: async (_c: UUID, principalId: UUID, role: string) => {
          recorded.roles.push({ principalId, role });
        },
      }),
  } as unknown as ConversationStore;

  return { store, recorded };
};

const deps = (store: ConversationStore) => ({
  store,
  now: () => new Date('2026-09-09T12:00:00.000Z'),
  newId: () => '018f2c5a-7777-7000-8000-0000000000ff',
});

const leave = (principalId: UUID, store: ConversationStore) =>
  leaveConversation({ conversationId: GROUP, principalId, correlationId: 'c-1' }, deps(store) as never);

describe('leaving a group', () => {
  it('ends the leaver own participation and nobody else', async () => {
    const { store, recorded } = build();
    const result = await leave(BOB, store);
    expect(result.ok).toBe(true);
    expect(recorded.ended).toEqual([{ principalId: BOB }]);
  });

  it('refuses somebody who is not in it', async () => {
    /* Otherwise this is an enumeration oracle: a 204 for a conversation you are in and a
       refusal for one you are not tells you which is which. */
    const { store, recorded } = build();
    const result = await leave(CAROL, store);
    expect(result).toEqual({ ok: false, reason: 'NOT_A_PARTICIPANT' });
    expect(recorded.ended).toEqual([]);
  });

  it('reports NOT_A_PARTICIPANT when the row was already dated out', async () => {
    /* Two tabs, leave pressed in both. The second finds a live row in the list it read and
       nothing to end by the time it writes. */
    const { store } = build({ endSucceeds: false });
    expect(await leave(BOB, store)).toEqual({ ok: false, reason: 'NOT_A_PARTICIPANT' });
  });
});

describe('what leaving is not a way to do', () => {
  it('refuses a one-to-one', async () => {
    /* Leaving one leaves the other person talking into a thread that can never be
       answered. What somebody wants there is to stop seeing it, which is archive. */
    const { store, recorded } = build({ type: 'INTERNAL_DIRECT' });
    expect(await leave(BOB, store)).toEqual({ ok: false, reason: 'NOT_AN_INTERNAL_GROUP' });
    expect(recorded.ended).toEqual([]);
  });

  it.each(['CUSTOMER_CASE', 'INTERNAL_ANNOUNCEMENT', 'CUSTOMER_ENQUIRY'])(
    'refuses a %s',
    async (type) => {
      /* A customer conversation runs on ownership and the way out of one is a transfer,
         which exists and makes somebody else accountable. An announcement's participants
         are the whole company. Neither is a room you walk out of. */
      const { store, recorded } = build({ type });
      expect((await leave(BOB, store)).ok).toBe(false);
      expect(recorded.ended).toEqual([]);
    },
  );
});

describe('the creator leaving', () => {
  it('passes CREATOR to the longest-standing remaining member', async () => {
    /*
       CREATOR is the only role permitted to remove somebody from a group. A creator who
       walks out otherwise takes the group's only administrator with them and leaves the
       rest with a thread nobody can ever manage — the group's version of the orphaned
       owner rule 7 forbids.
    */
    const { store, recorded } = build({
      participants: [
        { id: ALICE, role: 'CREATOR' },
        { id: BOB, role: 'PARTICIPANT' },
        { id: CAROL, role: 'PARTICIPANT' },
      ],
    });
    const result = await leave(ALICE, store);
    expect(result).toEqual({ ok: true, creatorPassedTo: BOB });
    expect(recorded.roles).toEqual([{ principalId: BOB, role: 'CREATOR' }]);
  });

  it('never passes the role back to the person leaving', async () => {
    /* The successor is chosen from the list with the leaver excluded, not by taking the
       first row — which is the leaver whenever they were added first, and they are, being
       the creator. */
    const { store, recorded } = build({
      participants: [
        { id: ALICE, role: 'CREATOR' },
        { id: BOB, role: 'PARTICIPANT' },
      ],
    });
    await leave(ALICE, store);
    expect(recorded.roles.map((r) => r.principalId)).not.toContain(ALICE);
  });

  it('hands over nothing when an ordinary member leaves', async () => {
    /* The group already has an administrator. Reassigning on every departure would move
       the role to somebody who did not ask for it, for no reason. */
    const { store, recorded } = build();
    await leave(BOB, store);
    expect(recorded.roles).toEqual([]);
  });

  it('lets the last person leave, and hands the role to nobody', async () => {
    /* An empty room is not an orphan. Nobody is accountable for an internal group, and the
       history stays answerable because participation is dated rather than deleted. */
    const { store, recorded } = build({ participants: [{ id: ALICE, role: 'CREATOR' }] });
    expect(await leave(ALICE, store)).toEqual({ ok: true });
    expect(recorded.ended).toEqual([{ principalId: ALICE }]);
    expect(recorded.roles).toEqual([]);
  });
});
