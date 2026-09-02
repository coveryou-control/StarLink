/**
 * The attachment sweeps: scanning quarantined uploads, and expiring unbound ones.
 *
 * ## Why scanning is a sweep rather than a queued job
 *
 * ADR-006 puts async work on BullMQ over Redis, and Redis is not here yet — sanctioned
 * for V1-A by Part IV §67, with the adoption trigger recorded in ADR-006. Rather than
 * hold the pipeline until it is, the scan runs from COMMITTED STATE: a quarantined
 * attachment is a row, and the sweep finds it whether the process that granted the upload
 * crashed, restarted, or never ran the follow-up. That is the same property the routing
 * sweep has, and it is the reason neither needed a queue to be correct.
 *
 * When the queue fabric arrives this becomes a consumer with no change to the pipeline —
 * the state machine, the policy checks and the promote step are all here already, and a
 * job would only change what wakes them.
 *
 * ## The order of operations is the security property
 *
 * QUARANTINED → SCANNING → verdict → (policy re-check) → promote → CLEAN
 *
 * Promotion happens LAST, after both the scanner's verdict and the policy re-check
 * (`checkReceived`), because promoting is what moves bytes out of quarantine. §28.1: "AN
 * UPLOADED-BUT-UNSENT ATTACHMENT IS REACHABLE BY NOBODY", and a file promoted before it
 * has passed everything is a file that was briefly reachable while still unproven.
 *
 * The scanner's verdict is not sufficient on its own. It reports what the bytes ARE;
 * `checkReceived` decides whether that is what the uploader was allowed to send — a
 * distinction that matters because the scanner has no idea what the allow-list says.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { AttachmentScanner, ObjectStorageProvider } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { METRICS, metrics } from '@starlink/observability';
import { advance, checkReceived, type AttachmentPolicy, type AttachmentState } from '@starlink/attachments';

import type { SweepOutcome } from './case-sweeps.js';

/** The metadata operations both attachment sweeps need. Implemented by `PgAttachmentStore`. */
export interface AttachmentStorePort {
  awaitingScan(limit: number): Promise<readonly AttachmentMetadata[]>;
  expirable(at: Timestamp, limit: number): Promise<readonly AttachmentMetadata[]>;
  transition(input: {
    attachmentId: UUID;
    from: AttachmentState;
    to: AttachmentState;
    at: Timestamp;
    sniffedMime?: string;
    actualBytes?: number;
    cleanKey?: string;
    classification?: string;
  }): Promise<boolean>;
  recordScan(input: {
    attachmentId: UUID;
    verdict: string;
    scanner: string;
    detail?: Readonly<Record<string, string | number | boolean>>;
    at: Timestamp;
  }): Promise<void>;
}

export interface AttachmentMetadata {
  readonly attachmentId: UUID;
  readonly conversationId: UUID;
  readonly uploaderKind: string;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly quarantineKey?: string;
  readonly cleanKey?: string;
  readonly state: AttachmentState;
}

export interface AttachmentScanSweepDeps {
  readonly store: AttachmentStorePort;
  readonly scanner: AttachmentScanner;
  readonly storage: ObjectStorageProvider;
  readonly policy: AttachmentPolicy;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export class AttachmentScanSweep {
  constructor(private readonly deps: AttachmentScanSweepDeps) {}

  async run(): Promise<SweepOutcome> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString() as Timestamp;
    const waiting = await this.deps.store.awaitingScan(this.deps.batchSize ?? 20);

    let acted = 0;
    for (const attachment of waiting) {
      if (await this.process(attachment, at)) acted += 1;
    }

    metrics.set(METRICS.attachmentScanBacklog, Math.max(0, waiting.length - acted));
    return { examined: waiting.length, acted };
  }

  private async process(attachment: AttachmentMetadata, at: Timestamp): Promise<boolean> {
    if (attachment.quarantineKey === undefined) return false;

    /**
     * Claim it by moving to SCANNING, conditionally.
     *
     * Two workers reaching the same row produce one winner: the loser's UPDATE matches
     * nothing because the state has already moved. Without this, both would scan and
     * both would write a verdict, and the second would arrive after the first had already
     * promoted — a promoted file with a pending scan.
     */
    const claimed = await this.deps.store.transition({
      attachmentId: attachment.attachmentId,
      from: 'QUARANTINED',
      to: 'SCANNING',
      at,
    });
    if (!claimed) return false;

    const scanned = await this.deps.scanner.scan({
      attachmentId: attachment.attachmentId,
      quarantineKey: attachment.quarantineKey,
      declaredMime: attachment.declaredMime,
      declaredBytes: attachment.declaredBytes,
    });

    if (!scanned.ok) {
      /**
       * The scan could not run. Recorded as FAILED and returned to QUARANTINED so the
       * next tick retries — distinct from REJECTED, which means the file was examined
       * and refused (migration 0007). Conflating them would make an object-storage
       * outage look like a wave of policy violations.
       */
      await this.deps.store.recordScan({
        attachmentId: attachment.attachmentId,
        verdict: 'FAILED',
        scanner: 'unavailable',
        detail: { errorCode: scanned.error.code, retryable: scanned.error.retryable },
        at,
      });
      await this.deps.store.transition({
        attachmentId: attachment.attachmentId,
        from: 'SCANNING',
        to: 'QUARANTINED',
        at,
      });
      this.deps.logger.warn('attachment scan could not run', {
        operation: 'sweep.attachment_scan',
        outcome: 'FAILED',
        errorCode: scanned.error.code,
        detail: { attachmentId: attachment.attachmentId },
      });
      return false;
    }

    const verdict = scanned.value;

    if (verdict.verdict === 'INFECTED') {
      await this.deps.store.recordScan({
        attachmentId: attachment.attachmentId,
        verdict: 'INFECTED',
        scanner: verdict.scanner,
        detail: { signature: verdict.signature },
        at,
      });
      await this.settle(attachment, 'INFECTED', at);
      // Logged at error: somebody uploaded malware, which is worth a human seeing even
      // though the pipeline handled it correctly.
      this.deps.logger.error('infected attachment quarantined', {
        operation: 'sweep.attachment_scan',
        outcome: 'FAILED',
        detail: {
          attachmentId: attachment.attachmentId,
          conversationId: attachment.conversationId,
          signature: verdict.signature,
        },
      });
      return true;
    }

    if (verdict.verdict === 'REJECTED') {
      await this.deps.store.recordScan({
        attachmentId: attachment.attachmentId,
        verdict: 'REJECTED',
        scanner: verdict.scanner,
        detail: { reason: verdict.reason },
        at,
      });
      await this.settle(attachment, 'REJECTED', at);
      return true;
    }

    /**
     * The scanner said CLEAN. That answers what the bytes ARE; it does not answer whether
     * the uploader was allowed to send them.
     *
     * `checkReceived` re-runs §28.2's rules against the MEASURED type and size: a client
     * that under-declared its size to pass the intent check does not pass here, and a
     * sniffed type absent from the allow-list is refused even though the scanner found no
     * malware in it.
     */
    const permitted = checkReceived(
      this.deps.policy,
      attachment.uploaderKind === 'CUSTOMER' ? 'CUSTOMER' : 'EMPLOYEE',
      { declaredMime: attachment.declaredMime, declaredBytes: attachment.declaredBytes },
      { sniffedMime: verdict.sniffedMime, actualBytes: verdict.actualBytes },
    );

    if (!permitted.ok) {
      await this.deps.store.recordScan({
        attachmentId: attachment.attachmentId,
        verdict: 'REJECTED',
        scanner: verdict.scanner,
        detail: { reason: permitted.refusal, sniffedMime: verdict.sniffedMime, actualBytes: verdict.actualBytes },
        at,
      });
      await this.settle(attachment, 'REJECTED', at);
      return true;
    }

    // Only now do the bytes leave quarantine.
    const promoted = await this.deps.storage.promote(attachment.quarantineKey);
    if (!promoted.ok) {
      // Storage is unavailable. Back to QUARANTINED and retry — the file is proven safe
      // and proven permitted, so condemning it over a transient write would be wrong.
      await this.deps.store.transition({
        attachmentId: attachment.attachmentId,
        from: 'SCANNING',
        to: 'QUARANTINED',
        at,
      });
      this.deps.logger.warn('attachment promotion failed', {
        operation: 'sweep.attachment_scan',
        outcome: 'FAILED',
        errorCode: promoted.error.code,
        detail: { attachmentId: attachment.attachmentId },
      });
      return false;
    }

    await this.deps.store.recordScan({
      attachmentId: attachment.attachmentId,
      verdict: 'CLEAN',
      scanner: verdict.scanner,
      detail: { sniffedMime: verdict.sniffedMime, actualBytes: verdict.actualBytes },
      at,
    });
    await this.deps.store.transition({
      attachmentId: attachment.attachmentId,
      from: 'SCANNING',
      to: 'CLEAN',
      at,
      sniffedMime: verdict.sniffedMime,
      actualBytes: verdict.actualBytes,
      cleanKey: promoted.value.cleanKey,
      ...(verdict.classification !== undefined ? { classification: verdict.classification } : {}),
    });
    return true;
  }

  /** Applies a terminal verdict, checking the domain agrees the move is legal. */
  private async settle(
    attachment: AttachmentMetadata,
    to: 'INFECTED' | 'REJECTED',
    at: Timestamp,
  ): Promise<void> {
    // The pipeline is asked rather than assumed. If it ever refuses this move the state
    // machine and this worker have diverged, and finding that in a log beats writing a
    // state the domain considers impossible.
    const permitted = advance('SCANNING', to === 'INFECTED' ? { kind: 'SCAN_INFECTED' } : { kind: 'SCAN_REJECTED', reason: '' });
    if (!permitted.ok) {
      this.deps.logger.error('pipeline refused a verdict the scanner produced', {
        operation: 'sweep.attachment_scan',
        outcome: 'FAILED',
        errorCode: permitted.refusal,
        detail: { attachmentId: attachment.attachmentId },
      });
      return;
    }
    await this.deps.store.transition({ attachmentId: attachment.attachmentId, from: 'SCANNING', to, at });
  }
}

/* ───────────────────────────── unbound-upload expiry ──────────────────────────────── */

export interface AttachmentExpirySweepDeps {
  readonly store: AttachmentStorePort;
  readonly storage: ObjectStorageProvider;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * Expires uploads that never reached a message (§28.1, §28.6).
 *
 * §28.6: "Unbound uploads expire on a schedule; they were never reachable." So this is
 * not deletion of anything anyone could see — it is collecting bytes that were granted,
 * possibly uploaded, and then abandoned when someone closed the tab.
 *
 * The metadata row is marked EXPIRED and the object deleted, in that order. §28.6 makes
 * the metadata authoritative — "the metadata record's removal is authoritative; byte
 * deletion follows and is retried until it succeeds" — so a crash between the two leaves
 * an orphaned object rather than a reachable attachment, which is the survivable half.
 */
export class AttachmentExpirySweep {
  constructor(private readonly deps: AttachmentExpirySweepDeps) {}

  async run(): Promise<SweepOutcome> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString() as Timestamp;
    const stale = await this.deps.store.expirable(at, this.deps.batchSize ?? 100);

    let acted = 0;
    for (const attachment of stale) {
      const marked = await this.deps.store.transition({
        attachmentId: attachment.attachmentId,
        from: attachment.state,
        to: 'EXPIRED',
        at,
      });
      // A bind that landed between the query and this update wins: the state has moved
      // to BOUND and the conditional matches nothing. A customer's document is never
      // collected out from under the message it was just attached to.
      if (!marked) continue;

      for (const key of [attachment.quarantineKey, attachment.cleanKey]) {
        if (key === undefined) continue;
        const deleted = await this.deps.storage.delete(key);
        if (!deleted.ok) {
          // Retried on the next tick by design — but the row is already EXPIRED, so the
          // object is unreachable in the meantime. Logged so a persistent failure is
          // visible rather than silently accumulating storage cost.
          this.deps.logger.warn('attachment bytes not deleted', {
            operation: 'sweep.attachment_expiry',
            outcome: 'FAILED',
            errorCode: deleted.error.code,
            detail: { attachmentId: attachment.attachmentId },
          });
        }
      }
      acted += 1;
    }

    if (acted > 0) {
      this.deps.logger.info('unbound attachments expired', {
        operation: 'sweep.attachment_expiry',
        outcome: 'SUCCEEDED',
        detail: { expired: acted },
      });
    }
    return { examined: stale.length, acted };
  }
}
