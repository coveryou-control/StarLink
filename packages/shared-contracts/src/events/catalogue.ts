/**
 * Versioned event catalogue (ADR-013, INTEGRATION_CONTRACTS §10).
 *
 * Two rules govern every schema in this file:
 *
 *  1. Payloads carry IDs, classifications and metadata — NEVER message bodies or raw
 *     PII. These events cross into the enterprise fabric (CCS, CY Brain) where the
 *     access list is wider than the message store's (brief §45).
 *  2. Change is additive within a version. A breaking change is a new vN+1 published
 *     alongside vN for a deprecation window (brief §58).
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const ts = z.string().datetime();

export const eventEnvelopeSchema = z.object({
  eventId: uuid,
  name: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: ts,
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  actorRef: z.object({ kind: z.string(), id: z.string() }).optional(),
  payload: z.record(z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const conversationCreatedV1 = z.object({
  conversationId: uuid,
  conversationType: z.string(),
  channel: z.string(),
  customerRef: z.string().optional(),
  caseId: uuid.optional(),
  category: z.string().optional(),
});

const conversationAssignedV1 = z.object({
  conversationId: uuid,
  caseId: uuid.optional(),
  ownerPrincipalId: uuid,
  assignmentSource: z.enum(['ROUTED', 'CLAIMED', 'LEAD_ASSIGNED', 'REASSIGNED_ON_EXIT', 'COVER']),
  reservationId: uuid.optional(),
});

const conversationReassignedV1 = z.object({
  conversationId: uuid,
  previousOwner: uuid.nullable(),
  nextOwner: uuid,
  reasonCode: z.string(),
});

const conversationTransferredV1 = z.object({
  conversationId: uuid,
  fromPrincipalId: uuid,
  toPrincipalId: uuid.optional(),
  toTeam: z.string().optional(),
  reasonCode: z.string(),
  actorId: uuid,
});

const conversationEscalatedV1 = z.object({
  conversationId: uuid,
  caseId: uuid,
  fromLevel: z.number().int().nonnegative(),
  toLevel: z.number().int().positive(),
  reasonCode: z.string(),
  actorId: uuid,
});

/**
 * §20.7's **Queue arrival** row: publisher Routing, received by the *team room*,
 * "queue read on load" as its fallback, "unordered — it is a set, not a sequence".
 *
 * Added 2026-08-29. §20.2 gives the reason it exists at all: "a queue that needs
 * refreshing is a queue that grows." The team room was joinable from Phase 3 and nothing
 * ever published to it, so a queue view subscribing received silence (N-27).
 *
 * The aggregate stays the CONVERSATION — `outbox.aggregate_id` is a uuid and a team id is
 * text — and the relay reads `teamId` from the payload to pick the room. The row is about
 * a conversation; only its audience is the team.
 */
const conversationQueueArrivedV1 = z.object({
  conversationId: uuid,
  teamId: z.string(),
  priority: z.string(),
  afterHours: z.boolean(),
});

/**
 * §20.7's **Notification created** row: publisher Notify, received by "the recipient's
 * personal room", fallback "notification list on load", authorization "personal room, self
 * only".
 *
 * Carries no content — §29's model is that a notification says there is something to look
 * at, and the thing stays behind the authorization that guards it.
 */
const notificationCreatedV1 = z.object({
  notificationId: uuid,
  recipientId: uuid,
  event: z.string(),
  targetRef: z.string().optional(),
});

const conversationResolvedV1 = z.object({
  conversationId: uuid,
  caseId: uuid,
  outcomeCode: z.string(),
  actorId: uuid,
});

const conversationLifecycleV1 = z.object({
  conversationId: uuid,
  caseId: uuid.optional(),
  trigger: z.string(),
});

/**
 * Note what is absent: `body`. A message event says a message exists and what class it
 * is; anyone entitled to the content reads it through an authorized path.
 */
const messageCreatedV1 = z.object({
  messageId: uuid,
  conversationId: uuid,
  seq: z.number().int().positive(),
  senderKind: z.enum(['EMPLOYEE', 'CUSTOMER', 'SYSTEM', 'AI']),
  visibility: z.enum(['INTERNAL', 'CUSTOMER_VISIBLE']),
  channel: z.string(),
  hasAttachments: z.boolean(),
});

/**
 * A message that names somebody.
 *
 * Deliberately a DIFFERENT event from `message.created.v1`, not a field on it. §29.2's
 * `NEVER_NOTIFIED` contains `MESSAGE_IN_INTERNAL_GROUP` — an ordinary group message
 * notifies nobody, and that stays true. §29.2's governing sentence is "Notify only what
 * someone must act on", and a message that names you is the case it describes; keeping the
 * two events separate is what stops the second quietly relaxing the first.
 *
 * The recipients are an explicit list rather than a flag, resolved at send time from the
 * live participant set. `@all` in a group whose membership changes an hour later must
 * notify who was in it when it was sent, not who is in it when the worker runs.
 */
const messageMentionedV1 = z.object({
  messageId: uuid,
  conversationId: uuid,
  seq: z.number().int().positive(),
  mentionedPrincipalIds: z.array(uuid).min(1).max(200),
  mentionedAll: z.boolean(),
});

/**
 * A message was corrected or deleted.
 *
 * No body, for the same reason `message.created.v1` carries none (§20.4): a correction is
 * still content, and the client re-reads it through the path that authorizes it. The kind
 * is here so a client can tell "re-read this thread" from "this message is gone" without
 * diffing the page it already has.
 */
const messageRevisedV1 = z.object({
  messageId: uuid,
  conversationId: uuid,
  kind: z.enum(['CORRECTION', 'REDACTION', 'TOMBSTONE']),
});

const messageReadV1 = z.object({
  conversationId: uuid,
  principalRef: z.string(),
  upToSeq: z.number().int().nonnegative(),
});

const customerReplyReceivedV1 = z.object({
  conversationId: uuid,
  caseId: uuid.optional(),
  channel: z.string(),
  waitingStateCleared: z.boolean(),
});

const attachmentReadyV1 = z.object({
  attachmentId: uuid,
  conversationId: uuid,
  scanVerdict: z.enum(['CLEAN', 'INFECTED', 'SUSPICIOUS', 'FAILED']),
  classification: z.string().optional(),
});

const slaEventV1 = z.object({
  caseId: uuid,
  conversationId: uuid.optional(),
  clock: z.enum(['FIRST_RESPONSE', 'RESOLUTION', 'ESCALATION']),
  teamId: z.string(),
  elapsedPct: z.number().optional(),
  breachedAt: ts.optional(),
});

const queueThresholdV1 = z.object({
  teamId: z.string(),
  depth: z.number().int().nonnegative(),
  oldestWaitingSeconds: z.number().int().nonnegative(),
  threshold: z.string(),
});

/**
 * The event that makes brief §8's exit requirement observable end to end:
 * `ownedOpenConversations` lets CY Brain and the ops dashboard verify the
 * inactive-owner-conversations = 0 invariant rather than trusting it.
 */
const employeeDeactivatedV1 = z.object({
  principalId: uuid,
  ownedOpenConversations: z.number().int().nonnegative(),
  reassignmentStatus: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE']),
});

const aiHandoffCompletedV1 = z.object({
  conversationId: uuid,
  summaryRef: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

/** The single source of truth for event names, versions and payload shapes. */
export const EVENT_CATALOGUE = {
  'conversation.created.v1': conversationCreatedV1,
  'conversation.assigned.v1': conversationAssignedV1,
  'conversation.reassigned.v1': conversationReassignedV1,
  'conversation.transferred.v1': conversationTransferredV1,
  'conversation.escalated.v1': conversationEscalatedV1,
  'conversation.queue.arrived.v1': conversationQueueArrivedV1,
  'notification.created.v1': notificationCreatedV1,
  'conversation.resolved.v1': conversationResolvedV1,
  'conversation.closed.v1': conversationLifecycleV1,
  'conversation.reopened.v1': conversationLifecycleV1,
  'message.created.v1': messageCreatedV1,
  'message.mentioned.v1': messageMentionedV1,
  'message.revised.v1': messageRevisedV1,
  'message.read.v1': messageReadV1,
  'customer.reply.received.v1': customerReplyReceivedV1,
  'attachment.ready.v1': attachmentReadyV1,
  'conversation.sla.at_risk.v1': slaEventV1,
  'conversation.sla.breached.v1': slaEventV1,
  'conversation.queue.threshold.v1': queueThresholdV1,
  'employee.deactivated.v1': employeeDeactivatedV1,
  'ai.handoff.completed.v1': aiHandoffCompletedV1,
} as const;

export type EventName = keyof typeof EVENT_CATALOGUE;
export type EventPayload<N extends EventName> = z.infer<(typeof EVENT_CATALOGUE)[N]>;

export const isKnownEvent = (name: string): name is EventName => name in EVENT_CATALOGUE;

/** Validates a payload against the catalogue. Unknown event names are rejected, not passed through. */
export function validateEventPayload<N extends EventName>(name: N, payload: unknown): EventPayload<N> {
  return EVENT_CATALOGUE[name].parse(payload) as EventPayload<N>;
}
