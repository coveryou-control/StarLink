/**
 * Primitive types shared across every StarLink module.
 *
 * The types in this file are the ones that carry security meaning. They are declared
 * ONCE and shared (doc §15.1) precisely so that a mistake about them is a compile
 * error rather than a leak.
 */

/** UUIDv7 — time-ordered, index-friendly, globally unique (ADR-010). */
export type UUID = string;

/**
 * The RFC-4122 text shape, deliberately without a version nibble.
 *
 * ADR-010 specifies v7 and every id producer in the repository currently mints v4 — a
 * real drift, tracked separately. Pinning the version here would turn that documentation
 * problem into a runtime outage the moment this is used as a guard, so the shape is what
 * is checked. Case-insensitive because Postgres accepts either and normalises on storage.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this an identifier that can safely reach a `uuid` column?
 *
 * Exists because it did not. The realtime gateway accepted ANY string as a conversation
 * id from an untrusted `subscribe` message and passed it to a query against a `uuid`
 * primary key; Postgres raised, the rejection escaped an unhandled `void` promise, and the
 * process exited. One malformed packet from a free customer session terminated every
 * gateway node, repeatably.
 *
 * A type guard rather than an assertion: a caller must decide what to do with a bad id,
 * and on an untrusted boundary the answer is nearly always "refuse quietly", not "throw".
 */
export const isUuid = (value: unknown): value is UUID =>
  typeof value === 'string' && UUID_SHAPE.test(value);

/** ISO-8601 UTC instant. */
export type Timestamp = string;

/**
 * A reference to an object owned by another system.
 *
 * StarLink stores references plus cached display context — never an authoritative
 * copy (brief §2, §4). The `system` discriminator makes "who owns this" explicit at
 * every use site.
 */
export interface CanonicalRef {
  readonly system: 'CCS' | 'HRMS' | 'IAM' | 'LOCAL';
  readonly type: string;
  readonly id: string;
}

/**
 * The single text encoding of a `CanonicalRef`, for columns that store one.
 *
 * `customer_ref` and its siblings are `text` in the schema, so a reference has to be
 * flattened somewhere. Having ONE function do it means the format cannot diverge between
 * a writer and a reader — and it keeps the `system` discriminator in the stored value,
 * so a row never loses track of which authority owns the thing it points at. A bare id
 * would be ambiguous the moment a second upstream system appears.
 */
export const formatCanonicalRef = (ref: CanonicalRef): string =>
  `${ref.system}:${ref.type}:${ref.id}`;

/** Parses the encoding above. Returns undefined for anything that is not one. */
export function parseCanonicalRef(value: string): CanonicalRef | undefined {
  const parts = value.split(':');
  if (parts.length < 3) return undefined;
  const [system, type, ...rest] = parts;
  if (system !== 'CCS' && system !== 'HRMS' && system !== 'IAM' && system !== 'LOCAL') {
    return undefined;
  }
  if (type === undefined || type === '') return undefined;
  // Ids may legitimately contain colons, so only the first two separators are structural.
  const id = rest.join(':');
  if (id === '') return undefined;
  return { system, type, id };
}

/**
 * Cached display context for a canonical object.
 *
 * `cachedAt`/`ttlSeconds` exist so that staleness is always answerable. A consumer
 * that cannot tolerate stale data must re-read through the provider.
 */
export interface CachedContext<T> {
  readonly ref: CanonicalRef;
  readonly value: T;
  readonly cachedAt: Timestamp;
  readonly ttlSeconds: number;
}

/**
 * THE most security-critical type in the product (doc UC-E03, BR-24..27, ADR-021).
 *
 * Visibility is schema, not styling. It is set at write time and if it cannot be
 * established with certainty, the send FAILS rather than defaulting to customer-visible.
 */
export type MessageVisibility = 'INTERNAL' | 'CUSTOMER_VISIBLE';

/** Principal kinds. A customer is never an employee record with a flag (FR-CUST-1). */
export type PrincipalKind = 'EMPLOYEE' | 'CUSTOMER' | 'SYSTEM' | 'AI';

/**
 * Customer identity assurance ladder (brief §7, ADR-019).
 *
 * Required assurance depends on the intended action, not on a blanket rule:
 * general FAQ may be ANONYMOUS; policy/claim/payment access requires VERIFIED+.
 */
export type Assurance =
  | 'ANONYMOUS'
  | 'PSEUDONYMOUS'
  | 'VERIFIED_CUSTOMER'
  | 'AUTHENTICATED_CUSTOMER';

export const ASSURANCE_RANK: Readonly<Record<Assurance, number>> = Object.freeze({
  ANONYMOUS: 0,
  PSEUDONYMOUS: 1,
  VERIFIED_CUSTOMER: 2,
  AUTHENTICATED_CUSTOMER: 3,
});

/** Conversation types (brief §5). Not a hard-coded product taxonomy — see CategoryConfig. */
export type ConversationType =
  | 'INTERNAL_DIRECT'
  | 'INTERNAL_GROUP'
  /**
   * A thread everybody reads and few may write in.
   *
   * Internal in every sense that matters to the rest of the system — no customer, no case,
   * no lifecycle — and different in exactly one: participation does not grant sending.
   * `conversation.announcement.post` does. See `decide()`.
   */
  | 'INTERNAL_ANNOUNCEMENT'
  | 'CUSTOMER_SERVICE'
  | 'CUSTOMER_SALES'
  | 'CUSTOMER_RENEWAL'
  | 'CUSTOMER_CLAIM'
  | 'CUSTOMER_GRIEVANCE'
  | 'CUSTOMER_GENERAL'
  | 'SYSTEM_INTERACTION'
  | 'AI_HANDOFF';

export const CUSTOMER_CONVERSATION_TYPES: readonly ConversationType[] = Object.freeze([
  'CUSTOMER_SERVICE',
  'CUSTOMER_SALES',
  'CUSTOMER_RENEWAL',
  'CUSTOMER_CLAIM',
  'CUSTOMER_GRIEVANCE',
  'CUSTOMER_GENERAL',
  'AI_HANDOFF',
]);

/**
 * Conversation/case lifecycle (brief §24, doc §21.4 as amended by audit item I-2).
 *
 * TRANSFERRED is deliberately absent: transfer is an event, escalation is a level.
 * A single status field could only report one of {escalated, waiting, breached}.
 */
export type ConversationState =
  | 'NEW'
  | 'QUEUED'
  | 'ASSIGNED'
  | 'ACTIVE'
  | 'WAITING_CUSTOMER'
  | 'WAITING_INTERNAL'
  | 'RESOLVED'
  | 'CLOSED';

export type ChannelKind =
  | 'WEBSITE'
  | 'APP'
  | 'WHATSAPP'
  | 'EMAIL'
  | 'SMS'
  | 'VOICE_LINK'
  | 'PUSH'
  | 'INTERNAL';

/** Agent work state. Presence is a hint; this is authoritative for routing (doc §21.9). */
export type AgentWorkState =
  | 'AVAILABLE'
  | 'BUSY'
  | 'BREAK'
  | 'OFFLINE'
  | 'AFTER_CALL'
  | 'TRAINING';

/**
 * Data sensitivity classes.
 *
 * Sales must not automatically see restricted medical claim detail (brief §9), so
 * sensitivity is a first-class input to the authorization decision.
 */
export type SensitivityClass = 'ORDINARY' | 'FINANCIAL' | 'MEDICAL' | 'LEGAL' | 'GRIEVANCE';

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque, HMAC-signed cursor (ADR-010). Absent when there is no further page. */
  readonly nextCursor?: string;
}
