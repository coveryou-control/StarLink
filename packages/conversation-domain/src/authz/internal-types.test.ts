/**
 * Two facts about a conversation type that used to be one, and the relationship between them.
 *
 * `conversations.ts` exports `isInternal` — *this type has no customer, no case and no
 * lifecycle*. `decide.ts` keeps a private list of the types on which ANY participant may
 * manage membership (BR-05), so that the one function every content path routes through
 * depends on nothing but the action vocabulary.
 *
 * Those two lists were identical, and this file asserted their equality. The equality was
 * incidental: it held while every internal thread was a small room whose members had each
 * been let in by another member. `INTERNAL_ANNOUNCEMENT` ends it — its participants are the
 * whole company, so "any participant may remove a participant" would let anybody remove
 * anybody from a company-wide thread.
 *
 * So the assertion is now the relationship that is actually true, and it is still
 * exhaustive over the union:
 *
 *   1. Participant-managed implies internal. A type `decide()` treats as owner-less must be
 *      one `conversations.ts` agrees has no owner, or membership changes would be decided by
 *      a rule the rest of the system does not believe.
 *   2. Every type's membership of BOTH lists is stated here, by name. A type added to
 *      `ConversationType` fails to COMPILE until somebody writes down which it is — which is
 *      the drift this file has always existed to catch.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationType } from '@starlink/shared-contracts';

import { isInternal } from '../conversations.js';
import { decide, type ActorContext, type ResourceContext } from './decide.js';

/**
 * Every value of the union, listed once.
 *
 * ## Why the exhaustiveness check below, and not just `satisfies`
 *
 * An earlier version of this file wrote `as const satisfies readonly ConversationType[]`
 * and claimed in a comment that it made the list self-maintaining. It does not:
 * `satisfies` checks that each ELEMENT is assignable to the union and imposes no coverage
 * requirement on it — a one-element tuple satisfies it exactly as well as a ten-element one.
 *
 * The claim was not merely wrong in principle. The list was already missing
 * `SYSTEM_INTERACTION`, so a guard written to catch drift had itself drifted before it ever
 * ran — and the comment would have persuaded the next reader not to check.
 *
 * `Uncovered` is the real mechanism: excluding the tuple’s members from the union must
 * leave `never`, so adding a member to `ConversationType` without adding it here fails to
 * compile.
 */
const EXPECTED: Readonly<Record<ConversationType, { internal: boolean; participantManaged: boolean }>> = {
  CUSTOMER_SERVICE: { internal: false, participantManaged: false },
  CUSTOMER_CLAIM: { internal: false, participantManaged: false },
  CUSTOMER_GRIEVANCE: { internal: false, participantManaged: false },
  CUSTOMER_SALES: { internal: false, participantManaged: false },
  CUSTOMER_RENEWAL: { internal: false, participantManaged: false },
  CUSTOMER_GENERAL: { internal: false, participantManaged: false },
  INTERNAL_DIRECT: { internal: true, participantManaged: true },
  INTERNAL_GROUP: { internal: true, participantManaged: true },
  /* Internal — no customer, no case, no lifecycle — and NOT participant-managed: the
     participants are everybody, and everybody must not be able to remove everybody. */
  INTERNAL_ANNOUNCEMENT: { internal: true, participantManaged: false },
  SYSTEM_INTERACTION: { internal: false, participantManaged: false },
  AI_HANDOFF: { internal: false, participantManaged: false },
};

/**
 * Fails to COMPILE when a ConversationType is added without an entry above.
 *
 * `Record<ConversationType, …>` already requires every key, which is the mechanism; this
 * names it so the next person removing a key sees why the build broke.
 */
const ALL_TYPES = Object.keys(EXPECTED) as readonly ConversationType[];

const NOW = '2026-08-30T12:00:00.000Z';

/** A live participant who is NOT the owner and holds no role grant at all. */
const participant: ActorContext = {
  principalId: '018f2c5a-8e00-7000-8000-00000000000a',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [],
  delegations: [],
  temporaryGrants: [],
};

const resourceOf = (conversationType: ConversationType): ResourceContext => ({
  conversationId: '018f2c5a-8e00-7000-8000-0000000000d1',
  conversationType,
  // Somebody else owns it. On an internal thread this is absent in reality; setting it
  // here makes the participant unambiguously NOT the owner in every case, so the only
  // thing that can vary the answer is the type.
  currentOwnerId: '018f2c5a-8e00-7000-8000-00000000000b',
  sensitivity: 'ORDINARY',
  participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** `decide()`'s list is private, so it is read through the behaviour that IS the list. */
const participantMayManageMembership = (conversationType: ConversationType): boolean =>
  decide({
    actor: participant,
    action: 'conversation.participant.add',
    resource: resourceOf(conversationType),
    now: NOW,
  }).allow;

describe('internal conversation types', () => {
  it('states, for every type, whether it is internal and whether members manage it', () => {
    for (const conversationType of ALL_TYPES) {
      const expected = EXPECTED[conversationType];

      expect(isInternal(conversationType), `${conversationType}: isInternal()`).toBe(
        expected.internal,
      );
      expect(
        participantMayManageMembership(conversationType),
        `${conversationType}: decide() on conversation.participant.add`,
      ).toBe(expected.participantManaged);
    }
  });

  it('never lets a type be participant-managed without being internal', () => {
    /**
     * The direction that would be a defect rather than a decision. Membership managed from
     * inside is BR-05's rule for a thread with no accountable owner; on a conversation that
     * HAS one, P-03 gives that to the owner. A type in one list and not the other in this
     * direction means two parts of the system disagree about whether somebody is in charge.
     */
    for (const conversationType of ALL_TYPES) {
      if (participantMayManageMembership(conversationType)) {
        expect(isInternal(conversationType), `${conversationType}`).toBe(true);
      }
    }
  });

  it('covers every combination it claims to, so no assertion is vacuous', () => {
    const internal = ALL_TYPES.filter((t) => EXPECTED[t].internal);
    const managed = ALL_TYPES.filter((t) => EXPECTED[t].participantManaged);

    expect(internal.length).toBeGreaterThan(0);
    expect(ALL_TYPES.length - internal.length).toBeGreaterThan(0);
    // The case that makes the subset assertion above mean something: internal, not managed.
    expect(internal.length).toBeGreaterThan(managed.length);
  });

  it('does not let participation alone post to an announcement', () => {
    /**
     * The whole point of the type. Everybody is a participant of an announcement, so if
     * participation granted `conversation.message.send` there, it would grant the entire
     * company a broadcast.
     */
    expect(
      decide({
        actor: participant,
        action: 'conversation.message.send',
        resource: resourceOf('INTERNAL_ANNOUNCEMENT'),
        now: NOW,
      }).allow,
      'a participant of an announcement must not be able to post to it',
    ).toBe(false);

    // And the same participant may still READ it — otherwise the narrowing has gone too far
    // and an announcement is a thread nobody can see.
    expect(
      decide({
        actor: participant,
        action: 'conversation.read',
        resource: resourceOf('INTERNAL_ANNOUNCEMENT'),
        now: NOW,
      }).allow,
    ).toBe(true);

    // Ordinary group behaviour is untouched: the narrowing is per type, not a new global.
    expect(
      decide({
        actor: participant,
        action: 'conversation.message.send',
        resource: resourceOf('INTERNAL_GROUP'),
        now: NOW,
      }).allow,
    ).toBe(true);
  });

  it('lets a holder of the announcement grant post to one', () => {
    const lead: ActorContext = {
      ...participant,
      grants: [
        {
          role: 'TEAM_LEAD',
          actions: ['conversation.announcement.post'],
          scopeKind: 'GLOBAL',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    expect(
      decide({
        actor: lead,
        action: 'conversation.announcement.post',
        resource: resourceOf('INTERNAL_ANNOUNCEMENT'),
        now: NOW,
      }).allow,
    ).toBe(true);

    // …and the participant without the grant does not, which is what makes the line above
    // evidence of the grant rather than of the rung below it.
    expect(
      decide({
        actor: participant,
        action: 'conversation.announcement.post',
        resource: resourceOf('INTERNAL_ANNOUNCEMENT'),
        now: NOW,
      }).allow,
    ).toBe(false);
  });

  it('does not let an internal participant reply to a customer', () => {
    /**
     * The boundary of what the internal branch grants. It exists for membership only —
     * P-03's other refusals (replying to the customer, reassigning, closing) stay refused
     * on every conversation type, internal ones included.
     */
    for (const action of [
      'conversation.reply.customer',
      'conversation.transfer',
      'conversation.resolve',
    ]) {
      expect(
        decide({ actor: participant, action, resource: resourceOf('INTERNAL_GROUP'), now: NOW })
          .allow,
        `participation must not grant ${action}`,
      ).toBe(false);
    }
  });
});
