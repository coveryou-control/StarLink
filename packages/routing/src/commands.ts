/**
 * Ownership commands: cover, transfer, escalate, reassign-on-exit (doc §21.7, §21.9).
 *
 * ## The distinction this module exists to keep straight
 *
 * §21.9 names case D — "unavailable during working hours, in a meeting, on a call, at a
 * ceiling" — as **"the one most often got wrong"**, and says why:
 *
 * > "The temptation is to treat 'in a meeting' as unavailability and move ownership.
 * > Moving ownership for a two-hour meeting churns the relationship for no benefit —
 * > the team covers, the owner returns, and the cover is history."
 *
 * So **COVER DOES NOT MOVE OWNERSHIP.** A colleague answers under team scope while the
 * owner keeps the conversation. That is a time-boxed access grant, not an assignment,
 * and it is audited precisely because it is a read the colleague would not otherwise
 * have. Getting this wrong does not throw — it quietly reassigns a customer's advisor
 * every time he takes a call, and nobody notices until the relationship is gone.
 *
 * The four commands and what each moves:
 *
 * | Command            | Current owner | Designated employee | §21.9 case |
 * |--------------------|---------------|---------------------|------------|
 * | `cover`            | unchanged     | unchanged           | A, D       |
 * | `transfer`         | **moves**     | unchanged           | —          |
 * | `escalate`         | **moves**     | unchanged           | —          |
 * | `reassignOnExit`   | **moves**     | **moves**           | C          |
 *
 * Only a departure changes the designated employee, because only a departure ends the
 * relationship. Everything else is temporary, however long it lasts.
 *
 * Every one of these carries a MANDATORY reason and is audited. A reason is not
 * bureaucracy: an ownership change with no stated cause is unanswerable six months
 * later, and these are exactly the records an audit reaches for.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export type CommandFailure =
  | 'NOT_ASSIGNED'
  | 'REASON_REQUIRED'
  | 'SAME_OWNER'
  | 'TARGET_UNAVAILABLE'
  | 'COVER_WINDOW_INVALID';

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CommandFailure };

export interface OwnershipPort {
  /** The live owner, or undefined when the conversation is unassigned. */
  currentOwner(conversationId: UUID): Promise<UUID | undefined>;
  /** Closes the open episode and opens a new one at the same instant. */
  reassign(input: {
    conversationId: UUID;
    toOwner: UUID;
    assignmentSource: 'TRANSFER' | 'ESCALATION' | 'REASSIGNED_ON_EXIT' | 'LEAD_ASSIGNED';
    reason: string;
    assignedBy: UUID;
    at: Timestamp;
    preserveDesignated: boolean;
  }): Promise<{ episodeId: UUID }>;
  /** A time-boxed capability on ONE conversation. Never an ownership change. */
  grantCover(input: {
    conversationId: UUID;
    principalId: UUID;
    capability: string;
    reason: string;
    grantedBy: UUID;
    from: Timestamp;
    until: Timestamp;
  }): Promise<{ grantId: UUID }>;
  /** Escalation is a LEVEL, not a state — a case can be escalated AND active AND waiting. */
  raiseEscalationLevel(input: {
    conversationId: UUID;
    reason: string;
    at: Timestamp;
  }): Promise<{ level: number }>;
}

export interface AuditPort {
  record(entry: {
    action: string;
    actorId: UUID;
    targetId: UUID;
    reason: string;
    detail?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void>;
}

export interface CommandDeps {
  readonly ownership: OwnershipPort;
  readonly audit: AuditPort;
}

const hasReason = (reason: string): boolean => reason.trim().length > 0;

/**
 * A colleague answers while the owner is briefly away (§21.9 cases A and D).
 *
 * Ownership is untouched — deliberately, and this is the whole point of the command
 * existing separately from `transfer`. The grant is time-boxed because an open-ended
 * "cover" is just an unaudited second owner.
 */
export async function cover(
  command: {
    conversationId: UUID;
    covererId: UUID;
    grantedBy: UUID;
    reason: string;
    from: Timestamp;
    until: Timestamp;
  },
  deps: CommandDeps,
): Promise<CommandResult<{ grantId: UUID; ownerUnchanged: UUID }>> {
  if (!hasReason(command.reason)) return { ok: false, reason: 'REASON_REQUIRED' };
  // An expiry at or before the start is not a grant, it is a typo that would either
  // grant nothing or — read carelessly elsewhere — grant forever.
  if (command.until <= command.from) return { ok: false, reason: 'COVER_WINDOW_INVALID' };

  const owner = await deps.ownership.currentOwner(command.conversationId);
  // Cover means covering FOR someone. An unassigned conversation should be claimed from
  // the queue, not covered — otherwise it acquires a helper and still has no owner.
  if (owner === undefined) return { ok: false, reason: 'NOT_ASSIGNED' };
  if (owner === command.covererId) return { ok: false, reason: 'SAME_OWNER' };

  const { grantId } = await deps.ownership.grantCover({
    conversationId: command.conversationId,
    principalId: command.covererId,
    capability: 'conversation.read+reply',
    reason: command.reason,
    grantedBy: command.grantedBy,
    from: command.from,
    until: command.until,
  });

  // Audited because it is a read the coverer would not otherwise have (§21.9 case A).
  await deps.audit.record({
    action: 'conversation.cover.granted',
    actorId: command.grantedBy,
    targetId: command.conversationId,
    reason: command.reason,
    detail: { coverer: command.covererId, owner, until: command.until },
  });

  return { ok: true, value: { grantId, ownerUnchanged: owner } };
}

/**
 * Hands the conversation to a new owner.
 *
 * The designated employee is PRESERVED. A transfer moves who is accountable for this
 * conversation; it does not decide who the customer's advisor is. Only a departure does
 * that (§21.7: designation changes "rarely — a book transfer, a departure, a business
 * decision", none of which is a single conversation changing hands).
 */
export async function transfer(
  command: {
    conversationId: UUID;
    toOwner: UUID;
    transferredBy: UUID;
    reason: string;
    at: Timestamp;
    targetAvailable: boolean;
  },
  deps: CommandDeps,
): Promise<CommandResult<{ episodeId: UUID; previousOwner?: UUID }>> {
  if (!hasReason(command.reason)) return { ok: false, reason: 'REASON_REQUIRED' };
  // Transferring to someone on leave produces work nobody is looking at, which is the
  // silent-loss failure §21.9 case C warns about, arrived at by a different road.
  if (!command.targetAvailable) return { ok: false, reason: 'TARGET_UNAVAILABLE' };

  const owner = await deps.ownership.currentOwner(command.conversationId);
  if (owner === undefined) return { ok: false, reason: 'NOT_ASSIGNED' };
  if (owner === command.toOwner) return { ok: false, reason: 'SAME_OWNER' };

  const { episodeId } = await deps.ownership.reassign({
    conversationId: command.conversationId,
    toOwner: command.toOwner,
    assignmentSource: 'TRANSFER',
    reason: command.reason,
    assignedBy: command.transferredBy,
    at: command.at,
    preserveDesignated: true,
  });

  await deps.audit.record({
    action: 'conversation.transfer',
    actorId: command.transferredBy,
    targetId: command.conversationId,
    reason: command.reason,
    detail: { from: owner, to: command.toOwner },
  });

  return { ok: true, value: { episodeId, previousOwner: owner } };
}

/**
 * Escalates to a specialist.
 *
 * The LEVEL rises and ownership moves; the designated employee does not. A case can be
 * escalated AND active AND waiting at once (§21.4), so escalation is an orthogonal axis
 * rather than a state — modelling it as a state is how a case becomes un-representable
 * the moment two things are true of it.
 *
 * The customer may be told a specialist is helping. They are never told the LEVEL or the
 * REASON (§22.5).
 */
export async function escalate(
  command: {
    conversationId: UUID;
    toOwner: UUID;
    escalatedBy: UUID;
    reason: string;
    at: Timestamp;
    targetAvailable: boolean;
  },
  deps: CommandDeps,
): Promise<CommandResult<{ episodeId: UUID; level: number }>> {
  if (!hasReason(command.reason)) return { ok: false, reason: 'REASON_REQUIRED' };
  if (!command.targetAvailable) return { ok: false, reason: 'TARGET_UNAVAILABLE' };

  const owner = await deps.ownership.currentOwner(command.conversationId);
  if (owner === undefined) return { ok: false, reason: 'NOT_ASSIGNED' };

  const { level } = await deps.ownership.raiseEscalationLevel({
    conversationId: command.conversationId,
    reason: command.reason,
    at: command.at,
  });

  const { episodeId } = await deps.ownership.reassign({
    conversationId: command.conversationId,
    toOwner: command.toOwner,
    assignmentSource: 'ESCALATION',
    reason: command.reason,
    assignedBy: command.escalatedBy,
    at: command.at,
    preserveDesignated: true,
  });

  await deps.audit.record({
    action: 'conversation.escalate',
    actorId: command.escalatedBy,
    targetId: command.conversationId,
    reason: command.reason,
    detail: { from: owner, to: command.toOwner, level },
  });

  return { ok: true, value: { episodeId, level } };
}

/**
 * Reassigns work owned by someone who has left (§21.9 case C, BR-13, FR-EMP-3).
 *
 * The ONE command that also moves the designated employee, because a departure is the
 * one event that genuinely ends the relationship. §21.9: "Case C is the one that
 * silently loses customers. A case owned by a deactivated principal is unreachable
 * work" — which is why §32.3 monitors it with a target of zero.
 *
 * The audit here is MUST-SUCCEED. Everywhere else a lost audit line is regrettable;
 * here it is the record of who inherited a departed colleague's customers, and that
 * question gets asked.
 */
export async function reassignOnExit(
  command: {
    conversationId: UUID;
    toOwner: UUID;
    reassignedBy: UUID;
    reason: string;
    at: Timestamp;
    targetAvailable: boolean;
  },
  deps: CommandDeps,
): Promise<CommandResult<{ episodeId: UUID }>> {
  if (!hasReason(command.reason)) return { ok: false, reason: 'REASON_REQUIRED' };
  if (!command.targetAvailable) return { ok: false, reason: 'TARGET_UNAVAILABLE' };

  const owner = await deps.ownership.currentOwner(command.conversationId);
  if (owner === undefined) return { ok: false, reason: 'NOT_ASSIGNED' };
  if (owner === command.toOwner) return { ok: false, reason: 'SAME_OWNER' };

  const { episodeId } = await deps.ownership.reassign({
    conversationId: command.conversationId,
    toOwner: command.toOwner,
    assignmentSource: 'REASSIGNED_ON_EXIT',
    reason: command.reason,
    assignedBy: command.reassignedBy,
    at: command.at,
    // The departure case, and the only one that moves it.
    preserveDesignated: false,
  });

  await deps.audit.record({
    action: 'conversation.reassign_on_exit',
    actorId: command.reassignedBy,
    targetId: command.conversationId,
    reason: command.reason,
    detail: { from: owner, to: command.toOwner },
  });

  return { ok: true, value: { episodeId } };
}
