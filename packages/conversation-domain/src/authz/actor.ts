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
/**
 * Exported so the read-only guarantee can be ASSERTED rather than described.
 *
 * `admin-audit.test.ts` sweeps the whole action catalogue against what ADMIN
 * actually holds; that sweep needs the list, and deriving it from the role assignment path
 * instead would test the derivation rather than the role.
 */
export const ROLE_ACTIONS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
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
    /**
     * PLACEHOLDER, on the same footing and for the same reason as the line above it.
     *
     * Channels are not in the architecture doc or the brief either, so there is no sentence
     * to transcribe for "who may open one". A lead is the narrowest plausible answer and the
     * one that fails safe: too few people can create a company space, which is visible and
     * fixable, rather than too many, which produces a directory full of near-duplicates
     * nobody can clean up. Recorded in STARLINK_OPEN_QUESTIONS.md; a one-line change when
     * HR answers it.
     *
     * Note what this does NOT grant: reading anything. `channel.manage` is administration,
     * and administration confers no read (FR-AUTHZ-7) - `decide()` refuses a channel's
     * content to a `channel.manage` holder who is not in it. The channel's own
     * administrators hold the same authority over their own room through their participant
     * role, which is the ordinary case; this is the company-wide version for whoever runs
     * the directory.
     */
    'channel.create',
    'channel.manage',
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
    /* Same placeholder again: somebody has to be able to open the first channel in a
       workspace that has no leads yet, and somebody has to be able to repair a channel
       whose last administrator has left the company. */
    'channel.create',
    'channel.manage',
    'admin.account.manage',
    'admin.role.assign',
    'admin.principal.deactivate',
    'admin.config.manage',
    'admin.notification.replay',
    // The reads their write counterparts above already subsume. Without these two,
    // `GET /admin/accounts` and `GET /admin/roles/:principalId` refused even a full ADMIN.
    'admin.principal.read',
    'admin.role.read',

    /*
       ## The communication audit, as a capability of THIS role

       An insurer has to be able to answer "what was said" — to a regulator, to a grievance,
       to a court. That answer now belongs to the organisation's administrator rather than
       to an account of its own: one ADMIN, holding its existing administrative authority
       and this in addition.

       ## What this does to FR-AUTHZ-7, exactly

       FR-AUTHZ-7 says administration confers no read, and the letter of it is intact: none
       of the `admin.*` actions above imply reading a conversation, `decide()`'s property 5
       still holds, and `channel.manage` still falls through for administration and never
       for content. What has changed is that this role ADDITIONALLY holds an explicit,
       separately-named, always-audited read action. The distinction matters and is worth
       being precise about: the read is granted by `privileged.conversation.read`, not
       inherited from managing accounts, so an operator who wants an administrator WITHOUT
       the audit removes this one line and the administration is untouched.

       The spirit of FR-AUTHZ-7 — that the two authorities be separable — is therefore
       preserved in the mechanism while the product has decided to combine them in the
       default role. That is a business decision and is recorded as one.

       ## Read-only is a property of the SURFACE, not of this role

       An administrator can obviously write; it is an administrator. So "the audit is
       read-only" cannot be enforced by the shape of this list the way it could for a
       dedicated role. It is enforced where it now has to be: `/v1/audit` has no handler
       that is not a `@Get`, and `audit-surface-is-read-only.test.ts` fails the build if one
       appears.
    */
    'privileged.conversation.read',
    'privileged.customer.history.read',
    /* Attachments, images and voice notes are messages by another name — a file shared in a
       thread is part of what was said, and an audit that stops at the text is not one. */
    'conversation.attachment.download',
    /* The ledger, including the administrator's own audit reads. */
    'audit.query',
    /* Finding the conversation to read. Search is the one the brief names — company-wide
       message search — and it is what makes the capability usable rather than merely
       present: without it an audit is a list of conversations to open one at a time. */
    'search.execute',
    /* The directory: departments, teams and who is in them. The audit has to be able to
       browse the organisation to get from "this team, last month" to a conversation, and
       a directory read discloses no message content on its own. */
    'directory.read',
    'queue.read',
    'load.read',
    'case.read',
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
