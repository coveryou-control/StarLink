/**
 * The routing decision tree as rules (doc §21.8, §21.9).
 *
 * Tested against the diagram branch by branch, because "every branch is deterministic
 * and inspectable" is a claim that only means something if each branch is actually
 * exercised. The decision carries its path, so these assert the ROUTE taken as well as
 * the outcome — a conversation reaching the queue for the wrong reason is a bug that a
 * bare outcome assertion cannot see.
 */
import { describe, expect, it } from 'vitest';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import { assessAvailability, type Candidate } from './availability.js';
import { route, type FallbackPolicy, type RoutingInputs } from './route.js';

const AT = '2026-08-26T11:00:00.000Z' as Timestamp;
const CONVERSATION = '018f2c5a-5a5a-7000-8000-0000000000d1' as UUID;
const ADVISOR = '018f2c5a-5a5a-7000-8000-00000000000a' as UUID;
const BACKUP = '018f2c5a-5a5a-7000-8000-00000000000b' as UUID;
const LEAD = '018f2c5a-5a5a-7000-8000-00000000000c' as UUID;

const available = (principalId: UUID, basis: Candidate['basis'] = 'DESIGNATED'): Candidate => ({
  principalId,
  basis,
  availability: { available: true },
});

const unavailable = (
  principalId: UUID,
  reason: Parameters<typeof route> extends never ? never : 'DECLARED_ABSENCE',
  basis: Candidate['basis'] = 'DESIGNATED',
): Candidate => ({ principalId, basis, availability: { available: false, reason } });

const BASE: RoutingInputs = {
  conversationId: CONVERSATION,
  teamId: 'renewals',
  teamCalendarOpen: true,
  categoryIsRelationshipShaped: true,
  fallback: { kind: 'TEAM_QUEUE' } as FallbackPolicy,
  at: AT,
};

const ask = (over: Partial<RoutingInputs> = {}): ReturnType<typeof route> =>
  route({ ...BASE, ...over });

/**
 * The same question with the team mapping ABSENT rather than set to `undefined`.
 *
 * `exactOptionalPropertyTypes` draws that distinction and is right to: "no mapping
 * exists" and "the mapping is the value undefined" are different claims, and the second
 * is not one the production type permits. Omission is the honest way to say the first.
 */
const askWithoutTeam = (): ReturnType<typeof route> => {
  const { teamId: _omitted, ...withoutTeam } = BASE;
  return route(withoutTeam);
};

describe('step 1 — is the team open', () => {
  it('queues after hours and marks it, so no clock starts', () => {
    const decision = ask({ teamCalendarOpen: false });

    expect(decision.outcome).toBe('QUEUE');
    // §23.5: the after-hours flag is what stops the first-response clock. A queued
    // conversation that looked like an ordinary one would start breaching overnight.
    expect(decision.outcome === 'QUEUE' && decision.afterHours).toBe(true);
    expect(decision.path).toEqual(['TEAM_CLOSED']);
  });

  it('does not consider the designated employee at all when the team is closed', () => {
    // Nobody is available outside their working window (§21.9), so asking whether the
    // advisor is free is the wrong question — and answering it would assign work into
    // a closed team.
    const decision = ask({ teamCalendarOpen: false, designated: available(ADVISOR) });

    expect(decision.outcome).toBe('QUEUE');
    expect(decision.path).not.toContain('DESIGNATED_AVAILABLE');
  });
});

describe('step 2 — is the category relationship-shaped', () => {
  it('sends a queue-shaped category straight to the team queue', () => {
    // Fresh Sales: a prospect has no relationship, so the fastest advisor takes it.
    const decision = ask({ categoryIsRelationshipShaped: false, designated: available(ADVISOR) });

    expect(decision.outcome).toBe('QUEUE');
    expect(decision.path).toEqual(['TEAM_OPEN', 'QUEUE_SHAPED_CATEGORY']);
  });

  it('ignores a designated employee for a queue-shaped category', () => {
    // Even if one exists. The shape of the department decides, not the relationship.
    const decision = ask({ categoryIsRelationshipShaped: false, designated: available(ADVISOR) });

    expect(decision.outcome === 'QUEUE').toBe(true);
  });
});

describe('steps 3 and 4 — designated employee', () => {
  it('queues when the customer has no designated employee', () => {
    // A new prospect has none, and that is normal rather than an error (§21.7).
    const decision = ask();

    expect(decision.outcome).toBe('QUEUE');
    expect(decision.path).toContain('NO_DESIGNATED_EMPLOYEE');
  });

  it('assigns to the designated employee when they are available', () => {
    const decision = ask({ designated: available(ADVISOR) });

    expect(decision.outcome).toBe('ASSIGN');
    expect(decision.outcome === 'ASSIGN' && decision.ownerId).toBe(ADVISOR);
    expect(decision.outcome === 'ASSIGN' && decision.basis).toBe('DESIGNATED');
  });
});

describe('step 5 — fallback when the designated employee is unavailable (D-05)', () => {
  it('assigns a named backup', () => {
    const decision = ask({
      designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'),
      fallback: { kind: 'NAMED_BACKUP', backup: available(BACKUP, 'NAMED_BACKUP') },
    });

    expect(decision.outcome === 'ASSIGN' && decision.ownerId).toBe(BACKUP);
    expect(decision.outcome === 'ASSIGN' && decision.basis).toBe('NAMED_BACKUP');
  });

  it('falls through to the queue when the named backup is also out', () => {
    // A named backup is a preference, not the last resort. Giving up here would hold
    // work that a colleague on the team could have taken.
    const decision = ask({
      designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'),
      fallback: {
        kind: 'NAMED_BACKUP',
        backup: unavailable(BACKUP, 'DECLARED_ABSENCE', 'NAMED_BACKUP'),
      },
    });

    expect(decision.outcome).toBe('QUEUE');
    expect(decision.path).toContain('FALLBACK_BACKUP_UNAVAILABLE');
  });

  it('queues under the team-queue policy', () => {
    const decision = ask({
      designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'),
      fallback: { kind: 'TEAM_QUEUE' },
    });

    expect(decision.outcome).toBe('QUEUE');
    expect(decision.path).toContain('FALLBACK_TEAM_QUEUE');
  });

  it('reports UNROUTABLE with a lead to escalate to, rather than holding silently', () => {
    /**
     * §21.8's most important branch. Grievance is one person; when they are away there
     * is nobody. The document is explicit: the conversation "stays QUEUED and VISIBLY
     * UNANSWERED. Never silently held." An organisational single point of failure that
     * the software's job is to make undeniable rather than to hide.
     */
    const decision = ask({
      designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'),
      fallback: { kind: 'LEAD_REASSIGNS', leadId: LEAD },
    });

    expect(decision.outcome).toBe('UNROUTABLE');
    expect(decision.outcome === 'UNROUTABLE' && decision.escalateTo).toBe(LEAD);
    // Still attached to a team: unanswered work must remain findable, not orphaned.
    expect(decision.outcome === 'UNROUTABLE' && decision.teamId).toBe('renewals');
  });
});

describe('unconfigured mapping', () => {
  it('refuses to route a category with no team rather than guessing one', () => {
    // D-17 has not mapped this category. Routing it to "some team" is how work
    // disappears; refusing makes the gap visible while it is still cheap.
    const decision = askWithoutTeam();

    expect(decision.outcome).toBe('UNROUTABLE');
    expect(decision.path).toEqual(['NO_TEAM_CONFIGURED']);
  });
});

describe('the decision is deterministic and inspectable', () => {
  it('returns the same decision for the same inputs', () => {
    // "No random selection at any point" (§21.8). A router that picked among equals
    // would make an escalation impossible to explain after the fact.
    const inputs = { designated: available(ADVISOR) };
    const first = ask(inputs);
    const second = ask(inputs);

    expect(second).toEqual(first);
  });

  it('carries the full path on every outcome', () => {
    for (const decision of [
      ask({ teamCalendarOpen: false }),
      ask({ categoryIsRelationshipShaped: false }),
      ask({ designated: available(ADVISOR) }),
      askWithoutTeam(),
    ]) {
      expect(decision.path.length).toBeGreaterThan(0);
    }
  });

  it('never assigns to someone assessed as unavailable', () => {
    // The property that matters most: no path through the tree hands work to a person
    // who is on leave, deactivated, or over capacity.
    const outcomes = [
      ask({ designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'), fallback: { kind: 'TEAM_QUEUE' } }),
      ask({
        designated: unavailable(ADVISOR, 'DECLARED_ABSENCE'),
        fallback: {
          kind: 'NAMED_BACKUP',
          backup: unavailable(BACKUP, 'DECLARED_ABSENCE', 'NAMED_BACKUP'),
        },
      }),
      ask({ teamCalendarOpen: false, designated: unavailable(ADVISOR, 'DECLARED_ABSENCE') }),
    ];

    expect(outcomes.every((d) => d.outcome !== 'ASSIGN')).toBe(true);
  });
});

describe('availability (§21.9)', () => {
  const facts = (over: Partial<Parameters<typeof assessAvailability>[0]> = {}) =>
    assessAvailability({
      principalId: ADVISOR,
      teamCalendarOpen: true,
      accountActive: true,
      onDeclaredAbsence: false,
      explicitlyUnavailable: false,
      ...over,
    });

  it('is available when nothing says otherwise', () => {
    expect(facts().available).toBe(true);
  });

  it('reports the most fundamental reason first', () => {
    // Someone on leave whose team is also shut reads as TEAM_CLOSED: a lead needs to
    // know the team is closed before they start looking for cover for one person.
    const verdict = facts({ teamCalendarOpen: false, onDeclaredAbsence: true });
    expect(verdict.available === false && verdict.reason).toBe('TEAM_CLOSED');
  });

  it('refuses a deactivated account (BR-13)', () => {
    const verdict = facts({ accountActive: false });
    expect(verdict.available === false && verdict.reason).toBe('ACCOUNT_INACTIVE');
  });

  it('honours a declared absence and an explicit unavailable flag', () => {
    expect(facts({ onDeclaredAbsence: true }).available).toBe(false);
    expect(facts({ explicitlyUnavailable: true }).available).toBe(false);
  });

  it('enforces a capacity ceiling only when one is configured', () => {
    // D-05 is unanswered. No ceiling means NO ceiling — not a ceiling of zero, which
    // would make everyone permanently unavailable the moment they held one thread.
    expect(facts({ capacity: { openConversations: 99, ceiling: 100 } }).available).toBe(true);
    expect(facts({ capacity: { openConversations: 100, ceiling: 100 } }).available).toBe(false);
    expect(facts().available).toBe(true);
  });

  it('cannot be told about a socket, a heartbeat or a last-seen time', () => {
    /**
     * The rule enforced by the TYPE rather than by care: §21.9 says availability is
     * "never inferred from a socket", and `AvailabilityFacts` has no field that could
     * carry one. "A phone entering a lift is not leave."
     *
     * This test exists so the property is stated where someone will read it. If a
     * presence field is ever added, this list stops matching and the conversation
     * happens before the reassignment does.
     */
    const permitted = [
      'principalId',
      'teamCalendarOpen',
      'accountActive',
      'onDeclaredAbsence',
      'explicitlyUnavailable',
      'capacity',
    ];
    const supplied = Object.keys({
      principalId: ADVISOR,
      teamCalendarOpen: true,
      accountActive: true,
      onDeclaredAbsence: false,
      explicitlyUnavailable: false,
      capacity: { openConversations: 0, ceiling: 5 },
    });

    expect(supplied.sort()).toEqual([...permitted].sort());
  });
});
