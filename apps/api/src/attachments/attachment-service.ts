/**
 * The work behind both attachment surfaces, shared so the two cannot drift.
 *
 * The employee and customer controllers stay separate — §25.3 and ADR-004 keep the route
 * trees disjoint, and this is not a shared controller. What is shared is the SEQUENCE:
 * check policy, ask storage for a grant, record metadata; and on the way out, run §28.4's
 * ladder, audit, then issue a grant. Duplicating those in two controllers is how the
 * customer path ends up missing a step the employee path has — which is precisely the
 * defect §38 records in the reference platform's two authorization paths.
 *
 * Everything that DIFFERS between the surfaces arrives as an argument: the uploader kind
 * (which selects the policy, including D-07's Claims-only rule), and the actor kind
 * (which decides whether step 4 applies).
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  AttachmentScanner,
  ObjectStorageProvider,
  PrincipalKind,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import type { PgAttachmentStore } from '@starlink/database';
import type { Logger } from '@starlink/observability';
import {
  checkUploadIntent,
  sanitiseFilename,
  DEFAULT_POLICY,
  type UploadRefusal,
} from '@starlink/attachments';
import {
  ATTACHMENT_SCANNER,
  ATTACHMENT_STORE,
  CONFIG,
  LOGGER,
  OBJECT_STORAGE,
} from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { AuditWriter } from '../audit/audit-writer.js';
import { AUDIT_WRITER } from '../tokens.js';
import {
  decideAttachmentAccess,
  type AccessPorts,
  type AccessRefusal,
} from './attachment-access.js';

export type GrantOutcome =
  | {
      readonly ok: true;
      readonly attachmentId: UUID;
      readonly uploadUrl: string;
      readonly expiresAt: Timestamp;
    }
  | { readonly ok: false; readonly refusal: UploadRefusal | 'STORAGE_UNAVAILABLE' };

export type DownloadOutcome =
  | { readonly ok: true; readonly url: string; readonly filename: string }
  | { readonly ok: false; readonly refusal: AccessRefusal | 'STORAGE_UNAVAILABLE' };

@Injectable()
export class AttachmentService {
  constructor(
    @Inject(ATTACHMENT_STORE) private readonly store: PgAttachmentStore,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageProvider,
    @Inject(ATTACHMENT_SCANNER) private readonly scanner: AttachmentScanner,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Issues an upload grant, or refuses before any bytes exist.
   *
   * §28.1: "reject → no bytes stored". The policy check runs BEFORE storage is asked for
   * anything, so a refused upload leaves nothing behind to clean up — and a customer
   * attaching to a non-Claims conversation (D-07) never reaches object storage at all.
   */
  async grantUpload(input: {
    conversationId: UUID;
    categoryId?: string;
    uploaderId: UUID;
    uploaderKind: PrincipalKind;
    declaredMime: string;
    declaredBytes: number;
    filename: string;
    correlationId: string;
  }): Promise<GrantOutcome> {
    const permitted = checkUploadIntent(DEFAULT_POLICY, {
      uploaderKind: input.uploaderKind,
      declaredMime: input.declaredMime,
      declaredBytes: input.declaredBytes,
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    });

    if (!permitted.ok) {
      // Audited: a refused upload is a thing somebody tried, and D-07's boundary in
      // particular is worth being able to count.
      await this.audit.record({
        actorId: input.uploaderId,
        actorKind: input.uploaderKind,
        action: 'attachment.upload.refused',
        targetKind: 'conversation',
        targetId: input.conversationId,
        outcome: 'REFUSED',
        reason: permitted.refusal,
        correlationId: input.correlationId,
        detail: { declaredMime: input.declaredMime, declaredBytes: input.declaredBytes },
      });
      return { ok: false, refusal: permitted.refusal };
    }

    const grant = await this.storage.issueUploadGrant({
      conversationId: input.conversationId,
      declaredMime: input.declaredMime,
      declaredBytes: input.declaredBytes,
      purpose: 'conversation-attachment',
    });

    if (!grant.ok) {
      // FAIL_DEGRADED by contract: the conversation continues without the file (§34).
      this.logger.warn('upload grant unavailable', {
        correlationId: input.correlationId,
        operation: 'attachment.upload.grant',
        outcome: 'FAILED',
        errorCode: grant.error.code,
      });
      return { ok: false, refusal: 'STORAGE_UNAVAILABLE' };
    }

    const attachmentId = crypto.randomUUID() as UUID;
    await this.store.grant({
      attachmentId,
      conversationId: input.conversationId,
      uploaderId: input.uploaderId,
      uploaderKind: input.uploaderKind,
      declaredMime: input.declaredMime,
      declaredBytes: input.declaredBytes,
      // §28.3: sanitised, held as metadata, never used as a key or echoed into a path.
      originalFilename: sanitiseFilename(input.filename),
      quarantineKey: grant.value.quarantineKey,
      at: new Date().toISOString() as Timestamp,
      unboundTtlSeconds: this.config.SL_ATTACHMENT_UNBOUND_TTL_SECONDS,
    });

    return {
      ok: true,
      attachmentId,
      uploadUrl: grant.value.url,
      expiresAt: grant.value.expiresAt as Timestamp,
    };
  }

  /**
   * Marks an uploaded object as ready to scan.
   *
   * Separate from the grant because the client uploads DIRECTLY to storage (ADR-012) and
   * the application never sees the bytes. This is the client saying "I finished", and it
   * is only a hint — the scan sweep would find an abandoned upload anyway through the
   * expiry path, and nothing here trusts the claim beyond moving it into the queue.
   */
  async markUploaded(attachmentId: UUID, uploaderId: UUID): Promise<boolean> {
    const record = await this.store.byId(attachmentId);
    // Only the uploader may announce their own upload, and only once.
    if (record === undefined || record.uploaderId !== uploaderId) return false;
    return this.store.transition({
      attachmentId,
      from: 'UPLOAD_GRANTED',
      to: 'QUARANTINED',
      at: new Date().toISOString() as Timestamp,
    });
  }

  /**
   * The scan state of an attachment, for the person who uploaded it.
   *
   * ## Why this is needed
   *
   * §28.1 will not bind anything that is not CLEAN, and the scan is asynchronous — a sweep
   * moves QUARANTINED → CLEAN / INFECTED / REJECTED. Until now nothing told the uploader
   * when that happened, so the composer marked a file "ready to send" the moment the bytes
   * were accepted. Sending at that point produced a message with no attachment, the id came
   * back in `notAttachedIds`, and no surface read it. The interface reported a document as
   * sent that had never been attached to anything.
   *
   * ## Why the uploader only
   *
   * The same rule `markUploaded` applies, and for the same reason: an unbound attachment is
   * reachable by nobody (§28.1), so there is no participation to check against — the
   * uploader is the only person who has a relationship with it yet. Returning `undefined`
   * for anybody else makes "not yours" and "no such attachment" one answer (§27.3).
   *
   * The state is not customer content and not a key. It is the answer to "is my file ready",
   * asked by the person who is waiting for it.
   */
  async uploadState(attachmentId: UUID, uploaderId: UUID): Promise<string | undefined> {
    const record = await this.store.byId(attachmentId);
    if (record === undefined || record.uploaderId !== uploaderId) return undefined;
    return record.state;
  }

  /**
   * Binds clean attachments to a message, reporting which actually attached.
   *
   * Partial success is the honest outcome. A file still being scanned cannot be bound
   * yet, and holding the MESSAGE until it is would make the text hostage to the file —
   * the opposite of §34's degradation rule. The caller gets both lists so a surface can
   * say "still checking your document" instead of silently dropping it.
   */
  async bindAll(input: {
    attachmentIds: readonly UUID[];
    messageId: UUID;
    conversationId: UUID;
  }): Promise<{ bound: UUID[]; notBound: UUID[] }> {
    const bound: UUID[] = [];
    const notBound: UUID[] = [];
    for (const attachmentId of input.attachmentIds) {
      const ok = await this.store.bind({
        attachmentId,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      (ok ? bound : notBound).push(attachmentId);
    }
    return { bound, notBound };
  }

  /**
   * §28.4's ladder, then the audit, then the grant — in that order.
   *
   * FR-ATT-5 requires the download to be attributable. ADR-012 accepts that a signed URL
   * audits the ISSUANCE rather than the fetch, and the trade is explicit rather than
   * accidental: the audit is written before the URL exists, so a grant that reached a
   * caller was always recorded.
   *
   * Refusals are audited too. A customer reaching for an internal-note attachment is the
   * single most interesting thing this endpoint can be asked to do.
   */
  async grantDownload(input: {
    attachmentId: UUID;
    actor: { principalId: UUID; kind: 'EMPLOYEE' | 'CUSTOMER' };
    ports: AccessPorts;
    correlationId: string;
  }): Promise<DownloadOutcome> {
    const record = await this.store.byId(input.attachmentId);
    const decision = await decideAttachmentAccess(record, input.actor, input.ports);

    if (!decision.ok) {
      await this.audit.record({
        actorId: input.actor.principalId,
        actorKind: input.actor.kind,
        action: 'attachment.download.refused',
        targetKind: 'attachment',
        targetId: input.attachmentId,
        outcome: 'REFUSED',
        reason: decision.refusal,
        correlationId: input.correlationId,
        ...(record !== undefined ? { detail: { conversationId: record.conversationId } } : {}),
      });
      return { ok: false, refusal: decision.refusal };
    }

    /**
     * Audited BEFORE the grant exists. A crash between the two loses a download that
     * never happened, which is the harmless direction; the reverse would hand out bytes
     * with no record.
     *
     * The sensitivity and the DLP classification are recorded on the entry, which is what
     * turns §58's "high-risk download is audited … where policy requires" into something
     * answerable. Without them the ledger says a file was fetched; with them it says
     * whether it was a routine sales PDF or a medical report, and "who has been reading
     * restricted material" becomes a query rather than an investigation.
     *
     * The classification is whatever a scanner supplied and is usually absent today —
     * the dev stub produces none, and a real DLP provider is N-06. That absence is
     * visible in the ledger rather than hidden, which is the honest state.
     */
    await this.audit.record({
      actorId: input.actor.principalId,
      actorKind: input.actor.kind,
      action: 'attachment.download',
      targetKind: 'attachment',
      targetId: input.attachmentId,
      outcome: 'SUCCEEDED',
      correlationId: input.correlationId,
      detail: {
        conversationId: record!.conversationId,
        // Inherited from the conversation (§58), so a reclassified thread reclassifies
        // its attachments without a migration.
        sensitivity: record!.sensitivity ?? 'ORDINARY',
        dlpClassification: record!.classification ?? 'NONE',
      },
    });

    const url = await this.storage.issueDownloadGrant(
      decision.cleanKey,
      this.config.SL_ATTACHMENT_DOWNLOAD_TTL_SECONDS,
    );
    if (!url.ok) return { ok: false, refusal: 'STORAGE_UNAVAILABLE' };

    return { ok: true, url: url.value.url, filename: decision.filename };
  }

  /**
   * Attachment metadata for a page of messages (§34.4).
   *
   * A read-through: the authorization for these rows is the authorization for the
   * conversation the messages belong to, which the caller has already performed — this
   * returns metadata only, never a key and never a URL. A download URL is issued one
   * object at a time, after §28.4's full ladder, and audited at issuance.
   */
  forMessages(messageIds: readonly UUID[]): ReturnType<PgAttachmentStore['forMessages']> {
    return this.store.forMessages(messageIds);
  }

  /** Exposed for health: an operator must be able to see the scanner is a stub. */
  scannerHealth(): ReturnType<AttachmentScanner['health']> {
    return this.scanner.health();
  }
}
