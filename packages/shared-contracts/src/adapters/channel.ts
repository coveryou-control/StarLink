/**
 * Channel adapter contract (brief §26, doc Part IV §56).
 *
 * One contract for every external channel. The canonical Conversation/Message model
 * stays channel-independent; channel-specific facts live in ChannelSession metadata.
 */
import type { ChannelKind, MessageVisibility, Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

/**
 * Outbound message as handed to a channel.
 *
 * `visibility` is present so the adapter can reject anything that is not explicitly
 * customer-deliverable. This is the fourth independent layer of the internal-note
 * boundary (ADR-021) — the type makes the check possible; the implementation MUST
 * perform it.
 */
export interface OutboundChannelMessage {
  readonly messageId: UUID;
  readonly conversationId: UUID;
  readonly channelSessionId: UUID;
  readonly visibility: MessageVisibility;
  readonly body: string;
  readonly attachmentIds?: readonly UUID[];
  readonly templateRef?: string;
}

export interface ProviderAccept {
  readonly providerMessageId: string;
  readonly acceptedAt: Timestamp;
}

export interface VerifiedWebhook {
  readonly providerEventId: string;
  readonly receivedAt: Timestamp;
  readonly payload: unknown;
}

export interface InboundChannelEvent {
  readonly kind: 'MESSAGE' | 'DELIVERY_STATUS' | 'READ' | 'SESSION_EVENT';
  readonly externalThreadId: string;
  readonly externalIdentity: ExternalIdentity;
  readonly occurredAt: Timestamp;
  /** Stable per provider event — the key that makes duplicate webhooks harmless. */
  readonly idempotencyKey: string;
  readonly body?: string;
  readonly mediaRefs?: readonly ProviderMediaRef[];
}

export interface ExternalIdentity {
  readonly channel: ChannelKind;
  readonly externalId: string;
  readonly displayName?: string;
}

export interface ChannelBindingHint {
  readonly channel: ChannelKind;
  readonly externalThreadId: string;
  readonly externalIdentity: ExternalIdentity;
}

export interface ProviderMediaRef {
  readonly providerMediaId: string;
  readonly declaredMime?: string;
  readonly declaredBytes?: number;
}

export interface QuarantineUploadTicket {
  readonly attachmentId: UUID;
  readonly quarantineKey: string;
}

/**
 * UNKNOWN is deliberately a first-class status.
 *
 * An ambiguous provider result must trigger reconciliation, never be optimistically
 * treated as delivered (doc Part IV §53).
 */
export type DeliveryStatus = 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN' | 'SUPERSEDED';

export interface DeliveryStatusUpdate {
  readonly providerMessageId: string;
  readonly status: DeliveryStatus;
  readonly occurredAt: Timestamp;
  readonly reasonCode?: string;
}

export interface ReconciliationReport {
  readonly checked: number;
  readonly corrected: number;
  readonly stillUnknown: number;
}

export interface ChannelAdapter extends HealthReporting {
  readonly channel: ChannelKind;
  send(message: OutboundChannelMessage, idempotencyKey: string): Promise<Result<ProviderAccept>>;
  verifyWebhook(headers: Readonly<Record<string, string>>, rawBody: Buffer): Promise<Result<boolean>>;
  receiveWebhook(envelope: VerifiedWebhook): Promise<Result<readonly InboundChannelEvent[]>>;
  mapExternalIdentity(identity: ExternalIdentity): Promise<Result<{ bindingHint: ChannelBindingHint }>>;
  mapDeliveryStatus(providerEvent: unknown): Promise<Result<DeliveryStatusUpdate>>;
  /** Media enters the quarantine→scan→promote pipeline; it is never trusted inline (ADR-012). */
  downloadMedia(ref: ProviderMediaRef): Promise<Result<QuarantineUploadTicket>>;
  reconcile(since: Timestamp): Promise<Result<ReconciliationReport>>;
}
