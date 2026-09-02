/**
 * Maps IAM claims onto the authorization decision's actor context.
 *
 * A small, boring translation â€” but it is the ONLY place claims become an actor, so
 * every path through the system agrees on what a principal is allowed to be. If the API and the realtime
 * gateway built this differently, they would authorize differently.
 *
 * Note what is NOT here: no role-to-action expansion beyond the declared table below.
 * A role that grants nothing grants nothing (FR-AUTHZ-3).
 */
import type { Action } from './actions.js';
import type { ActorContext, ScopeGrant } from './decide.js';
import type { PrincipalClaims } from '@starlink/shared-contracts';

/**
 * What each role may do.
 *
 * Deliberately explicit and small enough to review in one sitting. The role catalogue
 * itself is D-11 and belongs to HR; these are development placeholders and are marked
 * as such in the seed data.
 *
 * Note that TEAM_LEAD does NOT include `conversation.read`: a lead does not read team
 * conversations by default, and oversight is a scoped, audited grant (BR-30, D-11).
 */
const ROLE_ACTIONS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  AGENT: [
    'conversation.read',
    /**
     * Renaming and reacting are ordinary participation, so every role that can be in a
     * conversation has them. The OBJECT check is what confines them to conversations the
     * person is actually in — a role grant is the wrong place to express "this thread",
     * and `decide()`'s participation rung is the right one.
     */
    'conversation.rename',
    'conversation.message.react',
    /**
     * UC-E10, verbatim: actor **Advisor**, "Claim from a queue", "Pull unassigned work",
     * P0 — and FR-ROUTE-4: "an unclaimed conversation is visibly waiting and never
     * silently held."
     *
     * `queue.read` was granted only to TEAM_LEAD, which made the pair incoherent: an
     * advisor could claim a conversation they had no way to see. SL-006's acceptance
     * criterion is "no invisible waiting", and it was invisible to precisely the people
     * expected to take it. Found on 2026-08-29 by the employee-journey test, which could
     * not get past its first step.
     *
     * Transcribed, not chosen — the same footing as BR-19's "or a lead" for resolve. Which
     * ROLES exist remains D-11's and HR's; what an advisor does with a queue is UC-E10's
     * and is written down.
     */
    'queue.read',
    'conversation.claim',
    'search.execute',
    'directory.read',
  ],
  TEAM_LEAD: [
    'conversation.rename',
    'conversation.message.react',
    /**
     * PLACEHOLDER, and the only entry in this table that is not transcribed from a document.
     *
     * Announcements are not in the architecture doc or the brief, so there is no sentence to
     * transcribe for "who may post one". A lead is the narrowest plausible answer and the
     * one that fails safe: too few people can post, which is visible and fixable, rather
     * than too many, which is not. It is recorded as an open question rather than settled
     * here, and it is a one-line change when HR answers it.
     */
    'conversation.announcement.post',
    'queue.read',
    'load.read',
    'directory.read',
    'conversation.assign',
    'conversation.transfer',
    /**
     * BR-19, verbatim: "Only the owner **or a lead** may resolve, and an outcome is
     * recorded." §21.4's `active → resolved` row names the same two actors, and so does
     * `resolved → active`.
     *
     * Transcribed rather than chosen, like `conversation.assign` and
     * `conversation.transfer` above — those came from §21.7–21.9 the same way. Without
     * them BR-19's second half is unimplementable: a lead resolving a conversation their
     * departed colleague owned would be refused by the authorization ladder, which is not
     * what the rule says. Which ROLES exist is still D-11's and HR's; what a lead may do
     * to a conversation is §11.5's and is written down.
     */
    'conversation.resolve',
    'conversation.reopen',
    'case.reprioritise',
  ],
  CLAIMS: ['conversation.read', 'conversation.claim', 'case.read'],
  GRIEVANCE: ['conversation.read', 'conversation.escalate', 'privileged.customer.history.read'],
  COMPLIANCE: ['audit.query', 'privileged.customer.history.read'],
  LEGAL: ['audit.query', 'privileged.customer.history.read'],
  ADMIN: [
    // Same placeholder as TEAM_LEAD's, and for the same reason: somebody has to be able to
    // post the first announcement in a workspace that has no leads yet.
    'conversation.announcement.post',
    'admin.account.manage',
    'admin.role.assign',
    'admin.principal.deactivate',
    'admin.config.manage',
    'admin.notification.replay',
    // The reads their write counterparts above already subsume. Without these two,
    // `GET /admin/accounts` and `GET /admin/roles/:principalId` refused even a full ADMIN.
    'admin.principal.read',
    'admin.role.read',
  ],
});

export function toActorContext(claims: PrincipalClaims): ActorContext {
  const grants: ScopeGrant[] = claims.roles.map((assignment) => ({
    role: assignment.role,
    actions: ROLE_ACTIONS[assignment.role] ?? [],
    scopeKind: assignment.scope.kind,
    ...(assignment.scope.id !== undefined ? { scopeId: assignment.scope.id } : {}),
    effectiveFrom: assignment.effectiveFrom,
    ...(assignment.effectiveTo !== undefined ? { effectiveTo: assignment.effectiveTo } : {}),
  }));

  return {
    principalId: claims.principalId,
    kind: 'EMPLOYEE',
    status: claims.status,
    teams: claims.teams.map((t) => t.teamId),
    departments: claims.department === '' ? [] : [claims.department],
    grants,
    delegations: claims.delegations.map((d) => ({
      delegationId: d.delegationId,
      capabilities: d.capabilities as readonly Action[],
      scopeKind: d.scope.kind,
      ...(d.scope.id !== undefined ? { scopeId: d.scope.id } : {}),
      effectiveFrom: d.effectiveFrom,
      effectiveTo: d.effectiveTo,
    })),
    // Temporary grants (cover, compliance access) are loaded per conversation by the
    // routing module in Phase 5; none exist yet.
    temporaryGrants: [],
  };
}
