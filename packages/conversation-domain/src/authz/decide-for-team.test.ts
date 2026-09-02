/**
 * TEAM-scoped authorization (`decideForTeam`).
 *
 * ## The hole this closes
 *
 * `GET /queues/:teamId` and `/queues/:teamId/load` asked only "does this person hold
 * `queue.read` anywhere?". The `:teamId` in the path was never compared with anything the
 * caller belongs to, so every AGENT — the role UC-E10 gives `queue.read` to — could read
 * every team's waiting work and its per-person workload. No customer content is exposed by
 * those views, so this is the organisation's internal structure and staffing rather than a
 * content leak; §25.3 still treats that as its own thing worth scoping.
 *
 * ## What is under test
 *
 * That the SAME scope semantics `decide` already applies to a conversation apply here to a
 * team — nothing invented, nothing new in the permission vocabulary. The one deliberate
 * difference is `CONVERSATION` scope, which covers no queue at all, and it is the case most
 * worth pinning: a grant over one thread widening into "everything this team is waiting on"
 * would be rule 3 broken in a new shape.
 */
import { describe, expect, it } from 'vitest';

import { decideForTeam, type ActorContext, type ScopeGrant, type TeamContext } from './decide.js';

const NOW = '2026-08-30T12:00:00.000Z';
const YESTERDAY = '2026-08-29T12:00:00.000Z';
const TOMORROW = '2026-08-31T12:00:00.000Z';

const SERVICE_TEAM: TeamContext = { teamId: 'service-a', department: 'Service' };
const CLAIMS_TEAM: TeamContext = { teamId: 'claims-a', department: 'Claims' };

/**
 * Overrides that may explicitly say `undefined`.
 *
 * `Partial<ScopeGrant>` will not accept an explicit `undefined` under
 * `exactOptionalPropertyTypes`, and "no scope id at all" is a case these tests must be
 * able to express — it is one of the fail-closed paths.
 */
type GrantOverrides = { [K in keyof ScopeGrant]?: ScopeGrant[K] | undefined };

const grant = (over: GrantOverrides = {}): ScopeGrant => {
  // `in` rather than `??`, so passing `scopeId: undefined` means "none" instead of
  // falling back to the default — which would quietly turn a fail-closed case into a
  // passing one.
  const scopeId = 'scopeId' in over ? over.scopeId : 'service-a';
  return {
    role: over.role ?? 'AGENT',
    actions: over.actions ?? ['queue.read'],
    scopeKind: over.scopeKind ?? 'TEAM',
    ...(scopeId !== undefined ? { scopeId } : {}),
    effectiveFrom: over.effectiveFrom ?? YESTERDAY,
    ...(over.effectiveTo !== undefined ? { effectiveTo: over.effectiveTo } : {}),
  };
};

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: '018f2c5a-7d00-7000-8000-00000000000a',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: ['service-a'],
  departments: ['Service'],
  grants: [grant()],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

const may = (a: ActorContext, team: TeamContext, action = 'queue.read'): boolean =>
  decideForTeam({ actor: a, action, team, now: NOW }).allow;

describe('decideForTeam', () => {
  describe('TEAM scope', () => {
    it('allows a member reading their own team', () => {
      expect(may(actor(), SERVICE_TEAM)).toBe(true);
    });

    it('REFUSES the same person reading another team', () => {
      // The defect, stated plainly: same role, same permission, different team.
      expect(may(actor(), CLAIMS_TEAM)).toBe(false);
    });

    it('REFUSES a grant naming a team the actor does not belong to', () => {
      /**
       * Both halves are required, as in `scopeCovers`: the grant must name this team AND
       * the actor must be in it. A grant alone would let a stale role assignment outlive
       * the membership it was issued alongside.
       */
      expect(
        may(actor({ teams: [], grants: [grant({ scopeId: 'service-a' })] }), SERVICE_TEAM),
      ).toBe(false);
    });

    it('REFUSES a grant with no scope id at all', () => {
      // An absent attribute is absent, never a blank that matches another blank (§27.2).
      expect(may(actor({ grants: [grant({ scopeId: undefined })] }), SERVICE_TEAM)).toBe(false);
    });
  });

  describe('DEPARTMENT scope', () => {
    it('allows a department-wide grant over a team in that department', () => {
      expect(
        may(
          actor({ grants: [grant({ scopeKind: 'DEPARTMENT', scopeId: 'Service' })] }),
          SERVICE_TEAM,
        ),
      ).toBe(true);
    });

    it('REFUSES it over a team in another department', () => {
      expect(
        may(
          actor({ grants: [grant({ scopeKind: 'DEPARTMENT', scopeId: 'Service' })] }),
          CLAIMS_TEAM,
        ),
      ).toBe(false);
    });

    it('REFUSES when the team has no department recorded', () => {
      // Fail closed on a missing attribute rather than matching undefined to undefined.
      expect(
        may(
          actor({ grants: [grant({ scopeKind: 'DEPARTMENT', scopeId: 'Service' })] }),
          { teamId: 'service-a' },
        ),
      ).toBe(false);
    });

    it('REFUSES when the actor is not in that department', () => {
      expect(
        may(
          actor({
            departments: [],
            grants: [grant({ scopeKind: 'DEPARTMENT', scopeId: 'Service' })],
          }),
          SERVICE_TEAM,
        ),
      ).toBe(false);
    });
  });

  describe('GLOBAL scope', () => {
    it('covers any team', () => {
      const global = actor({ teams: [], grants: [grant({ scopeKind: 'GLOBAL', scopeId: undefined })] });
      expect(may(global, SERVICE_TEAM)).toBe(true);
      expect(may(global, CLAIMS_TEAM)).toBe(true);
    });
  });

  describe('CONVERSATION scope', () => {
    it('covers NO team, whatever it names', () => {
      /**
       * The case that must never fail open. Cover (§21.9) and compliance access are
       * conversation-scoped by design; if one of those widened into a team's queue, being
       * handed one thread would show you every customer that team is waiting on.
       *
       * Both spellings are checked — a grant naming the team id in a conversation-scoped
       * field, and one naming nothing — because the rejected alternative implementation
       * (making `conversationId` optional on `ResourceContext`) would have compared
       * `undefined === undefined` and allowed the second.
       */
      for (const scopeId of ['service-a', 'some-conversation-id', undefined]) {
        expect(
          may(actor({ grants: [grant({ scopeKind: 'CONVERSATION', scopeId })] }), SERVICE_TEAM),
          `CONVERSATION scope must not cover a queue (scopeId: ${String(scopeId)})`,
        ).toBe(false);
      }
    });
  });

  describe('the rungs shared with decide()', () => {
    it('denies an unknown action', () => {
      expect(
        decideForTeam({ actor: actor(), action: 'queue.summon', team: SERVICE_TEAM, now: NOW }),
      ).toMatchObject({ allow: false, reason: 'UNKNOWN_ACTION' });
    });

    it('denies an action the role does not carry, even on their own team', () => {
      // `queue.read` is not a skeleton key: holding it says nothing about other actions.
      expect(may(actor(), SERVICE_TEAM, 'conversation.transfer')).toBe(false);
    });

    it.each(['SUSPENDED', 'EXITED'] as const)('denies a %s principal', (status) => {
      expect(may(actor({ status }), SERVICE_TEAM)).toBe(false);
    });

    it('denies a customer by kind, before anything else', () => {
      expect(
        decideForTeam({
          actor: actor({ kind: 'CUSTOMER', assurance: 'VERIFIED_CUSTOMER' }),
          action: 'queue.read',
          team: SERVICE_TEAM,
          now: NOW,
        }),
      ).toMatchObject({ allow: false, reason: 'CUSTOMER_ACTION_FORBIDDEN' });
    });

    it('reads expiry from the clock', () => {
      expect(may(actor({ grants: [grant({ effectiveTo: YESTERDAY })] }), SERVICE_TEAM)).toBe(false);
      expect(may(actor({ grants: [grant({ effectiveFrom: TOMORROW })] }), SERVICE_TEAM)).toBe(false);
      expect(may(actor({ grants: [grant({ effectiveTo: TOMORROW })] }), SERVICE_TEAM)).toBe(true);
    });

    it('denies an actor with no grants at all', () => {
      expect(may(actor({ grants: [] }), SERVICE_TEAM)).toBe(false);
    });
  });

  describe('delegations', () => {
    it('are honoured with the same scope rules', () => {
      const delegated = actor({
        grants: [],
        delegations: [
          {
            delegationId: '018f2c5a-7d00-7000-8000-0000000000d1',
            capabilities: ['queue.read'],
            scopeKind: 'TEAM',
            scopeId: 'service-a',
            effectiveFrom: YESTERDAY,
            effectiveTo: TOMORROW,
          },
        ],
      });
      expect(may(delegated, SERVICE_TEAM)).toBe(true);
      expect(may(delegated, CLAIMS_TEAM)).toBe(false);
    });

    it('expire like everything else', () => {
      expect(
        may(
          actor({
            grants: [],
            delegations: [
              {
                delegationId: '018f2c5a-7d00-7000-8000-0000000000d2',
                capabilities: ['queue.read'],
                scopeKind: 'TEAM',
                scopeId: 'service-a',
                effectiveFrom: YESTERDAY,
                effectiveTo: YESTERDAY,
              },
            ],
          }),
          SERVICE_TEAM,
        ),
      ).toBe(false);
    });
  });
});
