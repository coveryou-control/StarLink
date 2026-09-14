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
 * `audit-read-only.test.ts` sweeps the whole action catalogue against what SUPERADMIN
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
  ],
  /**
   * The communication auditor. ONE account, read-only, company-wide.
   *
   * ## Why this role exists at all
   *
   * An insurer has to be able to answer "what was said" — to a regulator, to a grievance,
   * to a court. Until now that question had no answer inside StarLink: `COMPLIANCE` and
   * `LEGAL` hold `audit.query` and `privileged.customer.history.read`, which reach the
   * LEDGER and a customer's own history, and neither reaches an internal thread between
   * two colleagues.
   *
   * ## Why it is not an administrator
   *
   * FR-AUTHZ-7 — administration confers no read — is untouched, and this role is the reason
   * to be exact about what it says. It says that managing accounts, roles and channels does
   * not imply reading their content; it does not say content can never be read by anyone
   * but a participant. `privileged.conversation.read` has been in the action list since it
   * was written, is in `PRIVILEGED_ACTIONS`, and is audited on success AND on refusal
   * precisely so that a read of this kind is answerable for.
   *
   * So the auditor holds NO admin action. It cannot create an account, assign a role,
   * deactivate anybody or change a configuration value. It reads, and that is the whole of
   * it — which is also what keeps the two authorities separate: whoever runs the directory
   * cannot read the traffic, and whoever reads the traffic cannot change who is in it.
   *
   * ## Read-only is enforced by absence, not by a flag
   *
   * There is no `conversation.message.send` here, no reaction, no edit, no delete, no
   * forward, no participant change. `decide()` denies an unknown or ungranted action by
   * construction (property 1), so the read-only guarantee is the SHAPE of this list rather
   * than a check somebody could forget. `audit-read-only.test.ts` asserts it action by
   * action against the full catalogue, so a write added to this array fails the build.
   *
   * ## One account, and not self-service
   *
   * Nothing in the product grants this role. `admin.role.assign` explicitly refuses it —
   * see `admin.controller.ts` — so an ADMIN cannot make a second auditor, and an auditor
   * cannot make one either because it holds no admin action at all. It is issued out of
   * band by `seed-superadmin.mjs`, which refuses to create a second one.
   */
  SUPERADMIN: [
    /* The content read. This is the action that reaches an internal thread, and it is the
       only reason this role differs from COMPLIANCE. */
    'privileged.conversation.read',
    'privileged.customer.history.read',
    /* Attachments and voice notes are messages by another name — a file shared in a thread
       is part of what was said, and an audit that stops at the text is not an audit. */
    'conversation.attachment.download',
    /* The ledger itself: who accessed what, including this account's own reads. */
    'audit.query',
    /* Finding the conversation to read. Directory, search and queue are how an auditor
       gets from "this employee, this week" to a thread. Search is the one the brief asks
       for by name — company-wide message search — and it is the reason this role is useful
       rather than merely permitted: without it an audit is a list of conversations to open
       one at a time. None of the three discloses content on its own; what each result
       resolves to is decided per conversation by `decide()`. */
    'directory.read',
    'search.execute',
    'queue.read',
    'load.read',
    'case.read',
    /* The employee and role LISTS, which an audit has to be able to show — the same two
       reads `admin.controller.ts` already separates from their write counterparts, and the
       reason it separates them. */
    'admin.principal.read',
    'admin.role.read',
  ],
});

/**
 * Roles no API may grant, however privileged the caller.
 *
 * `SUPERADMIN` reads every conversation in the company. If `POST /admin/roles` could issue
 * it, then whoever holds `admin.role.assign` holds company-wide read as well — one request
 * away — and FR-AUTHZ-7 would be true of the action list and false of the system. The two
 * authorities have to be separable in practice, not only on paper.
 *
 * So it is issued out of band, by `seed-superadmin.mjs`, which runs against the database
 * with operator credentials and refuses to create a second one. That is deliberately
 * inconvenient: there is meant to be exactly one, and making another meant to require
 * somebody with production access rather than somebody with an admin session.
 *
 * A set rather than a single string because the next role of this kind — whatever it is —
 * should land here rather than beside a second bespoke check.
 */
export const OUT_OF_BAND_ROLES: ReadonlySet<string> = new Set(['SUPERADMIN']);

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
