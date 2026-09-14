/**
 * The one question every audit endpoint asks before it reads anything.
 *
 * ## Why this is a module and not a decorator
 *
 * A guard that answers "is this the auditor" by looking at a role name would be a second
 * authorization system living beside `decide()` — the exact divergence §38 records, and the
 * thing rule 2 exists to prevent. So this asks `decide()`, with a real action against a real
 * resource, exactly as every other content path does. What it adds is the two things a
 * company-wide read needs on top of a decision: the ledger row, written BEFORE the content
 * is read, and a refusal that is uniform to the caller and specific in the log.
 *
 * ## Why the ledger entry is not optional
 *
 * This is the only role in StarLink that can read a conversation it is not in. The thing
 * that makes that acceptable is not the narrowness of the grant — it is that every exercise
 * of it is answerable for, in a ledger the auditor can query but cannot alter (rule 8, and
 * the role grants of `0002_roles_and_audit_immutability.sql`). A read that happened without
 * a row is the one failure this feature cannot have, so the row is written first and a
 * failure to write it fails the request.
 */
import { decide, toActorContext, type Action } from '@starlink/conversation-domain';
import type { ConversationType, IdentityAuthorizationClient, UUID } from '@starlink/shared-contracts';

import type { AuditWriter } from './audit-writer.js';

/** The surface-wide resource id, shared with the controller's own constant. */
const WHOLE_COMPANY = '00000000-0000-0000-0000-000000000000' as UUID;

export interface AuditAccessRequest {
  readonly principalId: UUID;
  readonly action: Action;
  readonly correlationId: string;
  /**
   * What is being read. A synthetic id is used for the surface-wide reads (the employee
   * list, the ledger) because there is no one conversation in question — `decide()` needs a
   * resource shape and inventing a plausible conversation id would put a lie in the ledger.
   */
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly conversationType?: ConversationType;
  };
}

/**
 * Resolves the caller, decides, records, and answers.
 *
 * `false` means refuse — and the CALLER is told nothing about why (§27.3). The ledger knows.
 */
export async function permitAuditRead(
  deps: { readonly identity: IdentityAuthorizationClient; readonly audit: AuditWriter },
  request: AuditAccessRequest,
): Promise<boolean> {
  const claims = await deps.identity.resolvePrincipal(request.principalId);
  if (!claims.ok) {
    await deps.audit.record({
      actorId: request.principalId,
      actorKind: 'EMPLOYEE',
      action: request.action,
      targetKind: request.target.kind,
      targetId: request.target.id,
      outcome: 'REFUSED',
      reason: 'PRINCIPAL_UNRESOLVED',
      correlationId: request.correlationId,
    });
    return false;
  }

  /**
   * TWO questions, and the first one is the door.
   *
   * ## Why the action alone is not the gate
   *
   * The first version of this asked `decide()` for the action each handler named —
   * `search.execute` for search, `directory.read` for teams — and that was a real hole,
   * found by driving the surface as an ordinary agent. `AGENT` holds both of those actions:
   * it has to, because employees search their own conversations and browse the directory
   * every day. So an ordinary employee got `200` from `/v1/audit/search`, which is the same
   * index WITHOUT the participation narrowing — company-wide message search, handed to
   * everybody.
   *
   * The lesson is that these handlers are not "the ordinary action, from a different
   * controller". They are a different capability that happens to reuse the same verbs. So
   * the door is the CAPABILITY: does this principal hold the company-wide audit read at
   * all. Only then does the handler's own action matter, and then only as the thing the
   * ledger records.
   *
   * ## Why the basis is checked and not just the allow
   *
   * `privileged.conversation.read` could in principle be allowed by some other rung — a
   * temporary grant naming one conversation, say. That is a lawful way to reach one thread
   * and emphatically not a licence for the whole surface. Requiring
   * `basis === 'COMMUNICATION_AUDIT'` means only rung 3a's company-wide grant opens this
   * door, and a narrower permission stays narrow.
   */
  const audit = decide({
    actor: toActorContext(claims.value),
    action: 'privileged.conversation.read',
    resource: {
      /* Not conversation-scoped: the question is whether this principal is the auditor, and
         the answer is the same whichever thread prompted the asking. `SYSTEM_INTERACTION`
         matches `holdsAdminAction` in `admin.controller.ts` — and the type matters, because
         a participant-managed one is closed by rung 6 to exactly the non-participant this
         is asking about. */
      conversationId: WHOLE_COMPANY,
      conversationType: 'SYSTEM_INTERACTION',
      sensitivity: 'ORDINARY',
    },
    now: new Date().toISOString(),
  });

  const isAuditor = audit.allow && audit.basis === 'COMMUNICATION_AUDIT';

  /**
   * And then the handler's own action, against the thing actually being read.
   *
   * Kept as a second decision rather than folded into the first because the two say
   * different things: the first is "may this person use the audit surface", the second is
   * "may this action reach this resource". Collapsing them would mean a future handler
   * naming an action the auditor does not hold would be permitted by the door alone.
   */
  const decision = decide({
    actor: toActorContext(claims.value),
    action: request.action,
    resource: {
      conversationId: request.target.id as UUID,
      conversationType: request.target.conversationType ?? 'SYSTEM_INTERACTION',
      sensitivity: 'ORDINARY',
    },
    now: new Date().toISOString(),
  });

  if (!isAuditor || !decision.allow) {

    /**
     * A refused audit read is as interesting as a successful one — more so.
     *
     * Somebody reaching for this surface without the grant is either a misconfiguration or
     * an attempt, and both are things an incident wants to find. `PRIVILEGED_ACTIONS`
     * already marks these actions as audited on refusal; this is that, at the one door
     * where the answer is always company-wide.
     */
    await deps.audit.record({
      actorId: request.principalId,
      actorKind: 'EMPLOYEE',
      action: request.action,
      targetKind: request.target.kind,
      targetId: request.target.id,
      outcome: 'REFUSED',
      /* Which half refused. "Not the auditor" and "the auditor may not do this" are
         different incidents, and a single uniform reason would lose the distinction in
         the one log that exists to preserve it. The CALLER still learns nothing. */
      reason: isAuditor ? (decision.allow ? 'UNKNOWN' : decision.reason) : 'NOT_THE_AUDITOR',
      correlationId: request.correlationId,
    });
    return false;
  }

  /**
   * Recorded BEFORE the read, and `mustSucceed`.
   *
   * Written first so a crash between the decision and the content cannot produce a read
   * with no record. `mustSucceed` so a ledger that is unavailable stops the read rather
   * than quietly permitting an unrecorded one — the same posture `admin.role.assign` takes,
   * and for the same reason: whoever can do this can do it to everything.
   */
  await deps.audit.record(
    {
      actorId: request.principalId,
      actorKind: 'EMPLOYEE',
      action: request.action,
      targetKind: request.target.kind,
      targetId: request.target.id,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { basis: decision.basis, ...(decision.grantRef !== undefined ? { grant: decision.grantRef } : {}) },
    },
    { mustSucceed: true },
  );

  return true;
}
