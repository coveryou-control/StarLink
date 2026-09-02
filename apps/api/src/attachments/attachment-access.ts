/**
 * §28.4's download authorization ladder, as one function.
 *
 * The document draws it as five numbered steps and they are numbered here for the same
 * reason: the ORDER is the security property, and a reordering would be invisible in
 * review without the numbers to check against.
 *
 *     [1] session valid?                      → 401
 *     [2] metadata record exists?             → uniform 404/403 (§27.3)
 *     [3] LOAD THE CONVERSATION AND AUTHORIZE → 403
 *         (the same object check as §18.4 step 3 — the attachment's access is
 *          ENTIRELY derived from its conversation)
 *     [4] is the caller a customer, and is this an internal-note attachment?
 *                                             → 403, always
 *     [5] AUDIT THE DOWNLOAD (FR-ATT-5)
 *     [6] stream / issue the grant
 *
 * Step 1 has already happened at the edge guard by the time anything here runs, so this
 * covers 2 through 5 and hands the caller a decision.
 *
 * ## Step 4 is not a special case of step 3
 *
 * It looks like one. It is not, and conflating them is the mistake the separation exists
 * to prevent: step 3 asks whether this principal may read this CONVERSATION, and a
 * customer legitimately may read their own. Step 4 asks whether this particular
 * attachment hangs off a message they may see. An internal note in a conversation a
 * customer owns passes step 3 and must fail step 4 — §28.5's table gives internal-note
 * attachments to customers as "Never".
 *
 * ## Why a grant, and what is audited
 *
 * ADR-012 supersedes §28.4's stream-through-the-application with a short-lived,
 * single-object signed GET — but only "issued **only after** the full §28.4 check ladder
 * … with the **issuance audited**". So the audit happens here, before the grant exists,
 * and it records that this principal was permitted to fetch these bytes. §28.4's own
 * objection to signed URLs — that they audit the issuance rather than the download — is
 * answered by ADR-012 accepting that trade explicitly rather than by pretending it away.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { isReachable, type AttachmentState } from '@starlink/attachments';

export interface AttachmentForAccess {
  readonly attachmentId: UUID;
  readonly conversationId: UUID;
  readonly messageId?: UUID;
  readonly state: AttachmentState;
  readonly cleanKey?: string;
  readonly originalFilename?: string;
}

export type AccessRefusal =
  /** Steps 2 and 3 collapse to one answer on the wire (§27.3), and to one here. */
  | 'NOT_FOUND_OR_NOT_PERMITTED'
  /** Step 4. Named separately because it must be audited differently. */
  | 'INTERNAL_NOTE_ATTACHMENT'
  /** Never bound, still scanning, infected, expired — reachable by nobody (§28.1). */
  | 'NOT_REACHABLE';

export interface AccessPorts {
  /** Step 3: the SAME object check every other read path uses. */
  mayReadConversation(principalId: UUID, conversationId: UUID): Promise<boolean>;
  /** Step 4: the visibility of the message this attachment hangs off. */
  messageVisibility(messageId: UUID): Promise<string | undefined>;
}

export type AccessDecision =
  | { readonly ok: true; readonly cleanKey: string; readonly filename: string }
  | { readonly ok: false; readonly refusal: AccessRefusal };

export async function decideAttachmentAccess(
  attachment: AttachmentForAccess | undefined,
  actor: { principalId: UUID; kind: 'EMPLOYEE' | 'CUSTOMER' },
  ports: AccessPorts,
): Promise<AccessDecision> {
  // [2] No metadata record. §28.3 makes metadata the authority, so bytes in storage with
  // no row are not an attachment — they are litter.
  if (attachment === undefined) return { ok: false, refusal: 'NOT_FOUND_OR_NOT_PERMITTED' };

  // [3] The object check. Access is derived ENTIRELY from the conversation, so this is
  // the same question `decide()` answers for a message — not a second, parallel rule.
  if (!(await ports.mayReadConversation(actor.principalId, attachment.conversationId))) {
    return { ok: false, refusal: 'NOT_FOUND_OR_NOT_PERMITTED' };
  }

  // [4] The customer/internal-note boundary. Checked BEFORE reachability so that the
  // refusal reported for an internal note is the internal-note one — it is audited
  // differently, and "not found" would lose the fact that a customer reached for staff
  // material.
  if (actor.kind === 'CUSTOMER') {
    if (attachment.messageId === undefined) {
      // An unbound attachment has no message whose visibility could permit it.
      return { ok: false, refusal: 'NOT_REACHABLE' };
    }
    const visibility = await ports.messageVisibility(attachment.messageId);
    if (visibility !== 'CUSTOMER_VISIBLE') {
      return { ok: false, refusal: 'INTERNAL_NOTE_ATTACHMENT' };
    }
  }

  // §28.1: binding is what grants access. Anything not BOUND is reachable by nobody,
  // including the person who uploaded it.
  if (!isReachable(attachment.state) || attachment.cleanKey === undefined) {
    return { ok: false, refusal: 'NOT_REACHABLE' };
  }

  return {
    ok: true,
    cleanKey: attachment.cleanKey,
    // §28.3: the original filename is metadata, "presented on download; never trusted as
    // a path". Already sanitised on the way in.
    filename: attachment.originalFilename ?? 'attachment',
  };
}

/** What FR-ATT-5 requires be recorded, whichever way the decision went. */
export interface DownloadAuditEntry {
  readonly attachmentId: UUID;
  readonly conversationId: UUID;
  readonly outcome: 'SUCCEEDED' | 'REFUSED';
  readonly refusal?: AccessRefusal;
  readonly at: Timestamp;
}
