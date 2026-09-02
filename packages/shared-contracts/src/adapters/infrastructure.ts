/**
 * Infrastructure-facing adapter contracts: storage, search, notification transport,
 * event publication, AI.
 */
import type { Page, Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

/* ---------------------------------------------------------------- object storage */

export interface UploadGrantRequest {
  readonly conversationId: UUID;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly purpose: string;
}

export interface UploadGrant {
  readonly url: string;
  /** Always a quarantine-prefixed key. Nothing is reachable until scanned and promoted. */
  readonly quarantineKey: string;
  readonly expiresAt: Timestamp;
}

export interface ObjectStorageProvider extends HealthReporting {
  issueUploadGrant(request: UploadGrantRequest): Promise<Result<UploadGrant>>;
  promote(quarantineKey: string): Promise<Result<{ cleanKey: string }>>;
  /**
   * Issued ONLY after the full authorization ladder has passed, short-lived and scoped
   * to one object; the issuance itself is the audited event (ADR-012).
   */
  issueDownloadGrant(cleanKey: string, ttlSeconds: number): Promise<Result<{ url: string }>>;
  delete(key: string): Promise<Result<void>>;
}

/* ------------------------------------------------------------------ notifications */

export interface NotificationRequest {
  readonly recipientId: UUID;
  readonly recipientKind: 'EMPLOYEE' | 'CUSTOMER';
  readonly event: string;
  /** What the notification is ABOUT — a conversation, a case. Part of the dedupe key. */
  readonly targetRef?: string;
  /**
   * Structured, and never message content. §29 notifications tell somebody there is
   * something to look at; the thing itself stays behind the authorization that guards it.
   */
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Domain-facing. Writes outbox rows and returns — P-05, and §29.1's ordering: "the record
 * is written first, then delivery is attempted. A notification that fails must never mean
 * a message that was not stored."
 *
 * `RenderedNotification`, `DeliveryVerdict` and `NotificationTransport` are declared with
 * the other transport contracts further down; only the domain-facing half lives here.
 */
export interface NotificationClient {
  enqueue(request: NotificationRequest): Promise<Result<{ outboxId: UUID }>>;
}

/* -------------------------------------------------------------- attachment scanning */

export interface ScanRequest {
  readonly attachmentId: UUID;
  readonly quarantineKey: string;
  /** What the uploader CLAIMED. The scanner reports what it actually found. */
  readonly declaredMime: string;
  readonly declaredBytes: number;
}

/**
 * What a scanner found. Part IV §59: "content-sniff MIME by content, malware, archive
 * bombs, macro risk, DLP/PII classification and optional OCR metadata."
 *
 * The three verdicts are deliberately distinct rather than a boolean plus a reason.
 * INFECTED is terminal and its row is evidence; REJECTED is a policy failure — an
 * oversized file, a MIME mismatch, an archive bomb — and reads very differently in an
 * audit. Collapsing them would make "we blocked malware" and "the file was too big"
 * indistinguishable after the fact.
 */
export type ScanVerdict =
  | {
      readonly verdict: 'CLEAN';
      /** Sniffed from CONTENT, never from the extension or the declared type. */
      readonly sniffedMime: string;
      readonly actualBytes: number;
      readonly scanner: string;
      /** DLP/PII classification where the scanner offers one (§58). */
      readonly classification?: string;
    }
  | {
      readonly verdict: 'INFECTED';
      readonly signature: string;
      readonly scanner: string;
    }
  | {
      readonly verdict: 'REJECTED';
      readonly reason: string;
      readonly sniffedMime?: string;
      readonly actualBytes?: number;
      readonly scanner: string;
    };

export interface AttachmentScanner extends HealthReporting {
  scan(request: ScanRequest): Promise<Result<ScanVerdict>>;
}

/* ----------------------------------------------------------------------- search */

/**
 * The scope a search runs inside.
 *
 * A REQUIRED parameter of `search` rather than an internal filter, so that "query the
 * whole corpus then filter" — the classic leak of doc §30.2 — cannot be written
 * accidentally: without a scope, the call does not compile.
 *
 * **Every implementation MUST enforce `principalId`.** It is the authoritative scope:
 * results may only come from conversations this principal may already read. A provider
 * that ignored it would be a complete copy of every conversation with the
 * authorization removed, which is precisely why §30.4 defers a dedicated engine rather
 * than pre-building one.
 *
 * `conversationIds` is optional NARROWING on top of that (searching within one thread),
 * never a widening: supplying it can only reduce the result set.
 */
export interface AuthorizedScope {
  readonly principalId: UUID;
  /** Optional narrowing. Absent means "everywhere this principal may read". */
  readonly conversationIds?: readonly UUID[];
  /**
   * Whether internal notes are eligible. TRUE for staff participants (§30.5), and
   * FALSE on every customer path — enforced at the query, never by the caller
   * remembering to filter afterwards.
   */
  readonly includeInternal: boolean;
}

export interface SearchDocument {
  readonly documentId: UUID;
  readonly conversationId: UUID;
  readonly body: string;
  readonly includeInCustomerSearch: boolean;
  readonly createdAt: Timestamp;
}

export interface SearchHit {
  readonly documentId: UUID;
  readonly conversationId: UUID;
  readonly snippet: string;
  readonly score: number;
  /**
   * Enough context to tell two results apart without opening either.
   *
   * A hit used to be a fragment of text and a pair of ids, so a search for a common word
   * returned a column of sentences with no author, no thread and no date — and the only
   * way to tell which one you wanted was to open them in turn.
   *
   * `senderDisplayName` is optional because a system-authored message has no sender and
   * must still be findable. The conversation's NAME is deliberately not here: the client
   * already holds it for every thread it can see, so sending it would be a second copy of
   * something that can disagree with the sidebar.
   */
  readonly createdAt: Timestamp;
  readonly senderDisplayName?: string;
}

export interface SearchProvider extends HealthReporting {
  index(document: SearchDocument): Promise<Result<void>>;
  search(scope: AuthorizedScope, query: string, cursor?: string): Promise<Result<Page<SearchHit>>>;
  /** Retention and erasure propagate here too (brief §29). */
  remove(documentId: UUID): Promise<Result<void>>;
}

/* ----------------------------------------------------------------- notification */

export type NotificationChannel = 'INAPP' | 'EMAIL' | 'PUSH' | 'WHATSAPP' | 'SMS';

export interface RenderedNotification {
  readonly recipientPrincipalId: UUID;
  readonly channel: NotificationChannel;
  readonly subject?: string;
  readonly body: string;
  readonly deepLink?: string;
}

export type DeliveryVerdict = 'DELIVERED' | 'RETRYABLE' | 'PERMANENT_FAILURE';

export interface NotificationTransport extends HealthReporting {
  readonly channel: NotificationChannel;
  deliver(payload: RenderedNotification, idempotencyKey: string): Promise<Result<DeliveryVerdict>>;
}

/* ---------------------------------------------------------------------- events */

export interface DomainEventEnvelope {
  readonly eventId: UUID;
  readonly name: string;
  readonly version: number;
  readonly occurredAt: Timestamp;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actorRef?: { readonly kind: string; readonly id: string };
  /** IDs, classifications and metadata only — never message bodies or raw PII (brief §45). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisher extends HealthReporting {
  /** Called ONLY by the outbox relay, never inline by domain code (ADR-006). */
  publish(events: readonly DomainEventEnvelope[]): Promise<Result<void>>;
}

/* -------------------------------------------------------------------------- AI */

/**
 * Every AI output is advisory and carries its provenance.
 *
 * AI is an assistant, not an authority (brief §36): it never decides identity,
 * consent, routing hard constraints, authorization, or payment/claim/policy state.
 */
export interface Advisory<T> {
  readonly value: T;
  readonly model: string;
  readonly promptVersion: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
  readonly generatedAt: Timestamp;
}

/** A reference to transcript content that has already passed redaction. */
export interface RedactedTranscriptRef {
  readonly conversationId: UUID;
  readonly upToSeq: number;
  readonly redactionProfile: string;
}

export interface IntentClassification {
  readonly category: string;
  readonly subCategory?: string;
  readonly language?: string;
  readonly urgency?: 'LOW' | 'NORMAL' | 'HIGH';
}

export interface AIProvider extends HealthReporting {
  classifyIntent(input: RedactedTranscriptRef): Promise<Result<Advisory<IntentClassification>>>;
  summarise(
    kind: 'HANDOFF' | 'THREAD' | 'QUEUE',
    ref: RedactedTranscriptRef,
  ): Promise<Result<Advisory<{ summary: string; facts: readonly string[] }>>>;
  draftReply(ref: RedactedTranscriptRef): Promise<Result<Advisory<{ draft: string }>>>;
  answerFromKnowledge(
    question: string,
    corpus: 'PUBLIC' | 'AUTHORIZED',
  ): Promise<Result<Advisory<{ answer: string; citations: readonly string[] }>>>;
  assessRisk(
    kind: 'MIS_SELLING' | 'DLP' | 'SENTIMENT' | 'URGENCY',
    ref: RedactedTranscriptRef,
  ): Promise<Result<Advisory<{ signal: string; severity: number }>>>;
  extractActions(ref: RedactedTranscriptRef): Promise<Result<Advisory<readonly { action: string }[]>>>;
}
