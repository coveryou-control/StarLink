/**
 * Attachment metadata persistence (doc §28.3, §28.4, ADR-012).
 *
 * §28.3: **"The metadata is the authority; storage holds only bytes."** Every question
 * about an attachment — may this person see it, has it been scanned, is it bound to a
 * message — is answered from this table, never from what happens to be in a bucket. A
 * file present in clean storage with no metadata row is unreachable, and that is correct.
 *
 * ## The storage key is never derived from anything meaningful
 *
 * §28.3 again: a key "containing a conversation id, customer name or original filename
 * leaks information and invites enumeration". Keys arrive already opaque from the storage
 * adapter; this module stores them and never constructs one.
 *
 * ## State transitions are conditional, not read-then-write
 *
 * Every state change below carries a `WHERE state = …` predicate. A scan verdict arriving
 * twice, a bind racing an expiry sweep, a promotion of something already promoted — each
 * updates zero rows and the caller is told, rather than two writers overwriting each
 * other. The pipeline's own refusals (`packages/attachments`) decide what is legal; these
 * predicates make the decision hold under concurrency.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { AttachmentState } from '@starlink/attachments';

export interface AttachmentRecord {
  readonly attachmentId: UUID;
  readonly conversationId: UUID;
  readonly messageId?: UUID;
  readonly uploaderId?: UUID;
  readonly uploaderKind: string;
  readonly declaredMime: string;
  readonly sniffedMime?: string;
  readonly declaredBytes: number;
  readonly actualBytes?: number;
  readonly originalFilename?: string;
  readonly quarantineKey?: string;
  readonly cleanKey?: string;
  readonly state: AttachmentState;
  /** The DLP/PII verdict for THESE bytes, where a scanner supplied one (§58, §59). */
  readonly classification?: string;
  /**
   * Inherited from the conversation, never stored here (§58). Absent only where the
   * caller used a query that did not join it.
   */
  readonly sensitivity?: string;
  readonly createdAt: Timestamp;
  readonly expiresAt?: Timestamp;
}

const toRecord = (row: Record<string, unknown>): AttachmentRecord => ({
  attachmentId: row.attachment_id as UUID,
  conversationId: row.conversation_id as UUID,
  ...(row.message_id !== null ? { messageId: row.message_id as UUID } : {}),
  ...(row.uploader_id !== null ? { uploaderId: row.uploader_id as UUID } : {}),
  uploaderKind: row.uploader_kind as string,
  declaredMime: row.declared_mime as string,
  ...(row.sniffed_mime !== null ? { sniffedMime: row.sniffed_mime as string } : {}),
  declaredBytes: Number(row.declared_bytes),
  ...(row.actual_bytes !== null ? { actualBytes: Number(row.actual_bytes) } : {}),
  ...(row.original_filename !== null ? { originalFilename: row.original_filename as string } : {}),
  ...(row.quarantine_key !== null ? { quarantineKey: row.quarantine_key as string } : {}),
  ...(row.clean_key !== null ? { cleanKey: row.clean_key as string } : {}),
  state: row.state as AttachmentState,
  ...(row.classification !== null ? { classification: row.classification as string } : {}),
  ...(row.conversation_sensitivity !== undefined && row.conversation_sensitivity !== null
    ? { sensitivity: row.conversation_sensitivity as string }
    : {}),
  createdAt: (row.created_at as Date).toISOString() as Timestamp,
  ...(row.expires_at !== null
    ? { expiresAt: (row.expires_at as Date).toISOString() as Timestamp }
    : {}),
});

export class PgAttachmentStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Records an upload grant. The row exists before any bytes do.
   *
   * `expires_at` is set here rather than when the upload completes: an attachment that
   * is granted and never uploaded is exactly the orphan §28.6 expires, and giving it a
   * deadline at the only moment we are certain to be running is what makes it
   * collectable.
   */
  async grant(input: {
    attachmentId: UUID;
    conversationId: UUID;
    uploaderId: UUID;
    uploaderKind: string;
    declaredMime: string;
    declaredBytes: number;
    originalFilename: string;
    quarantineKey: string;
    at: Timestamp;
    unboundTtlSeconds: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation.attachments
         (attachment_id, conversation_id, uploader_id, uploader_kind, declared_mime,
          declared_bytes, original_filename, quarantine_key, state, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UPLOAD_GRANTED',$9,
               $9::timestamptz + make_interval(secs => $10))`,
      [
        input.attachmentId,
        input.conversationId,
        input.uploaderId,
        input.uploaderKind,
        input.declaredMime,
        input.declaredBytes,
        input.originalFilename,
        input.quarantineKey,
        input.at,
        input.unboundTtlSeconds,
      ],
    );
  }

  /**
   * One attachment, with the sensitivity it INHERITS from its conversation (§58).
   *
   * §58: "Attachments inherit conversation/object sensitivity but also get their own
   * classification, malware/DLP result, retention and download policy."
   *
   * Inherited by JOIN rather than copied onto the row, for the same reason the SLA clock
   * is computed rather than stored: a conversation reclassified as MEDICAL next week must
   * make its existing attachments medical too, and a denormalised copy would need a
   * backfill nobody would remember to run. `classification` stays on the attachment,
   * because that one IS its own — it describes these bytes, not the thread.
   */
  async byId(attachmentId: UUID): Promise<AttachmentRecord | undefined> {
    const result = await this.pool.query(
      `SELECT a.*, c.sensitivity AS conversation_sensitivity
         FROM conversation.attachments a
         JOIN conversation.conversations c ON c.conversation_id = a.conversation_id
        WHERE a.attachment_id = $1`,
      [attachmentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * The same record, found by the storage key the upload grant issued.
   *
   * Exists for the development object endpoint, which is addressed by the opaque object id
   * from the grant rather than by attachment id — a pre-signed URL never carries the
   * application's own identifiers. It needs the record to refuse a SECOND write: bytes may
   * only arrive while the object is still `UPLOAD_GRANTED`, because a write after the scan
   * has begun changes the content underneath a verdict.
   *
   * `quarantine_key` is `text` with NO index and NO unique constraint
   * (`0001_foundation.sql:569`), so this is a sequential scan. That is acceptable only
   * because the route that calls it refuses outside `dev`/`test`, where the table is small;
   * it is stated rather than assumed so nobody promotes this to a production path without
   * adding the index first. Uniqueness holds by construction — the key is
   * `quarantine/<randomUUID>` minted per grant — but it is not enforced by the schema.
   */
  async byQuarantineKey(quarantineKey: string): Promise<AttachmentRecord | undefined> {
    const result = await this.pool.query(
      `SELECT a.*, c.sensitivity AS conversation_sensitivity
         FROM conversation.attachments a
         JOIN conversation.conversations c ON c.conversation_id = a.conversation_id
        WHERE a.quarantine_key = $1`,
      [quarantineKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Moves an attachment to a new state, only if it is still in the state expected.
   *
   * Returns false when the row had moved on. That is not an error: a scan worker retrying
   * after a timeout, and a sweep expiring an abandoned upload, legitimately race.
   */
  async transition(input: {
    attachmentId: UUID;
    from: AttachmentState;
    to: AttachmentState;
    at: Timestamp;
    sniffedMime?: string;
    actualBytes?: number;
    cleanKey?: string;
    classification?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.attachments
          SET state = $3,
              sniffed_mime = COALESCE($4, sniffed_mime),
              actual_bytes = COALESCE($5, actual_bytes),
              clean_key = COALESCE($6, clean_key),
              classification = COALESCE($7, classification)
        WHERE attachment_id = $1 AND state = $2`,
      [
        input.attachmentId,
        input.from,
        input.to,
        input.sniffedMime ?? null,
        input.actualBytes ?? null,
        input.cleanKey ?? null,
        input.classification ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Binds a clean attachment to a message. The moment it becomes reachable (§28.1).
   *
   * Conditional on CLEAN, so nothing in quarantine, mid-scan or infected can be attached
   * by a caller that skipped the pipeline. `expires_at` is cleared because a bound
   * attachment now follows the conversation's retention, not its own (§28.6) — leaving it
   * set would let the expiry sweep collect a live claim document.
   */
  async bind(input: {
    attachmentId: UUID;
    messageId: UUID;
    conversationId: UUID;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.attachments
          SET message_id = $2, state = 'BOUND', expires_at = NULL
        WHERE attachment_id = $1
          AND state = 'CLEAN'
          -- The message must belong to the SAME conversation. Without this, a caller
          -- could bind a document from one customer's thread onto another's message,
          -- and access is derived from the conversation (§28.4 step 3).
          AND conversation_id = $3`,
      [input.attachmentId, input.messageId, input.conversationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Everything bound to a message, for rendering a thread. */
  async forMessage(messageId: UUID): Promise<readonly AttachmentRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.attachments
        WHERE message_id = $1 AND state = 'BOUND'
        ORDER BY created_at`,
      [messageId],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Every BOUND attachment for a page of messages, in one query.
   *
   * The single-message version above is right for a download decision; a thread page asks
   * about fifty at once, and calling it per message would turn one page render into fifty
   * round trips. `state = 'BOUND'` is the same predicate for the same reason: §28.1 makes
   * BOUND the only state a recipient may reach, so an unbound row must not appear in a
   * list a recipient reads.
   */
  async forMessages(messageIds: readonly UUID[]): Promise<readonly AttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM conversation.attachments
        WHERE message_id = ANY($1::uuid[]) AND state = 'BOUND'
        ORDER BY created_at`,
      [messageIds],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Records a scan verdict. Append-only — a second opinion never overwrites the first.
   *
   * §24.3's discipline applied to scanning: the verdict that caused a rejection must
   * stay readable, or "why was this blocked" becomes unanswerable.
   */
  async recordScan(input: {
    attachmentId: UUID;
    /** CLEAN · INFECTED · SUSPICIOUS · REJECTED · FAILED — see migration 0007. */
    verdict: string;
    scanner: string;
    /** Structured, never a message body or file contents (§32 redaction rules). */
    detail?: Readonly<Record<string, string | number | boolean>>;
    at: Timestamp;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation.attachment_scan_results
         (scan_id, attachment_id, verdict, scanner, scanned_at, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        crypto.randomUUID(),
        input.attachmentId,
        input.verdict,
        input.scanner,
        input.at,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ],
    );
  }

  /** Quarantined uploads awaiting a scan, oldest first. */
  async awaitingScan(limit: number): Promise<readonly AttachmentRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.attachments
        WHERE state = 'QUARANTINED'
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Unbound uploads whose deadline has passed (§28.6).
   *
   * `message_id IS NULL` as well as the state list, belt and braces: a bound attachment
   * must never be collectable, and the two conditions would have to fail together for
   * that to happen. Compared against the APPLICATION clock (ADR-025), because
   * `expires_at` was written by the application.
   */
  async expirable(at: Timestamp, limit: number): Promise<readonly AttachmentRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.attachments
        WHERE message_id IS NULL
          AND state IN ('UPLOAD_GRANTED','QUARANTINED','SCANNING','CLEAN')
          AND expires_at IS NOT NULL
          AND expires_at <= $1
        ORDER BY expires_at
        LIMIT $2`,
      [at, limit],
    );
    return result.rows.map(toRecord);
  }
}
