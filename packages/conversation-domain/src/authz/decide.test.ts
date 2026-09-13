/**
 * Authorization matrix — the negative cases matter more than the positive ones.
 *
 * Doc §38 records that the reference platform treated membership as authorization, and
 * that an early prototype of THIS product reproduced the defect: a non-participant
 * successfully read a conversation. These tests are where that finding lives.
 */
import { describe, expect, it } from 'vitest';
import { decide, type ActorContext, type DecisionRequest, type ResourceContext } from './decide.js';

const NOW = '2026-08-24T10:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
const EXPIRED = '2026-08-20T00:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';

const employee = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: 'emp-1',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: ['support'],
  departments: ['service'],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

const customerConversation = (over: Partial<ResourceContext> = {}): ResourceContext => ({
  conversationId: 'conv-1',
  conversationType: 'CUSTOMER_SERVICE',
  caseId: 'case-1',
  owningTeamId: 'support',
  owningDepartment: 'service',
  currentOwnerId: 'emp-owner',
  customerRef: 'CCS:customer:c-1',
  sensitivity: 'ORDINARY',
  ...over,
});

const ask = (over: Partial<DecisionRequest>): DecisionRequest => ({
  actor: employee(),
  action: 'conversation.read',
  resource: customerConversation(),
  now: NOW,
  ...over,
});

describe('fail-closed fundamentals', () => {
  it('denies an unknown action rather than treating it as unrestricted', () => {
    const d = decide(ask({ action: 'conversation.obliterate' }));
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('UNKNOWN_ACTION');
  });

  it('denies an inactive principal even with a global grant (deactivation is immediate)', () => {
    const d = decide(
      ask({
        actor: employee({
          status: 'EXITED',
          grants: [{ role: 'ADMIN', actions: ['conversation.read'], scopeKind: 'GLOBAL', effectiveFrom: PAST }],
        }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('PRINCIPAL_INACTIVE');
  });
});

/**
 * The hole this suite did not have.
 *
 * The regression test below proves a non-participant with NO grants cannot read. That is a
 * weaker claim than it looks: every real employee holds a role, every seeder in the repo
 * issues it at `GLOBAL`, and `scopeCovers('GLOBAL')` returns true unconditionally. So the
 * lowest-privilege AGENT could read every private message between colleagues by id — and no
 * case here said otherwise, because none of them combined a non-participant WITH a grant on
 * an INTERNAL conversation. Confirmed against the running system on 2026-09-08.
 *
 * These are the rows that were missing.
 */
describe('a private internal conversation is reachable only by participation', () => {
  /*
     Built from scratch rather than by overriding `customerConversation`, because the point
     is what is ABSENT. No case, so no owning team and no owning department — which is
     precisely why TEAM- and DEPARTMENT-scoped grants never matched these threads and GLOBAL
     was the only scope that did. Under `exactOptionalPropertyTypes` an explicit `undefined`
     is not the same as an omitted key, and here the omission is the fixture.
  */
  const privateThread = (over: Partial<ResourceContext> = {}): ResourceContext => ({
    conversationId: 'conv-1',
    conversationType: 'INTERNAL_DIRECT',
    sensitivity: 'ORDINARY',
    ...over,
  });

  const globalAgent = (): ActorContext =>
    employee({
      grants: [
        { role: 'AGENT', actions: ['conversation.read'], scopeKind: 'GLOBAL', effectiveFrom: PAST },
      ],
    });

  it('a non-participant holding a GLOBAL role grant cannot read a direct message', () => {
    const d = decide(ask({ actor: globalAgent(), resource: privateThread() }));
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('PRIVATE_CONVERSATION_NOT_A_PARTICIPANT');
  });

  it('the same is true of a group', () => {
    const d = decide(
      ask({ actor: globalAgent(), resource: privateThread({ conversationType: 'INTERNAL_GROUP' }) }),
    );
    expect(d.allow).toBe(false);
  });

  it('a GLOBAL delegation does not reach one either', () => {
    const d = decide(
      ask({
        actor: employee({
          delegations: [
            {
              delegationId: 'del-1',
              capabilities: ['conversation.read'],
              scopeKind: 'GLOBAL',
              effectiveFrom: PAST,
              effectiveTo: FUTURE,
            },
          ],
        }),
        resource: privateThread(),
      }),
    );
    expect(d.allow).toBe(false);
  });

  it('writing is refused as well, not just reading', () => {
    for (const action of ['conversation.message.send', 'conversation.message.react'] as const) {
      const d = decide(
        ask({
          action,
          actor: employee({
            grants: [
              { role: 'AGENT', actions: [action], scopeKind: 'GLOBAL', effectiveFrom: PAST },
            ],
          }),
          resource: privateThread(),
        }),
      );
      expect(d.allow, `${action} must not be reachable by scope`).toBe(false);
    }
  });

  it('a participant is unaffected — this closes a hole, it does not close the door', () => {
    const d = decide(
      ask({
        actor: globalAgent(),
        resource: privateThread({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
        }),
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('PARTICIPANT');
  });

  it('an explicit, time-boxed TEMPORARY grant naming the conversation still reaches it', () => {
    /* The lawful break-glass path. Refusing this too would leave no way to investigate a
       private thread at all, which is not what rule 3 asks for. */
    const d = decide(
      ask({
        actor: employee({
          temporaryGrants: [
            {
              grantId: 'tg-1',
              capability: 'conversation.read',
              conversationId: 'conv-1',
              effectiveFrom: PAST,
              effectiveTo: FUTURE,
            },
          ],
        }),
        resource: privateThread(),
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('TEMPORARY_GRANT');
  });

  it('a PARTICIPANT may still use a role grant for what participation does not carry', () => {
    /*
       The case the first draft of this rung broke.

       Participation grants reading and sending, not renaming (P-03) — so a member renaming
       their own group reaches rung 8 and is allowed by their role. Denying every scope
       grant on a private thread took rename, edit and delete down for the person who
       created the conversation. The hole was NON-participants; this is the line between
       the two, and it is asserted so neither side can drift.
    */
    const d = decide(
      ask({
        action: 'conversation.rename',
        actor: employee({
          grants: [
            {
              role: 'AGENT',
              actions: ['conversation.rename'],
              scopeKind: 'GLOBAL',
              effectiveFrom: PAST,
            },
          ],
        }),
        resource: privateThread({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
        }),
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('SCOPE_GRANT');
  });

  it('a CUSTOMER_SERVICE conversation is still reachable by scope — the fix is narrow', () => {
    /* Anti-overreach. If this ever fails, the new rung has been widened past the two
       participant-managed types and the agent workspace has been broken. */
    const d = decide(ask({ actor: globalAgent() }));
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('SCOPE_GRANT');
  });
});

describe('participation is conversation-scoped, and is not ownership', () => {
  it('THE regression test: a non-participant with no scope cannot read', () => {
    const d = decide(ask({ actor: employee() }));
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('NOT_PARTICIPANT_NO_SCOPE');
  });

  it('a participant may read the conversation they are in', () => {
    const d = decide(
      ask({
        resource: customerConversation({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
        }),
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('PARTICIPANT');
  });

  it('participation in conversation A grants nothing in conversation B', () => {
    // The participant fact is a property of the resource being asked about, so a
    // participant of another conversation simply arrives here with no participation.
    const d = decide(ask({ resource: customerConversation({ conversationId: 'conv-2' }) }));
    expect(d.allow).toBe(false);
  });

  it('a participant may NOT reply to the customer by default (P-03, D-04a)', () => {
    const d = decide(
      ask({
        action: 'conversation.reply.customer',
        resource: customerConversation({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
        }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('PARTICIPATION_DOES_NOT_GRANT_ACTION');
  });

  it('a participant may NOT transfer or resolve', () => {
    for (const action of ['conversation.transfer', 'conversation.resolve'] as const) {
      const d = decide(
        ask({
          action,
          resource: customerConversation({
            participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
          }),
        }),
      );
      expect(d.allow, action).toBe(false);
    }
  });

  it('an expired participation grants nothing (clock-read, no sweep required)', () => {
    const d = decide(
      ask({
        resource: customerConversation({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST, effectiveTo: EXPIRED },
        }),
      }),
    );
    expect(d.allow).toBe(false);
  });

  it('the owner may reply, transfer and resolve', () => {
    for (const action of ['conversation.reply.customer', 'conversation.transfer', 'conversation.resolve'] as const) {
      const d = decide(ask({ actor: employee({ principalId: 'emp-owner' }), action }));
      expect(d.allow, action).toBe(true);
      expect(d.allow === true && d.basis).toBe('OWNER');
    }
  });
});

describe('scope grants', () => {
  it('a team lead does NOT read team conversations by default (D-11 posture)', () => {
    const teamLead = employee({
      principalId: 'emp-tl',
      grants: [{ role: 'TEAM_LEAD', actions: ['queue.read', 'load.read'], scopeKind: 'TEAM', scopeId: 'support', effectiveFrom: PAST }],
    });
    const d = decide(ask({ actor: teamLead }));
    expect(d.allow).toBe(false);
  });

  it('a lead WITH an explicit scoped privileged read is allowed, and it is marked privileged', () => {
    const teamLead = employee({
      principalId: 'emp-tl',
      grants: [
        {
          role: 'TEAM_LEAD_OVERSIGHT',
          actions: ['privileged.conversation.read'],
          scopeKind: 'TEAM',
          scopeId: 'support',
          effectiveFrom: PAST,
        },
      ],
    });
    const d = decide(ask({ actor: teamLead, action: 'privileged.conversation.read' }));
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.privileged).toBe(true);
  });

  it('a team grant does not reach another team', () => {
    const other = employee({
      teams: ['claims'],
      grants: [{ role: 'X', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST }],
    });
    const d = decide(ask({ actor: other }));
    expect(d.allow).toBe(false);
  });

  it('an absent department attribute never matches another absent one', () => {
    const actor = employee({
      departments: [],
      grants: [{ role: 'X', actions: ['conversation.read'], scopeKind: 'DEPARTMENT', effectiveFrom: PAST }],
    });
    // Built without the key at all rather than with an explicit `undefined`: absent
    // must mean absent (doc §27.2), and the type system is made to say so too.
    const { owningDepartment: _omitted, ...withoutDepartment } = customerConversation();
    const d = decide(ask({ actor, resource: withoutDepartment }));
    expect(d.allow).toBe(false);
  });

  it('an expired role assignment is inert', () => {
    const actor = employee({
      grants: [
        { role: 'X', actions: ['conversation.read'], scopeKind: 'GLOBAL', effectiveFrom: PAST, effectiveTo: EXPIRED },
      ],
    });
    expect(decide(ask({ actor })).allow).toBe(false);
  });

  it('administration confers no message read (FR-AUTHZ-7)', () => {
    const admin = employee({
      grants: [
        {
          role: 'ADMIN',
          actions: ['admin.account.manage', 'admin.role.assign', 'admin.principal.deactivate'],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
        },
      ],
    });
    expect(decide(ask({ actor: admin })).allow).toBe(false);
  });

  it('replaying the notification dead letter is its own permission', () => {
    /**
     * `admin.notification.replay` is deliberately not folded into `admin.config.manage`.
     * Configuration management is editing categories, calendars and SLA targets;
     * re-sending notifications is an operational act with an external side effect.
     *
     * The negative half is the point: a config manager who could also replay a month of
     * notifications would be a widening nobody asked for and nobody would notice.
     */
    const configManager = employee({
      grants: [
        { role: 'CONFIG', actions: ['admin.config.manage'], scopeKind: 'GLOBAL', effectiveFrom: PAST },
      ],
    });
    expect(decide(ask({ actor: configManager, action: 'admin.notification.replay' })).allow).toBe(
      false,
    );

    const admin = employee({
      grants: [
        {
          role: 'ADMIN',
          actions: ['admin.config.manage', 'admin.notification.replay'],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
        },
      ],
    });
    expect(decide(ask({ actor: admin, action: 'admin.notification.replay' })).allow).toBe(true);
  });

  it('a super-admin-style global grant still does not imply PII unmask', () => {
    const admin = employee({
      grants: [{ role: 'SUPER_ADMIN', actions: ['admin.account.manage'], scopeKind: 'GLOBAL', effectiveFrom: PAST }],
    });
    expect(decide(ask({ actor: admin, action: 'privileged.pii.unmask' })).allow).toBe(false);
  });
});

describe('sensitivity segmentation (brief §9)', () => {
  it('an ordinary sales scope cannot reach medical claim detail', () => {
    const sales = employee({
      teams: ['sales'],
      grants: [{ role: 'SALES', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'sales', effectiveFrom: PAST }],
    });
    const d = decide(
      ask({ actor: sales, resource: customerConversation({ owningTeamId: 'sales', sensitivity: 'MEDICAL' }) }),
    );
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('SENSITIVITY_SEGMENTATION');
  });

  it('a claims role can', () => {
    const claims = employee({
      teams: ['claims'],
      grants: [{ role: 'CLAIMS', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST }],
    });
    const d = decide(
      ask({ actor: claims, resource: customerConversation({ owningTeamId: 'claims', sensitivity: 'MEDICAL' }) }),
    );
    expect(d.allow).toBe(true);
  });

  /**
   * The sensitivity role must be one the actor holds HERE and NOW.
   *
   * `passesSensitivity` matched the role's NAME anywhere in `actor.grants`, applying
   * neither of the two tests every other rung applies. Both cases below were `allow: true`
   * before the fix, and both are ordinary situations rather than contrived ones: people
   * move between teams, and administrators pre-date assignments.
   *
   * The read itself is authorised by a separate, legitimate grant in each case — that is
   * what makes this a segmentation failure rather than an access failure. The advisor is
   * entitled to the conversation; they are not entitled to its medical detail.
   */
  it('a CLAIMS role scoped to another team does not unlock this team’s medical detail', () => {
    const moved = employee({
      teams: ['retail', 'claims'],
      grants: [
        // The grant that authorises the read: ordinary, correct, covers this conversation.
        { role: 'AGENT', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'retail', effectiveFrom: PAST },
        // The sensitivity-bearing role — for a DIFFERENT team's work.
        { role: 'CLAIMS', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST },
      ],
    });

    const d = decide(
      ask({ actor: moved, resource: customerConversation({ owningTeamId: 'retail', sensitivity: 'MEDICAL' }) }),
    );

    expect(
      d.allow === false && d.reason,
      'a CLAIMS grant over another team satisfied the medical gate for a retail conversation',
    ).toBe('SENSITIVITY_SEGMENTATION');
  });

  it('a CLAIMS role that has not started yet does not unlock medical detail', () => {
    /**
     * `loadRoles` filtered `effectiveTo` and never `effectiveFrom`, so a future-dated
     * assignment was in `grants` today. That is fixed in the adapter — and asserted here
     * too, because an authorization rule must not depend on an adapter's diligence. Both
     * layers, because either one alone leaves the other free to regress silently.
     */
    const joiningLater = employee({
      teams: ['claims'],
      grants: [
        { role: 'AGENT', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST },
        { role: 'CLAIMS', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: FUTURE },
      ],
    });

    const d = decide(
      ask({ actor: joiningLater, resource: customerConversation({ owningTeamId: 'claims', sensitivity: 'MEDICAL' }) }),
    );

    expect(
      d.allow === false && d.reason,
      'a CLAIMS grant dated to begin in the future satisfied the medical gate today',
    ).toBe('SENSITIVITY_SEGMENTATION');
  });

  it('and the same actor CAN read it once the role is live and in scope', () => {
    /**
     * The positive control for both cases above. Without it they are satisfied by a
     * `passesSensitivity` that returns false unconditionally — which would deny every
     * legitimate CLAIMS reader in the product and pass this file.
     */
    const proper = employee({
      teams: ['claims'],
      grants: [
        { role: 'AGENT', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST },
        { role: 'CLAIMS', actions: ['conversation.read'], scopeKind: 'TEAM', scopeId: 'claims', effectiveFrom: PAST },
      ],
    });

    const d = decide(
      ask({ actor: proper, resource: customerConversation({ owningTeamId: 'claims', sensitivity: 'MEDICAL' }) }),
    );
    expect(d.allow).toBe(true);
  });
});

describe('temporary cover and delegation', () => {
  it('a covering colleague acts under a time-boxed grant, not the owner’s identity', () => {
    const cover = employee({
      principalId: 'emp-cover',
      temporaryGrants: [
        {
          grantId: 'grant-1',
          capability: 'conversation.reply.customer',
          conversationId: 'conv-1',
          effectiveFrom: PAST,
          effectiveTo: FUTURE,
        },
      ],
    });
    const d = decide(ask({ actor: cover, action: 'conversation.reply.customer' }));
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('TEMPORARY_GRANT');
  });

  it('an expired cover grant stops working without any job having run', () => {
    const cover = employee({
      principalId: 'emp-cover',
      temporaryGrants: [
        {
          grantId: 'grant-1',
          capability: 'conversation.reply.customer',
          conversationId: 'conv-1',
          effectiveFrom: PAST,
          effectiveTo: EXPIRED,
        },
      ],
    });
    expect(decide(ask({ actor: cover, action: 'conversation.reply.customer' })).allow).toBe(false);
  });

  it('a cover grant for one conversation does not cover another', () => {
    const cover = employee({
      principalId: 'emp-cover',
      temporaryGrants: [
        {
          grantId: 'grant-1',
          capability: 'conversation.read',
          conversationId: 'conv-OTHER',
          effectiveFrom: PAST,
          effectiveTo: FUTURE,
        },
      ],
    });
    expect(decide(ask({ actor: cover })).allow).toBe(false);
  });
});

describe('customer isolation', () => {
  const customer = (over: Partial<ActorContext> = {}): ActorContext =>
    employee({ principalId: 'cust-1', kind: 'CUSTOMER', assurance: 'VERIFIED_CUSTOMER', teams: [], departments: [], ...over });

  it('a customer can never read an internal note, on any path', () => {
    const d = decide(
      ask({
        actor: customer(),
        action: 'conversation.read',
        targetVisibility: 'INTERNAL',
        resource: customerConversation({ belongsToActorCustomer: true }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('CUSTOMER_INTERNAL_CONTENT');
  });

  it('a customer cannot read another customer’s conversation', () => {
    const d = decide(ask({ actor: customer(), resource: customerConversation({ belongsToActorCustomer: false }) }));
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('CUSTOMER_NOT_OWNER_OF_RESOURCE');
  });

  it('a customer cannot reach employee-only actions', () => {
    for (const action of ['queue.read', 'directory.read', 'case.read', 'conversation.transfer', 'audit.query'] as const) {
      const d = decide(
        ask({ actor: customer(), action, resource: customerConversation({ belongsToActorCustomer: true }) }),
      );
      expect(d.allow, action).toBe(false);
      expect(d.allow === false && d.reason).toBe('CUSTOMER_ACTION_FORBIDDEN');
    }
  });

  it('an anonymous visitor cannot reach an action requiring verification', () => {
    const d = decide(
      ask({
        actor: customer({ assurance: 'ANONYMOUS' }),
        action: 'conversation.attachment.download',
        requiredAssurance: 'VERIFIED_CUSTOMER',
        resource: customerConversation({ belongsToActorCustomer: true }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toBe('CUSTOMER_INSUFFICIENT_ASSURANCE');
  });

  it('assurance requirements are per action, so a low bar still passes', () => {
    const d = decide(
      ask({
        actor: customer({ assurance: 'PSEUDONYMOUS' }),
        action: 'conversation.read',
        requiredAssurance: 'PSEUDONYMOUS',
        resource: customerConversation({ belongsToActorCustomer: true }),
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('CUSTOMER_OWN');
  });
});

describe('privileged marking drives audit', () => {
  it('marks refused privileged attempts so a probing burst is detectable', () => {
    const d = decide(ask({ action: 'privileged.customer.history.read' }));
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.privilegedAttempt).toBe(true);
  });

  it('does not mark ordinary participation as privileged', () => {
    const d = decide(
      ask({
        resource: customerConversation({
          participant: { role: 'PARTICIPANT', replyAuthority: false, effectiveFrom: PAST },
        }),
      }),
    );
    expect(d.allow === true && d.privileged).toBe(false);
  });
});
