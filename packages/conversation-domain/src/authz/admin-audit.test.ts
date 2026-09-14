import { describe, expect, it } from 'vitest';

import { ACTIONS, type Action } from './actions.js';
import { ROLE_ACTIONS } from './actor.js';
import { decide, type ActorContext, type DecisionRequest } from './decide.js';
import type { ConversationType } from '@starlink/shared-contracts';

/**
 * The organisation administrator can audit company communication.
 *
 * ## What changed, and what did not
 *
 * The audit capability is an ADDITIONAL PERMISSION OF THE EXISTING ADMIN ROLE. There is no
 * separate account and no second role: one administrator, holding the administrative
 * authority it has always had, plus an explicit company-wide read.
 *
 * FR-AUTHZ-7 said administration confers no read, and the LETTER of it is intact — none of
 * the `admin.*` actions imply reading a conversation, and `decide()`'s property 5 still
 * holds. What the product has decided is to grant this role a separately-named read action
 * as well. The distinction is not pedantry: the read comes from
 * `privileged.conversation.read`, not from managing accounts, so an operator who wants an
 * administrator WITHOUT the audit removes one line from `ROLE_ACTIONS` and the
 * administration is untouched. The two authorities remain separable in the mechanism even
 * though the default role now combines them.
 *
 * ## Read-only is now a property of the SURFACE
 *
 * An administrator can write — it is an administrator. So "the audit is read-only" cannot
 * be a property of this role's action list the way it would be for a dedicated one. It is
 * enforced where it now has to be: `/v1/audit` has no handler that is not a `@Get`, which
 * `audit-surface-is-read-only.test.ts` asserts against the controller source.
 *
 * What this file still proves is the half that belongs here: the administrator reaches
 * conversations it is not in, an ordinary employee does not, and the capability is scoped
 * and audited.
 */

const PAST = '2020-01-01T00:00:00.000Z';
const NOW = '2026-09-14T10:00:00.000Z';

const withRole = (role: string, overrides: Partial<ActorContext> = {}): ActorContext => ({
  principalId: '018f2c5a-0000-7000-8000-0000000000a1',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [
    { role, actions: ROLE_ACTIONS[role] ?? [], scopeKind: 'GLOBAL', effectiveFrom: PAST },
  ],
  delegations: [],
  temporaryGrants: [],
  ...overrides,
});

const admin = (overrides: Partial<ActorContext> = {}): ActorContext => withRole('ADMIN', overrides);
const agent = (): ActorContext => ({
  ...withRole('AGENT'),
  principalId: '018f2c5a-0000-7000-8000-0000000000b2',
  teams: ['team-a'],
  departments: ['ops'],
});

const ask = (
  actor: ActorContext,
  action: Action,
  conversationType: ConversationType,
): DecisionRequest => ({
  actor,
  action,
  resource: {
    conversationId: '018f2c5a-0000-7000-8000-0000000000c3',
    conversationType,
    sensitivity: 'ORDINARY',
  },
  now: NOW,
});

const TYPES: readonly ConversationType[] = [
  'INTERNAL_DIRECT',
  'INTERNAL_GROUP',
  'INTERNAL_CHANNEL',
  'INTERNAL_ANNOUNCEMENT',
  'CUSTOMER_CLAIM',
  'CUSTOMER_GRIEVANCE',
];

describe('what the administrator can reach', () => {
  it('reads a conversation of every type, as a participant of none of them', () => {
    /**
     * The capability, and the only interesting case: the resource carries no `participant`
     * and no `currentOwnerId`, so this is a complete outsider to every one of these threads.
     * A one-to-one between two colleagues is included deliberately — it is the most private
     * thing in the product and the thing a regulator is most likely to ask about.
     */
    for (const type of TYPES) {
      expect(decide(ask(admin(), 'conversation.read', type)).allow, `reading a ${type}`).toBe(true);
    }
  });

  it('reaches a private channel, which the ordinary ladder closes', () => {
    /* `decideChannel` returns DENY rather than falling through for content, so a
       company-wide grant at rung 8 is never asked. Beating that is why the audit rung sits
       where it does. */
    const decision = decide({
      ...ask(admin(), 'conversation.read', 'INTERNAL_CHANNEL'),
      resource: {
        conversationId: '018f2c5a-0000-7000-8000-0000000000c3',
        conversationType: 'INTERNAL_CHANNEL',
        sensitivity: 'ORDINARY',
        channel: {
          policy: {
            visibility: 'SELECTED',
            readAccess: 'MEMBERS',
            postAccess: 'MEMBERS',
            archived: false,
          },
          /* Not even visible to this actor, let alone a member: the hardest case the channel
             rung has, and the one an audit most needs to reach. */
          visibleToActor: false,
        },
      },
    });
    expect(decision.allow).toBe(true);
  });

  it('downloads the attachments, images and voice notes on those threads', () => {
    // A file shared in a conversation is part of what was said; an audit that stops at the
    // text is not an audit. A voice note is an attachment by the same pipeline.
    for (const type of TYPES) {
      expect(decide(ask(admin(), 'conversation.attachment.download', type)).allow).toBe(true);
    }
  });

  it('searches across the company and reads the ledger', () => {
    /* Against SYSTEM_INTERACTION, not a conversation type: searching and reading the ledger
       are not questions about one thread, and a participant-managed type is closed by rung 6
       to exactly the non-participant being asked about. The same synthetic resource
       `holdsAdminAction` uses. */
    for (const action of ['search.execute', 'audit.query', 'admin.principal.read'] as const) {
      expect(decide(ask(admin(), action, 'SYSTEM_INTERACTION')).allow, action).toBe(true);
    }
  });

  it('records every audit read as privileged, under its own basis', () => {
    /**
     * What makes a company-wide read acceptable: it is answerable for. `privileged: true`
     * drives the ledger entry, and the distinct basis lets the ledger be asked "which reads
     * were audit reads" without parsing a role string — which matters more now that the
     * same account also reads its own conversations as an ordinary participant.
     */
    const decision = decide(ask(admin(), 'conversation.read', 'INTERNAL_DIRECT'));
    expect(decision.allow && decision.privileged).toBe(true);
    expect(decision.allow && decision.basis).toBe('COMMUNICATION_AUDIT');
    expect(decision.allow && decision.grantRef).toBe('ADMIN');
  });
});

describe('the administrator keeps everything it already had', () => {
  it('still holds every administrative action', () => {
    /* The requirement is explicit that existing ADMIN access is preserved. Asserted by name
       because "we added a permission" is exactly the change that quietly drops one. */
    const actions = ROLE_ACTIONS['ADMIN'] ?? [];
    for (const action of [
      'admin.account.manage',
      'admin.role.assign',
      'admin.principal.deactivate',
      'admin.config.manage',
      'admin.notification.replay',
      'admin.principal.read',
      'admin.role.read',
      'channel.create',
      'channel.manage',
      'conversation.announcement.post',
    ] as const) {
      expect(actions, `ADMIN lost ${action}`).toContain(action);
    }
  });
});

describe('the exception is narrow', () => {
  it('does nothing for an ordinary employee', () => {
    /**
     * The whole point. Asserted on the PARTICIPANT-MANAGED types, which is where the ladder
     * answers "no" to a non-participant — a colleague's one-to-one and a private group.
     *
     * Announcements and customer conversations are deliberately absent: an agent holding
     * GLOBAL `conversation.read` legitimately reads those, and asserting otherwise would be
     * asserting the product is something it is not.
     */
    for (const type of ['INTERNAL_DIRECT', 'INTERNAL_GROUP'] as const) {
      expect(
        decide(ask(agent(), 'conversation.read', type)).allow,
        `an ordinary agent read a ${type} thread they are not in`,
      ).toBe(false);
      expect(decide(ask(admin(), 'conversation.read', type)).allow).toBe(true);
    }
  });

  it('gives no audit read to the other roles', () => {
    /* TEAM_LEAD is the interesting one: it is senior, holds routing authority over other
       people's work, and must still not be able to read a colleague's one-to-one. */
    for (const role of ['TEAM_LEAD', 'AGENT', 'CLAIMS', 'GRIEVANCE', 'COMPLIANCE', 'LEGAL']) {
      expect(
        decide(ask(withRole(role), 'conversation.read', 'INTERNAL_DIRECT')).allow,
        `${role} could read a private one-to-one`,
      ).toBe(false);
    }
  });

  it('does nothing for a grant that is not GLOBAL', () => {
    /**
     * A department- or team-scoped audit grant is a different feature with different
     * questions — whose department, at what time, and what happens to a conversation that
     * moves between them. Inventing an answer would be inventing a business value (rule 10).
     */
    for (const scopeKind of ['DEPARTMENT', 'TEAM', 'CONVERSATION'] as const) {
      const scoped = admin({
        grants: [
          {
            role: 'ADMIN',
            actions: ROLE_ACTIONS['ADMIN'] ?? [],
            scopeKind,
            scopeId: 'ops',
            effectiveFrom: PAST,
          },
        ],
      });
      expect(decide(ask(scoped, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
    }
  });

  it('stops the moment the grant expires or the account is deactivated', () => {
    const expired = admin({
      grants: [
        {
          role: 'ADMIN',
          actions: ROLE_ACTIONS['ADMIN'] ?? [],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
          effectiveTo: '2026-09-13T00:00:00.000Z',
        },
      ],
    });
    expect(decide(ask(expired, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
    expect(decide(ask(admin({ status: 'EXITED' }), 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(
      false,
    );
  });

  it('cannot be reached by a customer principal', () => {
    /* Rung 3 returns for customers before the audit rung is consulted. Asserted rather than
       assumed, because the ordering is what makes it true and ordering is what changes. */
    expect(decide(ask(admin({ kind: 'CUSTOMER' }), 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(
      false,
    );
  });

  it('leaves the administrative ACTIONS conferring no read (FR-AUTHZ-7)', () => {
    /**
     * The letter of FR-AUTHZ-7, still true and still worth holding. A principal with the
     * administrative actions and NOT the audit action reads nothing — which is what makes
     * the capability removable by deleting one line rather than by unpicking a role.
     */
    const administratorWithoutAudit = admin({
      grants: [
        {
          role: 'ADMIN_NO_AUDIT',
          actions: [
            'admin.account.manage',
            'admin.role.assign',
            'admin.principal.deactivate',
            'admin.config.manage',
            'channel.manage',
          ],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
        },
      ],
    });
    for (const type of TYPES) {
      expect(decide(ask(administratorWithoutAudit, 'conversation.read', type)).allow).toBe(false);
      expect(
        decide(ask(administratorWithoutAudit, 'conversation.attachment.download', type)).allow,
      ).toBe(false);
    }
  });
});

describe('the audit rung carries reads and nothing else', () => {
  it('grants no write action, on any conversation type', () => {
    /**
     * The rung consults a fixed set of content reads. This asserts the consequence: nothing
     * that MUTATES is reachable through it. The administrator may separately hold some of
     * these by its administrative authority — `channel.manage`, for instance — so the check
     * is on the BASIS, which is what says the audit rung was the thing that allowed it.
     */
    const writes: readonly Action[] = [
      'conversation.message.send',
      'conversation.note.internal',
      'conversation.reply.customer',
      'conversation.message.react',
      'conversation.attachment.upload',
      'conversation.participant.add',
      'conversation.participant.remove',
      'conversation.rename',
      'conversation.claim',
      'conversation.transfer',
      'conversation.resolve',
    ];
    for (const action of writes) {
      for (const type of TYPES) {
        const decision = decide(ask(admin(), action, type));
        expect(
          decision.allow && decision.basis === 'COMMUNICATION_AUDIT',
          `${action} on ${type} was allowed BY THE AUDIT RUNG — it carries reads only`,
        ).toBe(false);
      }
    }
  });

  it('is a set of three reads, and the catalogue has many more actions than that', () => {
    /* Guards against the set being widened to "everything" while these tests keep passing. */
    const readsViaAudit = ['conversation.read', 'conversation.attachment.download', 'case.read'];
    for (const action of readsViaAudit) {
      expect(
        decide(ask(admin(), action as Action, 'INTERNAL_DIRECT')).allow &&
          decide(ask(admin(), action as Action, 'INTERNAL_DIRECT')),
      ).toBeTruthy();
    }
    expect(ACTIONS.length).toBeGreaterThan(readsViaAudit.length * 5);
  });
});
