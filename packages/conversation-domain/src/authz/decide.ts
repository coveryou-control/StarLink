/**
 * THE authorization decision (ADR-009, doc §18.4 step 3, §26.3, §27.9).
 *
 * One function, one call pattern, small enough to review properly. Every content path
 * in StarLink routes through it. The properties it exists to guarantee:
 *
 *   1. An unknown action is denied, never treated as unrestricted.
 *   2. Participation grants THAT conversation and nothing else — the defect class that
 *      produces "any authenticated user can read anything" (doc §38, ADR-007).
 *   3. Participation is not ownership: being added grants reading and internal notes,
 *      not replying to the customer, reassigning, or closing (P-03).
 *   4. Expiry is read from the clock, so no sweep job's failure extends access.
 *   5. Administration confers no read (FR-AUTHZ-7).
 *   6. A customer principal is denied explicitly, by kind, at the operation layer.
 *   7. "Not permitted" and "does not exist" are indistinguishable to the caller.
 *
 * The function is pure: callers load the context, this decides. That is what makes the
 * authorization matrix testable as a table rather than through HTTP.
 */
import type {
  Assurance,
  ConversationType,
  MessageVisibility,
  PrincipalKind,
  SensitivityClass,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import { ASSURANCE_RANK } from '@starlink/shared-contracts';
import { CUSTOMER_PERMITTED_ACTIONS, PRIVILEGED_ACTIONS, isKnownAction, type Action } from './actions.js';

export interface ScopeGrant {
  readonly role: string;
  readonly actions: readonly Action[];
  readonly scopeKind: 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION';
  readonly scopeId?: string;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
}

export interface DelegationGrant {
  readonly delegationId: UUID;
  readonly capabilities: readonly Action[];
  readonly scopeKind: 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION';
  readonly scopeId?: string;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo: Timestamp;
}

export interface TemporaryGrant {
  readonly grantId: UUID;
  readonly capability: Action;
  readonly conversationId?: UUID;
  readonly caseId?: UUID;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo: Timestamp;
}

export interface ParticipantFacts {
  readonly role: string;
  /** Whether this participant may address the customer directly (D-04a: owner-only by default). */
  readonly replyAuthority: boolean;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
}

export interface ActorContext {
  readonly principalId: UUID;
  readonly kind: PrincipalKind;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'EXITED';
  readonly teams: readonly string[];
  readonly departments: readonly string[];
  readonly grants: readonly ScopeGrant[];
  readonly delegations: readonly DelegationGrant[];
  readonly temporaryGrants: readonly TemporaryGrant[];
  /** Customer principals only; employees are undefined. */
  readonly assurance?: Assurance;
}

export interface ResourceContext {
  readonly conversationId: UUID;
  readonly conversationType: ConversationType;
  readonly caseId?: UUID;
  readonly owningTeamId?: string;
  readonly owningDepartment?: string;
  readonly currentOwnerId?: UUID;
  readonly customerRef?: string;
  readonly sensitivity: SensitivityClass;
  /** The actor's participation in THIS conversation, if any. */
  readonly participant?: ParticipantFacts;
  /** For customer principals: does this conversation belong to this customer? */
  readonly belongsToActorCustomer?: boolean;
  /** Verification instant of the customer session that created the conversation. */
  readonly customerVerifiedAt?: Timestamp;
}

export interface DecisionRequest {
  readonly actor: ActorContext;
  readonly action: string;
  readonly resource: ResourceContext;
  readonly now: Timestamp;
  /** Minimum assurance the calling operation declares for customer principals. */
  readonly requiredAssurance?: Assurance;
  readonly targetVisibility?: MessageVisibility;
}

export type DenyReason =
  | 'UNKNOWN_ACTION'
  | 'PRINCIPAL_INACTIVE'
  | 'CUSTOMER_ACTION_FORBIDDEN'
  | 'CUSTOMER_NOT_OWNER_OF_RESOURCE'
  | 'CUSTOMER_INSUFFICIENT_ASSURANCE'
  | 'CUSTOMER_INTERNAL_CONTENT'
  | 'CUSTOMER_PRE_VERIFICATION_HISTORY'
  | 'NOT_PARTICIPANT_NO_SCOPE'
  | 'PARTICIPATION_DOES_NOT_GRANT_ACTION'
  | 'SENSITIVITY_SEGMENTATION'
  | 'NO_MATCHING_GRANT';

export type Decision =
  | {
      readonly allow: true;
      /** Why it was allowed — drives the audit record for privileged access. */
      readonly basis: 'PARTICIPANT' | 'OWNER' | 'SCOPE_GRANT' | 'DELEGATION' | 'TEMPORARY_GRANT' | 'CUSTOMER_OWN';
      readonly privileged: boolean;
      readonly grantRef?: string;
    }
  | {
      readonly allow: false;
      /**
       * Internal only. The HTTP layer returns one uniform response for every deny so
       * that "you may not" and "it does not exist" are indistinguishable (§27.3);
       * this reason exists for logs, audit and tests, never for the caller.
       */
      readonly reason: DenyReason;
      readonly privilegedAttempt: boolean;
    };

const isWithinPeriod = (now: string, from: string, to?: string): boolean =>
  from <= now && (to === undefined || to > now);

const scopeCovers = (
  scopeKind: 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION',
  scopeId: string | undefined,
  actor: ActorContext,
  resource: ResourceContext,
): boolean => {
  switch (scopeKind) {
    case 'GLOBAL':
      return true;
    case 'DEPARTMENT':
      // An absent attribute is absent, never blank — a blank must not match a blank
      // and thereby grant something (doc §27.2).
      return (
        scopeId !== undefined &&
        resource.owningDepartment !== undefined &&
        scopeId === resource.owningDepartment &&
        actor.departments.includes(scopeId)
      );
    case 'TEAM':
      return (
        scopeId !== undefined &&
        resource.owningTeamId !== undefined &&
        scopeId === resource.owningTeamId &&
        actor.teams.includes(scopeId)
      );
    case 'CONVERSATION':
      return scopeId === resource.conversationId;
  }
};

/**
 * Sensitivity segmentation (brief §9).
 *
 * Holding a team-wide read does not imply reading restricted medical or legal detail;
 * that requires an explicitly sensitivity-bearing role. Participants and the current
 * owner are unaffected — they are already inside the conversation.
 */
const SENSITIVITY_ROLES: Readonly<Record<SensitivityClass, readonly string[]>> = Object.freeze({
  ORDINARY: [],
  FINANCIAL: ['FINANCE', 'CLAIMS', 'COMPLIANCE', 'LEGAL'],
  MEDICAL: ['CLAIMS', 'COMPLIANCE', 'LEGAL'],
  LEGAL: ['LEGAL', 'COMPLIANCE'],
  GRIEVANCE: ['GRIEVANCE', 'COMPLIANCE', 'LEGAL'],
});

/**
 * The sensitivity-bearing grant must be one the actor actually holds, HERE and NOW.
 *
 * ## The bypass this closes
 *
 * This used to match on `g.role` alone — the role's NAME, anywhere in `actor.grants`, with
 * neither of the two tests every other rung applies. So the gate that withholds restricted
 * medical, legal and grievance detail was satisfied by:
 *
 *   * a `CLAIMS` grant scoped to a DIFFERENT team, while the read itself was authorised by
 *     an unrelated grant that did cover the conversation; and
 *   * a `CLAIMS` grant that has EXPIRED or has not STARTED — `loadRoles` filtered
 *     `effectiveTo` and never `effectiveFrom`, so a role dated to begin next year was in
 *     `grants` today. (That half is fixed in the adapter; this half is fixed here, because
 *     an authorization rule must not depend on an adapter's diligence.)
 *
 * An advisor who moved out of Claims a year ago, or who is scheduled to move into it, could
 * therefore read the medical detail of any conversation their ordinary team scope reached.
 * Then — because claiming is permitted on what you can read — take ownership, at which
 * point the OWNER rung skips sensitivity entirely and the access becomes permanent.
 *
 * The fix is to ask the same question of the sensitivity grant that rungs 7 and 8 ask of
 * the grant doing the authorising: is it live, and does its scope cover THIS resource.
 *
 * ## What is deliberately NOT changed here
 *
 * Rung 6 (temporary grants) still does not consult this function. A temporary grant is
 * time-boxed and pinned to one conversation or case, which is a different kind of thing
 * from a standing role×scope grant, and whether cover should carry sensitivity with it is
 * a cover-semantics question nobody has been asked. Left as it is, and named, rather than
 * tightened on a guess — see `STARLINK_OPEN_QUESTIONS.md`.
 */
const passesSensitivity = (
  actor: ActorContext,
  resource: ResourceContext,
  now: string,
): boolean => {
  const required = SENSITIVITY_ROLES[resource.sensitivity];
  if (required.length === 0) return true;
  return actor.grants.some(
    (g) =>
      required.includes(g.role) &&
      isWithinPeriod(now, g.effectiveFrom, g.effectiveTo) &&
      scopeCovers(g.scopeKind, g.scopeId, actor, resource),
  );
};

/**
 * The subject of a TEAM-scoped decision: a queue, not a conversation.
 *
 * `department` is optional because a team may have none recorded, and an absent attribute
 * must stay absent rather than becoming a blank that matches another blank (§27.2).
 */
export interface TeamContext {
  readonly teamId: string;
  readonly department?: string;
}

export interface TeamDecisionRequest {
  readonly actor: ActorContext;
  readonly action: string;
  readonly team: TeamContext;
  readonly now: Timestamp;
}

/**
 * Does a grant's scope cover THIS TEAM?
 *
 * The same four scope kinds and the same membership requirement as `scopeCovers`, applied
 * to a team instead of a conversation. Deliberately a sibling rather than a parameter of
 * the original: the two differ on `CONVERSATION`, and the difference is the whole point.
 */
const teamScopeCovers = (
  scopeKind: 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION',
  scopeId: string | undefined,
  actor: ActorContext,
  team: TeamContext,
): boolean => {
  switch (scopeKind) {
    case 'GLOBAL':
      return true;
    case 'DEPARTMENT':
      return (
        scopeId !== undefined &&
        team.department !== undefined &&
        scopeId === team.department &&
        actor.departments.includes(scopeId)
      );
    case 'TEAM':
      return scopeId !== undefined && scopeId === team.teamId && actor.teams.includes(scopeId);
    case 'CONVERSATION':
      /**
       * A grant over ONE conversation says nothing about a team's queue.
       *
       * Returning false rather than comparing ids is the fail-closed direction and the
       * correct meaning: being given access to a single thread — cover, a compliance
       * read — must never widen into seeing everything that team is waiting on. This is
       * rule 3 ("participation grants that conversation and nothing else") in its
       * scope-shaped form.
       */
      return false;
  }
};

/**
 * Authorization for something that belongs to a TEAM rather than to a conversation.
 *
 * ## Why this exists
 *
 * `GET /queues/:teamId` and `/queues/:teamId/load` were gated on a permission-only check
 * that ran `decide()` against a fabricated resource — the caller's own principal id as
 * `conversationId`, no owning team, an asserted `ORDINARY` sensitivity. Two consequences:
 * a TEAM-scoped grant could never match anything (so fixtures granted GLOBAL, hiding it),
 * and the path teamId was never compared with the caller's teams at all. Any employee
 * holding `queue.read` could read any team's queue and its per-person workload.
 *
 * ## Why it is a new function and not a new permission
 *
 * Nothing here is invented. The action vocabulary is unchanged — a queue read is still
 * `queue.read`, held by AGENT (UC-E10) and TEAM_LEAD, and minting a "leadership"
 * permission would be deciding a piece of the role catalogue that belongs to D-11 and HR.
 * The scope kinds are unchanged. The ladder is the same ladder, minus the steps that only
 * mean something with a conversation in hand: there is no owner of a queue, no participant
 * in a queue, and no single sensitivity for a list of many conversations.
 *
 * The alternative — making `conversationId` optional on `ResourceContext` — was rejected:
 * `scopeCovers`'s `CONVERSATION` case would then compare `undefined === undefined` and
 * fail OPEN, and step 6's temporary-grant match treats an absent conversation id as
 * "every conversation". Both are exactly the wrong direction for a change made to close a
 * hole.
 *
 * ## What is deliberately NOT checked
 *
 * Sensitivity. A queue view carries conversation ids, priority, after-hours flag and
 * arrival time; the load view carries counts and colleague names. Neither carries customer
 * content, so there is no sensitivity to segment on, and inventing a rule that a MEDICAL
 * conversation must be hidden from a team's own queue would decide something nobody has.
 * If a queue view ever grows content, that is the moment for this to grow a rule — and the
 * projection is right there in the controller for a reviewer to see.
 */
export function decideForTeam(request: TeamDecisionRequest): Decision {
  const { actor, team, now } = request;
  const action = request.action;

  // The same first three rungs as `decide`, in the same order and for the same reasons.
  if (!isKnownAction(action)) {
    return { allow: false, reason: 'UNKNOWN_ACTION', privilegedAttempt: false };
  }
  const privileged = PRIVILEGED_ACTIONS.has(action);

  if (actor.status !== 'ACTIVE') {
    return { allow: false, reason: 'PRINCIPAL_INACTIVE', privilegedAttempt: privileged };
  }

  // A customer has no queue. Denied by KIND before anything else is considered (§27.16).
  if (actor.kind === 'CUSTOMER') {
    return { allow: false, reason: 'CUSTOMER_ACTION_FORBIDDEN', privilegedAttempt: privileged };
  }

  for (const delegation of actor.delegations) {
    if (
      delegation.capabilities.includes(action) &&
      isWithinPeriod(now, delegation.effectiveFrom, delegation.effectiveTo) &&
      teamScopeCovers(delegation.scopeKind, delegation.scopeId, actor, team)
    ) {
      return { allow: true, basis: 'DELEGATION', privileged, grantRef: delegation.delegationId };
    }
  }

  for (const grant of actor.grants) {
    if (
      grant.actions.includes(action) &&
      isWithinPeriod(now, grant.effectiveFrom, grant.effectiveTo) &&
      teamScopeCovers(grant.scopeKind, grant.scopeId, actor, team)
    ) {
      return { allow: true, basis: 'SCOPE_GRANT', privileged, grantRef: grant.role };
    }
  }

  return { allow: false, reason: 'NOT_PARTICIPANT_NO_SCOPE', privilegedAttempt: privileged };
}

export function decide(request: DecisionRequest): Decision {
  const { actor, resource, now } = request;
  const action = request.action;

  // 1. Unknown action -> deny. Fail closed, always.
  if (!isKnownAction(action)) {
    return { allow: false, reason: 'UNKNOWN_ACTION', privilegedAttempt: false };
  }
  const privileged = PRIVILEGED_ACTIONS.has(action);

  // 2. An inactive principal acts on nothing. Deactivation is effective immediately,
  //    not at a cache expiry (FR-EMP-2).
  if (actor.status !== 'ACTIVE') {
    return { allow: false, reason: 'PRINCIPAL_INACTIVE', privilegedAttempt: privileged };
  }

  // 3. Customer principals: a separate, tiny decision path. Denied by KIND before any
  //    field filtering is contemplated (doc §27.16).
  if (actor.kind === 'CUSTOMER') {
    if (!CUSTOMER_PERMITTED_ACTIONS.has(action)) {
      return { allow: false, reason: 'CUSTOMER_ACTION_FORBIDDEN', privilegedAttempt: privileged };
    }
    if (request.targetVisibility === 'INTERNAL') {
      // The worst leak available in this product, refused at the decision layer.
      return { allow: false, reason: 'CUSTOMER_INTERNAL_CONTENT', privilegedAttempt: false };
    }
    if (resource.belongsToActorCustomer !== true) {
      return { allow: false, reason: 'CUSTOMER_NOT_OWNER_OF_RESOURCE', privilegedAttempt: false };
    }
    const required = request.requiredAssurance ?? 'VERIFIED_CUSTOMER';
    const held = actor.assurance ?? 'ANONYMOUS';
    if (ASSURANCE_RANK[held] < ASSURANCE_RANK[required]) {
      return { allow: false, reason: 'CUSTOMER_INSUFFICIENT_ASSURANCE', privilegedAttempt: false };
    }
    return { allow: true, basis: 'CUSTOMER_OWN', privileged: false };
  }

  const isOwner = resource.currentOwnerId !== undefined && resource.currentOwnerId === actor.principalId;
  const isLiveParticipant =
    resource.participant !== undefined &&
    isWithinPeriod(now, resource.participant.effectiveFrom, resource.participant.effectiveTo);

  // 4. Ownership. The owner is accountable and may act on the conversation.
  //    Sensitivity segmentation deliberately does not apply here: it gates reaching
  //    INTO a sensitive conversation from outside, and the owner is already inside it.
  if (isOwner && OWNER_ACTIONS.has(action)) {
    return { allow: true, basis: 'OWNER', privileged: false };
  }

  // 5. Participation — a CONVERSATION-SCOPED grant, never a global one.
  if (isLiveParticipant) {
    if (PARTICIPANT_ACTIONS.has(action) && grantedByParticipationOn(resource.conversationType, action)) {
      return { allow: true, basis: 'PARTICIPANT', privileged: false };
    }
    if (action === 'conversation.reply.customer' && resource.participant?.replyAuthority === true) {
      return { allow: true, basis: 'PARTICIPANT', privileged: false };
    }
    /**
     * Managing membership of an INTERNAL thread, where there is no owner to be.
     *
     * `conversation.participant.add`/`.remove` sit in OWNER_ACTIONS because P-03 is about a
     * CUSTOMER conversation: it has an accountable advisor, and being in the room does not
     * make you them. An internal thread has no such person — `currentOwnerId` comes from
     * `service_cases`, which internal conversations do not have — so on those threads the
     * OWNER rung can never fire for anybody, and the governing rule is BR-05: *participation
     * is granted by someone already inside the conversation*.
     *
     * Stating it here rather than in the controller is the point. The HTTP routes performed
     * NO authorization at all, and the obvious repair — checking `decide()` and special-
     * casing internal threads at the call site — would put the rule in a second place and
     * leave `decide()` answering "deny" to a question the product answers "allow". §38
     * records two authorization paths diverging as the reference platform's defect, and
     * this file is where that would begin.
     *
     * The domain command enforces BR-05 again inside its transaction, which is defence in
     * depth rather than duplication: this decides, that one cannot be raced.
     */
    if (
      INTERNAL_MEMBERSHIP_ACTIONS.has(action) &&
      PARTICIPANT_MANAGED_TYPES.has(resource.conversationType)
    ) {
      return { allow: true, basis: 'PARTICIPANT', privileged: false };
    }
    // Being in the room is not being in charge of it (P-03). Fall through: a scoped
    // grant may still authorise this action.
  }

  // 6. Temporary grants — cover, compliance access, escalation reads. Time-boxed and,
  //    where privileged, audited by the caller on the strength of `privileged`.
  for (const grant of actor.temporaryGrants) {
    if (
      grant.capability === action &&
      isWithinPeriod(now, grant.effectiveFrom, grant.effectiveTo) &&
      (grant.conversationId === undefined || grant.conversationId === resource.conversationId) &&
      (grant.caseId === undefined || grant.caseId === resource.caseId)
    ) {
      return { allow: true, basis: 'TEMPORARY_GRANT', privileged, grantRef: grant.grantId };
    }
  }

  // 7. Delegations received from another principal.
  for (const delegation of actor.delegations) {
    if (
      delegation.capabilities.includes(action) &&
      isWithinPeriod(now, delegation.effectiveFrom, delegation.effectiveTo) &&
      scopeCovers(delegation.scopeKind, delegation.scopeId, actor, resource)
    ) {
      if (!passesSensitivity(actor, resource, now)) {
        return { allow: false, reason: 'SENSITIVITY_SEGMENTATION', privilegedAttempt: privileged };
      }
      return { allow: true, basis: 'DELEGATION', privileged, grantRef: delegation.delegationId };
    }
  }

  // 8. Role x scope assignments.
  for (const grant of actor.grants) {
    if (
      grant.actions.includes(action) &&
      isWithinPeriod(now, grant.effectiveFrom, grant.effectiveTo) &&
      scopeCovers(grant.scopeKind, grant.scopeId, actor, resource)
    ) {
      if (!passesSensitivity(actor, resource, now)) {
        return { allow: false, reason: 'SENSITIVITY_SEGMENTATION', privilegedAttempt: privileged };
      }
      return { allow: true, basis: 'SCOPE_GRANT', privileged, grantRef: grant.role };
    }
  }

  if (isLiveParticipant) {
    return { allow: false, reason: 'PARTICIPATION_DOES_NOT_GRANT_ACTION', privilegedAttempt: privileged };
  }
  return { allow: false, reason: 'NOT_PARTICIPANT_NO_SCOPE', privilegedAttempt: privileged };
}

/**
 * What participation alone grants: reading the thread and contributing internal
 * context. Not replying to the customer, not reassigning, not closing (P-03, UC-E08).
 */
const PARTICIPANT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'conversation.read',
  // Talking to colleagues in an internal thread is ordinary participation.
  'conversation.message.send',
  'conversation.note.internal',
  'conversation.attachment.upload',
  'conversation.attachment.download',
  'case.read',
]);

/**
 * Membership actions a plain participant may take on a thread that has NO owner.
 *
 * These are in `OWNER_ACTIONS` below as well, and deliberately: on a customer conversation
 * the accountable advisor decides who else sees it (P-03), and on an internal thread BR-05
 * gives that to anyone already inside. Two rules, two disjoint kinds of conversation, one
 * decision function.
 */
const INTERNAL_MEMBERSHIP_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'conversation.participant.add',
  'conversation.participant.remove',
]);

/**
 * The internal types on which ANY participant may manage membership (BR-05).
 *
 * ## Why this is not simply "the internal types"
 *
 * It used to be, and `internal-types.test.ts` asserted it equalled `isInternal()`. That
 * equality held while every internal thread was a conversation between a handful of people
 * who had each been let in by one of the others — where "anyone inside may add someone
 * else" is the rule BR-05 states.
 *
 * An announcement breaks it. Its participants are the whole company, so "any participant may
 * remove a participant" would mean anybody could remove anybody from a company-wide thread.
 * The two facts — *has no owner* and *membership is managed from inside* — were the same
 * list by coincidence, and an announcement is where the coincidence ends.
 *
 * So `isInternal()` keeps the first fact and this keeps the second. The test now asserts the
 * relationship that is actually true (this set is a subset of `isInternal`, and each type's
 * membership is stated) rather than an equality that was only ever incidental.
 */
const PARTICIPANT_MANAGED_TYPES: ReadonlySet<ConversationType> = new Set<ConversationType>([
  'INTERNAL_DIRECT',
  'INTERNAL_GROUP',
]);

/**
 * Does participation ALONE grant this action on this kind of conversation?
 *
 * One narrowing, and it is the whole definition of an announcement: everybody in it may read
 * it, and being in it does not let you write in it. `conversation.announcement.post` is a
 * separate action for exactly this reason — `PARTICIPANT_ACTIONS` contains
 * `conversation.message.send`, and a thread whose participants are the entire company must
 * not hand the entire company a broadcast.
 *
 * Written as a positive list of what participation still grants on an announcement rather
 * than a subtraction from `PARTICIPANT_ACTIONS`. A subtraction quietly re-grants anything
 * added to that set later; this refuses it until somebody names it here (rule 4's shape,
 * applied one level down).
 */
const ANNOUNCEMENT_PARTICIPANT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'conversation.read',
  'conversation.attachment.download',
  'conversation.message.react',
]);

function grantedByParticipationOn(conversationType: ConversationType, action: Action): boolean {
  return conversationType === 'INTERNAL_ANNOUNCEMENT'
    ? ANNOUNCEMENT_PARTICIPANT_ACTIONS.has(action)
    : true;
}

/** What the accountable owner may do (BR-12, BR-19). */
const OWNER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'conversation.read',
  'conversation.message.send',
  'conversation.reply.customer',
  'conversation.note.internal',
  'conversation.participant.add',
  'conversation.participant.remove',
  'conversation.attachment.upload',
  'conversation.attachment.download',
  'conversation.transfer',
  'conversation.escalate',
  'conversation.resolve',
  'conversation.reopen',
  'case.read',
]);

/**
 * Layer 2 of the §18.4 ladder: does this principal hold this permission AT ALL.
 *
 * ## Why this exists, and what it deliberately is not
 *
 * Most operations name a conversation, and for those the object check (`decide`) is the
 * boundary — rule 2. A few name nothing: reading the staff directory, running a search.
 * They still require a permission, and until now they had no way to ask for one.
 *
 * The consequence was not theoretical. `GET /v1/employee/directory` performed no
 * authorization of any kind beyond "is signed in", so any authenticated employee — a
 * brand-new joiner holding no roles at all — could page the entire staff list and then
 * fetch any principal by id. `'directory.read'` was in the action vocabulary and in two
 * role definitions, and was **evaluated nowhere in the product**: a permission that
 * existed only as documentation.
 *
 * This is NOT a substitute for the object check and must never be used as one. It answers
 * "in principle", which is exactly as much as an operation with no resource can ask. Where
 * there is a conversation or a team, use `decide` or `decideForTeam`.
 *
 * ## Why scope is not consulted
 *
 * `scopeCovers` compares a grant's scope against a RESOURCE, and there isn't one. The
 * alternative already in the tree — `admin.controller.ts`'s synthetic resource with the nil
 * UUID as its conversation id — is worse than it looks: with no owning team or department,
 * only a GLOBAL-scoped grant can ever match it, so a TEAM-scoped holder silently cannot
 * perform the operation. `directory.read` belongs to AGENT and TEAM_LEAD, whose grants are
 * ordinarily TEAM-scoped, so that pattern would have denied nearly everyone — and the
 * positive control in `claim-authorization.test.ts` fails if anyone reintroduces it.
 *
 * Ignoring scope is therefore the honest reading rather than the lax one: a directory is
 * company-wide, and the question "may this person read a staff directory" has no team in
 * it. An operation whose answer DOES depend on scope has a resource, and belongs in
 * `decide`.
 *
 * The period is still read from the clock, so an expired or not-yet-started role grants
 * nothing (property 4).
 */
export function holdsAction(actor: ActorContext, action: string, now: Timestamp): boolean {
  // Rule 4, first: an unknown permission is denied, never treated as unrestricted.
  if (!isKnownAction(action)) return false;
  if (actor.status !== 'ACTIVE') return false;
  // The employee vocabulary. A customer's permitted actions are decided by `decide`'s
  // customer branch against their own conversation, never by holding a role.
  if (actor.kind === 'CUSTOMER') return false;

  return (
    actor.grants.some(
      (g) => g.actions.includes(action) && isWithinPeriod(now, g.effectiveFrom, g.effectiveTo),
    ) ||
    actor.delegations.some(
      (d) => d.capabilities.includes(action) && isWithinPeriod(now, d.effectiveFrom, d.effectiveTo),
    )
  );
}
