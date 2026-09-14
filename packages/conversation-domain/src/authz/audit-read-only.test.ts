import { describe, expect, it } from 'vitest';

import { ACTIONS, type Action } from './actions.js';
import { ROLE_ACTIONS } from './actor.js';
import { decide, type ActorContext, type DecisionRequest } from './decide.js';
import type { ConversationType } from '@starlink/shared-contracts';

/**
 * The communication auditor: reads everything, changes nothing.
 *
 * ## Why this file exists separately from `decide.test.ts`
 *
 * Because the interesting assertion is not a case, it is a SWEEP. "Read-only" is a claim
 * about every action in the product, including the ones added next month, and a test that
 * lists the writes it happens to think of is a test that goes stale the first time somebody
 * adds an action. So the negative half below iterates the whole catalogue.
 *
 * This is the one role in StarLink that can read a conversation it is not in. That is a
 * deliberate, narrow exception — an insurer has to be able to answer "what was said" to a
 * regulator — and the exception is worth exactly as much as the guarantee beside it.
 */

const PAST = '2020-01-01T00:00:00.000Z';
const NOW = '2026-09-14T10:00:00.000Z';

const auditor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  principalId: '018f2c5a-0000-7000-8000-0000000000a1',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [
    {
      role: 'SUPERADMIN',
      actions: ROLE_ACTIONS['SUPERADMIN'] ?? [],
      scopeKind: 'GLOBAL',
      effectiveFrom: PAST,
    },
  ],
  delegations: [],
  temporaryGrants: [],
  ...overrides,
});

/** An ordinary agent, holding nothing at all. */
const agent = (): ActorContext => ({
  principalId: '018f2c5a-0000-7000-8000-0000000000b2',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: ['team-a'],
  departments: ['ops'],
  grants: [{ role: 'AGENT', actions: ROLE_ACTIONS['AGENT'] ?? [], scopeKind: 'GLOBAL', effectiveFrom: PAST }],
  delegations: [],
  temporaryGrants: [],
});

const ask = (
  actor: ActorContext,
  action: Action,
  conversationType: DecisionRequest['resource']['conversationType'],
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

describe('what the auditor can reach', () => {
  it('reads a conversation of every type, as a participant of none of them', () => {
    /**
     * The capability the role exists for. Note the resource carries no `participant` and no
     * `currentOwnerId` — this is a complete outsider to every one of these threads, which
     * is the only interesting case. A one-to-one between two colleagues is included
     * deliberately: it is the most private thing in the product and the thing a regulator
     * is most likely to ask about.
     */
    for (const type of TYPES) {
      const decision = decide(ask(auditor(), 'conversation.read', type));
      expect(decision.allow, `an auditor could not read an ${type} conversation`).toBe(true);
    }
  });

  it('reaches a private channel, which the ordinary ladder closes', () => {
    /**
     * The reason rung 3a exists at all. `decideChannel` returns DENY rather than falling
     * through for content, so a company-wide grant at rung 8 never gets asked — which is
     * correct for everybody else and is the case this role has to beat.
     */
    const decision = decide({
      ...ask(auditor(), 'conversation.read', 'INTERNAL_CHANNEL'),
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
          /* Not even visible to this actor, let alone a member. The hardest case the
             channel rung has, and the one an audit most needs to reach. */
          visibleToActor: false,
        },
      },
    });
    expect(decision.allow).toBe(true);
  });

  it('downloads the attachments and voice notes on those threads', () => {
    // A file shared in a conversation is part of what was said. An audit that stops at the
    // text is not an audit, and a voice note is an attachment by the same pipeline.
    for (const type of TYPES) {
      expect(decide(ask(auditor(), 'conversation.attachment.download', type)).allow).toBe(true);
    }
  });

  it('records every one of those reads as privileged', () => {
    /**
     * The property that makes a company-wide read acceptable: it is answerable for. The
     * decision carries `privileged: true`, which is what drives the audit ledger entry, and
     * a distinct basis so the ledger can be asked "which reads were audit reads" without
     * parsing a role string.
     */
    const decision = decide(ask(auditor(), 'conversation.read', 'INTERNAL_DIRECT'));
    expect(decision.allow && decision.privileged).toBe(true);
    expect(decision.allow && decision.basis).toBe('COMMUNICATION_AUDIT');
    expect(decision.allow && decision.grantRef).toBe('SUPERADMIN');
  });
});

describe('what the auditor cannot do — the whole catalogue, swept', () => {
  /**
   * Every action the product has, minus the reads this role is granted. Derived rather than
   * listed, so an action added next month is covered the day it is added — a hand-written
   * list of writes is a list that goes stale silently, which is the failure mode this sweep
   * exists to prevent.
   */
  const granted = new Set<string>(ROLE_ACTIONS['SUPERADMIN'] ?? []);
  /*
     What rung 3a hands over on top of the role's own list.

     The role does NOT list `conversation.read`; it lists `privileged.conversation.read`,
     and the rung translates that into the three content reads. So the sweep has to exclude
     those three as well, or it asserts that the auditor cannot do the thing it exists to do.
  */
  const viaAuditRung = ['conversation.read', 'conversation.attachment.download', 'case.read'];
  const notGranted = ACTIONS.filter(
    (action) => !granted.has(action) && !viaAuditRung.includes(action),
  );

  it('is refused every action it was not granted, on every conversation type', () => {
    expect(notGranted.length).toBeGreaterThan(20);
    for (const action of notGranted) {
      for (const type of TYPES) {
        const decision = decide(ask(auditor(), action, type));
        expect(
          decision.allow,
          `an auditor was allowed "${action}" on an ${type} conversation — this role is read-only`,
        ).toBe(false);
      }
    }
  });

  it('names the writes explicitly, so the sweep above cannot pass vacuously', () => {
    /**
     * The sweep is only as good as its input: if `ROLE_ACTIONS.SUPERADMIN` ever grew to
     * include everything, `notGranted` would be empty and the loop would assert nothing.
     * These are the acts the brief rules out by name, checked directly.
     */
    const forbidden: readonly Action[] = [
      'conversation.message.send',
      'conversation.note.internal',
      'conversation.reply.customer',
      'conversation.message.react',
      'conversation.announcement.post',
      'conversation.attachment.upload',
      'conversation.participant.add',
      'conversation.participant.remove',
      'conversation.rename',
      'conversation.claim',
      'conversation.assign',
      'conversation.transfer',
      'conversation.resolve',
      'conversation.reopen',
      'channel.create',
      'channel.manage',
    ];
    for (const action of forbidden) {
      expect(granted.has(action), `SUPERADMIN must not hold ${action}`).toBe(false);
      for (const type of TYPES) {
        expect(decide(ask(auditor(), action, type)).allow, `${action} on ${type}`).toBe(false);
      }
    }
  });

  it('holds no administrative authority, so it cannot make a second auditor', () => {
    /**
     * The separation that keeps this account from being a way around everything else:
     * whoever reads the traffic cannot change who is in it, and cannot grant this role to
     * anybody — including to themselves a second time.
     */
    for (const action of [
      'admin.account.manage',
      'admin.role.assign',
      'admin.principal.deactivate',
      'admin.config.manage',
      'admin.notification.replay',
    ] as const) {
      expect(granted.has(action), `SUPERADMIN must not hold ${action}`).toBe(false);
    }
  });
});

describe('the exception is narrow', () => {
  it('does nothing for an ordinary employee', () => {
    /**
     * The whole point: every other employee meets the ordinary ladder, unchanged.
     *
     * Asserted on the PARTICIPANT-MANAGED types, which is where the ladder's answer is
     * 
o\ for a non-participant — a colleague's one-to-one and a private group are the
     * things this role exists to be able to reach and everybody else does not.
     *
     * Announcements and customer conversations are deliberately NOT in this list. An agent
     * holding GLOBAL `conversation.read` legitimately reads those: an announcement is
     * company-wide by construction, and a customer conversation is queue work somebody has
     * to be able to pick up. Asserting \denied\ there would be asserting the product is
     * something it is not.
     */
    for (const type of ['INTERNAL_DIRECT', 'INTERNAL_GROUP'] as const) {
      expect(
        decide(ask(agent(), 'conversation.read', type)).allow,
        `an ordinary agent could read an ${type} thread they are not in`,
      ).toBe(false);
    }
    // And the auditor can, which is the difference this role makes.
    for (const type of ['INTERNAL_DIRECT', 'INTERNAL_GROUP'] as const) {
      expect(decide(ask(auditor(), 'conversation.read', type)).allow).toBe(true);
    }
  });

  it('does nothing for a grant that is not GLOBAL', () => {
    /**
     * A department- or team-scoped audit grant is a different feature with different
     * questions — whose department, at what time, and what happens to a conversation that
     * moves between them. Inventing an answer would be inventing a business value
     * (rule 10), so narrower scopes simply do not match.
     */
    for (const scopeKind of ['DEPARTMENT', 'TEAM', 'CONVERSATION'] as const) {
      const scoped = auditor({
        grants: [
          {
            role: 'SUPERADMIN',
            actions: ROLE_ACTIONS['SUPERADMIN'] ?? [],
            scopeKind,
            scopeId: 'ops',
            effectiveFrom: PAST,
          },
        ],
      });
      expect(decide(ask(scoped, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
    }
  });

  it('stops the moment the grant expires', () => {
    // Read from the clock, like every other period in this module: no sweep's failure
    // extends it, and revoking is a matter of setting a date rather than of a job running.
    const expired = auditor({
      grants: [
        {
          role: 'SUPERADMIN',
          actions: ROLE_ACTIONS['SUPERADMIN'] ?? [],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
          effectiveTo: '2026-09-13T00:00:00.000Z',
        },
      ],
    });
    expect(decide(ask(expired, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
  });

  it('stops the moment the account is deactivated', () => {
    const gone = auditor({ status: 'EXITED' });
    expect(decide(ask(gone, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
  });

  it('cannot be reached by a customer principal', () => {
    /* Rung 3 returns for customers before this rung is consulted. Asserted rather than
       assumed, because the ordering is what makes it true and ordering is what changes. */
    const customer = auditor({ kind: 'CUSTOMER' });
    expect(decide(ask(customer, 'conversation.read', 'INTERNAL_DIRECT')).allow).toBe(false);
  });

  it('leaves administration conferring no read (FR-AUTHZ-7)', () => {
    /**
     * The requirement this role is most easily confused with. An ADMIN manages accounts,
     * roles, channels and configuration — and still cannot read a conversation. The two
     * authorities are separate on purpose: whoever runs the directory cannot read the
     * traffic, and whoever reads the traffic cannot change the directory.
     */
    const admin = auditor({
      grants: [
        { role: 'ADMIN', actions: ROLE_ACTIONS['ADMIN'] ?? [], scopeKind: 'GLOBAL', effectiveFrom: PAST },
      ],
    });
    for (const type of TYPES) {
      expect(decide(ask(admin, 'conversation.read', type)).allow).toBe(false);
      expect(decide(ask(admin, 'conversation.attachment.download', type)).allow).toBe(false);
    }
  });
});
