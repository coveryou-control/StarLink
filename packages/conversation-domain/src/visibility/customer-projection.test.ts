/**
 * Customer isolation property tests (Phase 4 exit criterion).
 *
 * The interesting tests here are not "does the projection emit the subject". They are
 * the fuzzed ones: fill every internal field with a unique sentinel, project, and search
 * the ENTIRE serialised output for any sentinel that was not explicitly allowed. That
 * catches a leak introduced by a field added in a later phase, which is the failure this
 * whole module exists to prevent — nobody remembers to update a hand-written list of
 * forbidden fields six months later.
 */
import { describe, expect, it } from 'vitest';
import type { MessageVisibility, Timestamp, UUID } from '@starlink/shared-contracts';

import {
  toCustomerConversationView,
  toCustomerMessagePage,
  toCustomerMessageView,
  toCustomerState,
  type InternalConversationRecord,
  type InternalMessageRecord,
} from './customer-projection.js';

const CUSTOMER = '018f2c5a-2b2b-7000-8000-00000000000c' as UUID;
const AGENT = '018f2c5a-2b2b-7000-8000-00000000000a' as UUID;
const CONVERSATION = '018f2c5a-2b2b-7000-8000-0000000000d1' as UUID;

/** A conversation record with a unique, greppable sentinel in every internal field. */
function loadedConversation(): InternalConversationRecord {
  return {
    conversationId: CONVERSATION,
    conversationType: 'CUSTOMER_SERVICE',
    title: 'My renewal question',
    state: 'OPEN',
    lastActivityAt: '2026-08-25T10:00:00.000Z' as Timestamp,
    lastMessagePreview: 'SENTINEL_PREVIEW',
    caseId: 'SENTINEL_CASE_ID' as UUID,
    customerRef: 'SENTINEL_CUSTOMER_REF',
    currentOwnerId: 'SENTINEL_OWNER_ID' as UUID,
    currentOwnerName: 'SENTINEL_OWNER_NAME',
    owningTeamId: 'SENTINEL_TEAM',
    owningDepartment: 'SENTINEL_DEPARTMENT',
    sensitivity: 'SENTINEL_SENSITIVITY',
    priority: 'SENTINEL_PRIORITY',
    slaTargetId: 'SENTINEL_SLA_TARGET' as UUID,
    slaDueAt: 'SENTINEL_SLA_DUE' as Timestamp,
    slaBreached: true,
    escalationLevel: 42,
    escalatedAt: 'SENTINEL_ESCALATED_AT' as Timestamp,
    // §22.5 gives the customer the OUTCOME and withholds WHEN it was resolved. The
    // outcome is asserted separately below; this sentinel proves the timestamp does not
    // travel with it.
    resolvedAt: 'SENTINEL_RESOLVED_AT' as Timestamp,
    transferCount: 7,
    queueEntryId: 'SENTINEL_QUEUE_ENTRY' as UUID,
    participantCount: 9,
    internalNotesCount: 13,
    tenantId: 'SENTINEL_TENANT',
    createdBy: 'SENTINEL_CREATED_BY' as UUID,
    lastSeq: 999,
  };
}

function loadedMessage(overrides: Partial<InternalMessageRecord> = {}): InternalMessageRecord {
  return {
    messageId: '018f2c5a-2b2b-7000-8000-0000000000f1' as UUID,
    conversationId: CONVERSATION,
    seq: 3,
    body: 'We have received your request.',
    visibility: 'CUSTOMER_VISIBLE' as MessageVisibility,
    authorId: AGENT,
    authorKind: 'EMPLOYEE',
    authorDisplayName: 'Priya from Support',
    createdAt: '2026-08-25T10:00:00.000Z' as Timestamp,
    authorEmployeeId: 'SENTINEL_EMPLOYEE_ID',
    authorTeamId: 'SENTINEL_AUTHOR_TEAM',
    authorDepartment: 'SENTINEL_AUTHOR_DEPT',
    redactedAt: 'SENTINEL_REDACTED_AT' as Timestamp,
    redactedBy: 'SENTINEL_REDACTED_BY' as UUID,
    internalTags: ['SENTINEL_TAG_A', 'SENTINEL_TAG_B'],
    aiConfidence: 0.87,
    moderationFlags: ['SENTINEL_MODERATION'],
    ...overrides,
  };
}

/** Every sentinel planted above. None may appear in customer-facing output. */
const ALL_SENTINELS = [
  'SENTINEL_PREVIEW',
  'SENTINEL_CASE_ID',
  'SENTINEL_CUSTOMER_REF',
  'SENTINEL_OWNER_ID',
  'SENTINEL_OWNER_NAME',
  'SENTINEL_TEAM',
  'SENTINEL_DEPARTMENT',
  'SENTINEL_SENSITIVITY',
  'SENTINEL_PRIORITY',
  'SENTINEL_SLA_TARGET',
  'SENTINEL_SLA_DUE',
  'SENTINEL_ESCALATED_AT',
  'SENTINEL_RESOLVED_AT',
  'SENTINEL_QUEUE_ENTRY',
  'SENTINEL_TENANT',
  'SENTINEL_CREATED_BY',
  'SENTINEL_EMPLOYEE_ID',
  'SENTINEL_AUTHOR_TEAM',
  'SENTINEL_AUTHOR_DEPT',
  'SENTINEL_REDACTED_AT',
  'SENTINEL_REDACTED_BY',
  'SENTINEL_TAG_A',
  'SENTINEL_TAG_B',
  'SENTINEL_MODERATION',
];

const leaked = (output: unknown): string[] =>
  ALL_SENTINELS.filter((sentinel) => JSON.stringify(output).includes(sentinel));

describe('conversation projection', () => {
  it('leaks no internal field, checked across the whole serialised output', () => {
    const view = toCustomerConversationView(loadedConversation());

    expect(leaked(view)).toEqual([]);
  });

  it('emits exactly the allowed keys and no others', () => {
    // Pins the shape: a field added to the projection has to be added here too, which
    // is the moment someone has to think about whether a customer should see it.
    const view = toCustomerConversationView(loadedConversation());

    expect(Object.keys(view).sort()).toEqual([
      'conversationId',
      'lastActivityAt',
      'outcome',
      'status',
      'subject',
    ]);
  });

  it('carries the resolution outcome and never the resolution time (BR-20, §22.5)', () => {
    /**
     * Two halves of one §22.5 row — "Resolution timestamp | When it was resolved, and the
     * outcome | **Outcome only**" — and they pull in opposite directions, which is why
     * they are asserted together.
     *
     * BR-20 requires the customer be told the conversation was resolved AND WHY. Before
     * the resolve path landed they got the status and nothing else, so the second half of
     * BR-20 had no implementation at all.
     */
    const resolved = toCustomerConversationView({
      ...loadedConversation(),
      state: 'RESOLVED',
      outcome: 'Your endorsement was issued and posted on 26 August.',
    });

    expect(resolved.outcome).toBe('Your endorsement was issued and posted on 26 August.');
    expect(resolved.status).toBe('RESOLVED');
    expect(JSON.stringify(resolved)).not.toContain('SENTINEL_RESOLVED_AT');
  });

  it('reports no outcome where there is not one yet, rather than omitting the field', () => {
    // `null` rather than absent, so a client renders "not resolved" instead of having to
    // distinguish an unresolved conversation from an older server that did not send it.
    const view = toCustomerConversationView(loadedConversation());
    expect(view.outcome).toBeNull();
  });

  it('still emits the fields the customer legitimately needs', () => {
    // The counterpart to the leak test: a projection that returned {} would pass every
    // assertion above and be useless.
    const view = toCustomerConversationView(loadedConversation());

    expect(view.conversationId).toBe(CONVERSATION);
    expect(view.subject).toBe('My renewal question');
    expect(view.lastActivityAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('never leaks the preview, which can contain an internal note’s opening words', () => {
    const view = toCustomerConversationView(loadedConversation());
    expect(JSON.stringify(view)).not.toContain('SENTINEL_PREVIEW');
  });

  it('does not survive a field added to the record later', () => {
    // Simulates Phase 6 adding an SLA breach reason. A deny-list would start publishing
    // it; the allow-list keeps hiding it, and this test documents that on purpose.
    const withFutureField = {
      ...loadedConversation(),
      slaBreachReason: 'SENTINEL_FUTURE_FIELD',
      assignedSpecialistNotes: 'SENTINEL_FUTURE_NOTES',
    } as InternalConversationRecord;

    const serialised = JSON.stringify(toCustomerConversationView(withFutureField));

    expect(serialised).not.toContain('SENTINEL_FUTURE_FIELD');
    expect(serialised).not.toContain('SENTINEL_FUTURE_NOTES');
  });

  it('collapses internal lifecycle states rather than passing them through', () => {
    /**
     * "Escalated" describes our internal handling. A customer learning that their
     * complaint was escalated at 14:02 knows something about our process, not about
     * their case.
     *
     * The vocabulary is D-26's (§44.5) and the mapping now lives in
     * `@starlink/service-case`, exhaustive over `ConversationState` so a new state
     * cannot fall through a default. Its own suite tests the mapping in depth; these
     * assertions stay here because this module is the visibility boundary callers
     * actually reach for, and the boundary should be tested where it is used.
     */
    expect(toCustomerState('ESCALATED')).toBe('RECEIVED');
    expect(toCustomerState('QUEUED')).toBe('RECEIVED');
    expect(toCustomerState('CLAIMED')).toBe('RECEIVED');
    expect(toCustomerState('TRANSFERRED')).toBe('RECEIVED');
    expect(toCustomerState('ACTIVE')).toBe('BEING_LOOKED_AT');
    expect(toCustomerState('RESOLVED')).toBe('RESOLVED');
    // §21.4 gives `resolved → closed` a "Customer notified: No" — closure is an internal
    // boundary for measuring work (BR-22), so the customer keeps seeing "resolved".
    expect(toCustomerState('CLOSED')).toBe('RESOLVED');
  });

  it('maps the state the enum actually uses, not a plausible misspelling', () => {
    /**
     * The regression this file previously enshrined. It asserted
     * `toCustomerState('AWAITING_CUSTOMER')` — but the enum value is `WAITING_CUSTOMER`,
     * so the real state fell through to the default and every conversation waiting on the
     * customer displayed as though we were still working on it. Implementation and test
     * shared one wrong assumption, so the suite stayed green.
     */
    expect(toCustomerState('WAITING_CUSTOMER')).toBe('WAITING_FOR_YOU');
    expect(toCustomerState('AWAITING_CUSTOMER')).not.toBe('WAITING_FOR_YOU');
    // Waiting on a colleague is OUR delay. Telling the customer it is theirs would have
    // them waiting for a reply they already sent.
    expect(toCustomerState('WAITING_INTERNAL')).toBe('BEING_LOOKED_AT');
  });

  it('maps an unrecognised state to RECEIVED rather than exposing it', () => {
    // RECEIVED, not BEING_LOOKED_AT: "we have your message" is true of everything that
    // exists, while "being looked at" asserts a person is on it. Claim the less.
    expect(toCustomerState('SOME_STATE_ADDED_IN_PHASE_7')).toBe('RECEIVED');
    expect(toCustomerState(null)).toBe('RECEIVED');
    expect(toCustomerState(undefined)).toBe('RECEIVED');
  });
});

describe('message projection', () => {
  it('drops an internal note entirely', () => {
    const note = loadedMessage({
      visibility: 'INTERNAL' as MessageVisibility,
      body: 'SENTINEL_INTERNAL_BODY: policy looks mis-sold, escalate',
    });

    expect(toCustomerMessageView(note, CUSTOMER)).toBeUndefined();
  });

  it('leaves NO placeholder where an internal note was', () => {
    // A "[hidden note]" row is most of the leak: it tells the customer that staff
    // discussed them, and exactly when. The timing and volume of internal discussion
    // around a complaint is precisely what must not be inferable (§27.16).
    const page = toCustomerMessagePage(
      [
        loadedMessage({ seq: 1, body: 'Thanks for getting in touch.' }),
        loadedMessage({ seq: 2, visibility: 'INTERNAL' as MessageVisibility, body: 'SENTINEL_NOTE_1' }),
        loadedMessage({ seq: 3, visibility: 'INTERNAL' as MessageVisibility, body: 'SENTINEL_NOTE_2' }),
        loadedMessage({ seq: 4, body: 'We have an update for you.' }),
      ],
      CUSTOMER,
    );

    expect(page).toHaveLength(2);
    expect(JSON.stringify(page)).not.toContain('SENTINEL_NOTE');
    // Non-contiguous seq is correct and deliberate: the gap is not evidence of a note,
    // because the customer stream never promised to be dense.
    expect(page.map((m) => m.seq)).toEqual([1, 4]);
  });

  it('leaks no internal author metadata', () => {
    const view = toCustomerMessageView(loadedMessage(), CUSTOMER);

    expect(leaked(view)).toEqual([]);
  });

  it('never exposes a principal id, so staff cannot be correlated across conversations', () => {
    const view = toCustomerMessageView(loadedMessage(), CUSTOMER);

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(AGENT);
    expect(serialised).not.toContain('authorId');
  });

  it('emits exactly the allowed keys', () => {
    const view = toCustomerMessageView(loadedMessage(), CUSTOMER);

    expect(Object.keys(view ?? {}).sort()).toEqual([
      'author',
      'body',
      'createdAt',
      'messageId',
      'seq',
    ]);
    expect(Object.keys(view?.author ?? {}).sort()).toEqual(['displayName', 'kind']);
  });

  it('labels the customer’s own messages as YOU and staff as AGENT', () => {
    const mine = toCustomerMessageView(
      loadedMessage({ authorId: CUSTOMER, authorKind: 'CUSTOMER' }),
      CUSTOMER,
    );
    const theirs = toCustomerMessageView(loadedMessage(), CUSTOMER);

    expect(mine?.author.kind).toBe('YOU');
    expect(theirs?.author.kind).toBe('AGENT');
  });

  it('presents an AI author as an AGENT, never as a distinct machine identity', () => {
    // Whether a reply was drafted by a model is an internal fact. Advertising it
    // invites "put me through to a human" as a routing channel we have not designed.
    const ai = toCustomerMessageView(loadedMessage({ authorKind: 'AI' }), CUSTOMER);

    expect(ai?.author.kind).toBe('AGENT');
    expect(JSON.stringify(ai)).not.toContain('aiConfidence');
  });

  it('keeps the message body, which is the whole point', () => {
    const view = toCustomerMessageView(loadedMessage(), CUSTOMER);
    expect(view?.body).toBe('We have received your request.');
  });
});

describe('fuzzed isolation', () => {
  /**
   * Randomised sweep. Each round plants a fresh random sentinel in a randomly chosen
   * internal field and asserts it never reaches the output — including fields that do
   * not exist on the declared type, which is how a repository returning `SELECT *`
   * would actually deliver a leak.
   */
  it('never emits a value planted in any internal field, over 500 randomised rounds', () => {
    const internalOnlyFields = [
      'caseId',
      'customerRef',
      'currentOwnerId',
      'currentOwnerName',
      'owningTeamId',
      'owningDepartment',
      'sensitivity',
      'priority',
      'slaTargetId',
      'slaDueAt',
      'escalatedAt',
      'queueEntryId',
      'tenantId',
      'createdBy',
      'lastMessagePreview',
      'someFieldNobodyHasWrittenYet',
      'internalRoutingHint',
    ];

    // Deterministic PRNG: a failure has to be reproducible, and Math.random would make
    // this test tell a different story on every run.
    let seed = 987654321;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const escapes: string[] = [];
    for (let round = 0; round < 500; round += 1) {
      const field = internalOnlyFields[Math.floor(random() * internalOnlyFields.length)] ?? 'caseId';
      const planted = `FUZZ_${round}_${Math.floor(random() * 1e9)}`;

      const record = { ...loadedConversation(), [field]: planted } as InternalConversationRecord;
      const serialised = JSON.stringify(toCustomerConversationView(record));

      if (serialised.includes(planted)) escapes.push(`${field} -> ${planted}`);
    }

    expect(escapes).toEqual([]);
  });

  it('never emits an internal message field, over 500 randomised rounds', () => {
    const internalOnlyFields = [
      'authorEmployeeId',
      'authorTeamId',
      'authorDepartment',
      'redactedBy',
      'internalTags',
      'moderationFlags',
      'conversationId',
      'somethingAddedInPhase11',
    ];

    let seed = 24681357;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const escapes: string[] = [];
    for (let round = 0; round < 500; round += 1) {
      const field = internalOnlyFields[Math.floor(random() * internalOnlyFields.length)] ?? 'internalTags';
      const planted = `FUZZ_MSG_${round}_${Math.floor(random() * 1e9)}`;

      const record = { ...loadedMessage(), [field]: planted } as InternalMessageRecord;
      const serialised = JSON.stringify(toCustomerMessageView(record, CUSTOMER));

      if (serialised.includes(planted)) escapes.push(`${field} -> ${planted}`);
    }

    expect(escapes).toEqual([]);
  });

  it('drops every non-customer-visible message whatever the visibility value says', () => {
    // Fail-closed on an unrecognised visibility. If Phase 7 adds a third value, it must
    // default to hidden — a new visibility becoming customer-visible by default is the
    // single worst leak available in this product.
    const exotic = ['INTERNAL', 'REDACTED', 'SYSTEM_ONLY', 'PENDING_MODERATION', '', 'internal'];

    for (const visibility of exotic) {
      const record = loadedMessage({
        visibility: visibility as MessageVisibility,
        body: `SENTINEL_BODY_${visibility}`,
      });
      expect(toCustomerMessageView(record, CUSTOMER), `visibility=${visibility}`).toBeUndefined();
    }

    // And the one value that IS allowed still works, so the above is not vacuous.
    expect(toCustomerMessageView(loadedMessage(), CUSTOMER)).toBeDefined();
  });
});
