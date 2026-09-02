/**
 * PHASE 4 EXIT CRITERION: assurance-gating.
 *
 * The ladder (ADR-019, brief §7) exists so that required identity strength follows the
 * ACTION: a general question may be anonymous, while a policy copy, claim detail or
 * payment question needs a verified customer. `decide.test.ts` covers the two obvious
 * cases — too low is refused, a low bar passes. These are the ones that decide whether
 * the ladder still works in six months.
 *
 * The property that matters most is the DEFAULT. No route in the system reads policy,
 * claim or payment data yet, so there is nothing to gate today and none is invented
 * here. What can be proven now is that when such a route is added — in Phase 10, by
 * someone who has not read this file — forgetting to think about assurance yields
 * VERIFIED_CUSTOMER rather than open access. A ladder whose default rung is the ground
 * is not a ladder.
 */
import { describe, expect, it } from 'vitest';
import { ASSURANCE_RANK, type Assurance } from '@starlink/shared-contracts';

import { decide, type ActorContext, type ResourceContext } from './decide.js';

const NOW = '2026-08-26T10:00:00.000Z';

const customer = (assurance?: Assurance): ActorContext => ({
  principalId: 'cust-1',
  kind: 'CUSTOMER',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...(assurance !== undefined ? { assurance } : {}),
});

const ownConversation = (): ResourceContext => ({
  conversationId: 'conv-1',
  conversationType: 'CUSTOMER_SERVICE',
  sensitivity: 'ORDINARY',
  customerRef: 'CCS:customer:c-1',
  belongsToActorCustomer: true,
});

const ask = (over: {
  assurance?: Assurance;
  requiredAssurance?: Assurance;
  action?: string;
}): ReturnType<typeof decide> =>
  decide({
    actor: customer(over.assurance),
    action: over.action ?? 'conversation.read',
    resource: ownConversation(),
    now: NOW,
    ...(over.requiredAssurance !== undefined ? { requiredAssurance: over.requiredAssurance } : {}),
  });

const LADDER: readonly Assurance[] = [
  'ANONYMOUS',
  'PSEUDONYMOUS',
  'VERIFIED_CUSTOMER',
  'AUTHENTICATED_CUSTOMER',
];

describe('the assurance ladder is ordered', () => {
  it('ranks the rungs strictly increasing', () => {
    // The comparison in `decide` is `RANK[held] < RANK[required]`, so an unordered or
    // duplicated rank silently makes two levels equivalent.
    const ranks = LADDER.map((level) => ASSURANCE_RANK[level]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(LADDER.length);
  });

  it('admits every rung at or above the requirement, and refuses every rung below', () => {
    for (const required of LADDER) {
      for (const held of LADDER) {
        const expected = ASSURANCE_RANK[held] >= ASSURANCE_RANK[required];
        const decision = ask({ assurance: held, requiredAssurance: required });
        expect(decision.allow, `held=${held} required=${required}`).toBe(expected);
        if (!decision.allow && expected === false) {
          expect(decision.reason).toBe('CUSTOMER_INSUFFICIENT_ASSURANCE');
        }
      }
    }
  });
});

describe('the default requirement is strict', () => {
  /**
   * The Phase 10 safety net.
   *
   * When a route that reaches policy or claim data is written, the author may simply not
   * pass `requiredAssurance`. That omission must fail CLOSED. If the default were
   * ANONYMOUS, every future customer route would be open until someone remembered to
   * lock it, and the failure would be invisible in review — the code reads fine.
   */
  it('refuses an ANONYMOUS customer when the operation declares nothing', () => {
    const decision = ask({ assurance: 'ANONYMOUS' });

    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toBe('CUSTOMER_INSUFFICIENT_ASSURANCE');
  });

  it('refuses a PSEUDONYMOUS customer when the operation declares nothing', () => {
    // Proven contact, unrecognised person. Not enough for data belonging to a customer.
    expect(ask({ assurance: 'PSEUDONYMOUS' }).allow).toBe(false);
  });

  it('admits a VERIFIED_CUSTOMER when the operation declares nothing', () => {
    expect(ask({ assurance: 'VERIFIED_CUSTOMER' }).allow).toBe(true);
  });

  it('treats an actor carrying NO assurance as ANONYMOUS', () => {
    // A customer principal whose assurance was lost in mapping must not be treated as
    // unrestricted — absent is the bottom rung, never a wildcard (FR-AUTHZ-3's posture).
    const decision = ask({});

    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toBe('CUSTOMER_INSUFFICIENT_ASSURANCE');
  });

  it('an operation may lower the bar deliberately, and only deliberately', () => {
    // §21.5: asking a question precedes proving who you are. The customer surface states
    // ANONYMOUS explicitly for ordinary chat — visible in review, unlike a default.
    expect(ask({ assurance: 'ANONYMOUS', requiredAssurance: 'ANONYMOUS' }).allow).toBe(true);
  });
});

describe('assurance never substitutes for ownership', () => {
  it('refuses the highest assurance on someone else’s conversation', () => {
    // Ownership is checked BEFORE assurance in `decide`, so a fully authenticated
    // customer gets no closer to another customer's thread than an anonymous one.
    const decision = decide({
      actor: customer('AUTHENTICATED_CUSTOMER'),
      action: 'conversation.read',
      resource: { ...ownConversation(), belongsToActorCustomer: false },
      now: NOW,
    });

    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toBe('CUSTOMER_NOT_OWNER_OF_RESOURCE');
  });

  it('refuses internal content at every rung', () => {
    // Assurance is about WHO you are; visibility is about what the content is. No amount
    // of the first buys the second (ADR-021).
    for (const held of LADDER) {
      const decision = decide({
        actor: customer(held),
        action: 'conversation.read',
        resource: ownConversation(),
        targetVisibility: 'INTERNAL',
        now: NOW,
      });
      expect(decision.allow, held).toBe(false);
      expect(decision.allow === false && decision.reason).toBe('CUSTOMER_INTERNAL_CONTENT');
    }
  });

  it('refuses an employee-only action at every rung', () => {
    for (const held of LADDER) {
      const decision = ask({ assurance: held, action: 'conversation.transfer' });
      expect(decision.allow, held).toBe(false);
      expect(decision.allow === false && decision.reason).toBe('CUSTOMER_ACTION_FORBIDDEN');
    }
  });
});

describe('the ladder applies to customers only', () => {
  it('does not gate an employee, who has no assurance at all', () => {
    // Employees are not on this ladder (ADR-019). If `requiredAssurance` leaked into the
    // employee path, every staff member would be refused for holding `undefined`.
    const decision = decide({
      actor: {
        principalId: 'emp-1',
        kind: 'EMPLOYEE',
        status: 'ACTIVE',
        teams: [],
        departments: [],
        grants: [
          {
            role: 'AGENT',
            actions: ['conversation.read'],
            scopeKind: 'GLOBAL',
            effectiveFrom: '2020-01-01T00:00:00.000Z',
          },
        ],
        delegations: [],
        temporaryGrants: [],
      },
      action: 'conversation.read',
      resource: {
        conversationId: 'conv-1',
        conversationType: 'CUSTOMER_SERVICE',
        sensitivity: 'ORDINARY',
        currentOwnerId: 'emp-1',
      },
      requiredAssurance: 'AUTHENTICATED_CUSTOMER',
      now: NOW,
    });

    expect(decision.allow).toBe(true);
  });
});
