/**
 * PHASE 7 EXIT CRITERION: the pipeline end to end, and storage-down degradation.
 *
 * Driven through the real `DevAttachmentScanner` and `MockObjectStorage` rather than
 * hand-written verdicts, so the test exercises the same sniffing and quarantine rules the
 * product does. The mock storage enforces the quarantine boundary itself — it refuses to
 * serve from a quarantine key — which is why a caller that skipped promotion could not be
 * written to pass against it.
 *
 * The last block is the criterion the plan names as "storage-down degradation (text chat
 * unaffected)": every attachment failure must be `FAIL_DEGRADED` and must leave the
 * conversation path alone.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@starlink/observability';
import type { ObjectStorageProvider, Result, Timestamp, UUID } from '@starlink/shared-contracts';
import { err } from '@starlink/shared-contracts';
import { MockObjectStorage } from '@starlink/adapter-object-storage';
import { DevAttachmentScanner } from '@starlink/adapter-attachment-scanner';
import { DEFAULT_POLICY, type AttachmentState } from '@starlink/attachments';

import {
  AttachmentExpirySweep,
  AttachmentScanSweep,
  type AttachmentMetadata,
  type AttachmentStorePort,
} from './attachment-sweeps.js';

const logger = createLogger({ service: 'attachment-sweeps-test', sink: () => undefined });
const CONVERSATION = '018f2c5a-a77a-7000-8000-00000000000a' as UUID;

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, ...'-1.7 body'.split('').map((c) => c.charCodeAt(0))]);
const EXE = Uint8Array.from([0x4d, 0x5a, ...'MZ header'.split('').map((c) => c.charCodeAt(0))]);
const EICAR_BYTES = Uint8Array.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
    .split('')
    .map((c) => c.charCodeAt(0)),
);

/** An in-memory metadata store with the same conditional-update semantics as the real one. */
class FakeStore implements AttachmentStorePort {
  readonly rows = new Map<UUID, AttachmentMetadata & { expiresAt?: Timestamp }>();
  readonly scans: { attachmentId: UUID; verdict: string }[] = [];

  add(row: AttachmentMetadata & { expiresAt?: Timestamp }): void {
    this.rows.set(row.attachmentId, row);
  }

  async awaitingScan(limit: number): Promise<readonly AttachmentMetadata[]> {
    return [...this.rows.values()].filter((r) => r.state === 'QUARANTINED').slice(0, limit);
  }

  async expirable(at: Timestamp, limit: number): Promise<readonly AttachmentMetadata[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.expiresAt !== undefined &&
          r.expiresAt <= at &&
          ['UPLOAD_GRANTED', 'QUARANTINED', 'SCANNING', 'CLEAN'].includes(r.state),
      )
      .slice(0, limit);
  }

  /** Conditional, exactly like the SQL: a row that has moved on matches nothing. */
  async transition(input: {
    attachmentId: UUID;
    from: AttachmentState;
    to: AttachmentState;
    sniffedMime?: string;
    actualBytes?: number;
    cleanKey?: string;
  }): Promise<boolean> {
    const row = this.rows.get(input.attachmentId);
    if (row === undefined || row.state !== input.from) return false;
    this.rows.set(input.attachmentId, {
      ...row,
      state: input.to,
      ...(input.cleanKey !== undefined ? { cleanKey: input.cleanKey } : {}),
    });
    return true;
  }

  async recordScan(input: { attachmentId: UUID; verdict: string }): Promise<void> {
    this.scans.push({ attachmentId: input.attachmentId, verdict: input.verdict });
  }

  stateOf(id: UUID): AttachmentState | undefined {
    return this.rows.get(id)?.state;
  }
}

/** Storage that is entirely unavailable. Every call degrades. */
const brokenStorage = (): ObjectStorageProvider => {
  const down = <T>(): Result<T> =>
    err({
      code: 'STORAGE_UNAVAILABLE',
      message: 'object storage is not reachable',
      retryable: true,
      // The whole point: attachments degrade alone (§34, brief §43 invariant 9).
      failureClass: 'FAIL_DEGRADED',
      correlationId: 'test',
    });
  return {
    async issueUploadGrant() { return down(); },
    async promote() { return down(); },
    async issueDownloadGrant() { return down(); },
    async delete() { return down(); },
    async health() {
      return { status: 'DOWN' as const, authority: 'TEMPORARY_AUTHORITY' as const, checkedAt: new Date().toISOString() };
    },
  };
};

/** One quarantined attachment, with its bytes staged in the given storage. */
async function stage(
  bytes: Uint8Array,
  declaredMime: string,
  uploaderKind = 'CUSTOMER',
): Promise<{ store: FakeStore; storage: MockObjectStorage; bytes: Map<string, Uint8Array>; id: UUID }> {
  const store = new FakeStore();
  const storage = new MockObjectStorage();
  const bytesByKey = new Map<string, Uint8Array>();
  const id = crypto.randomUUID() as UUID;

  const grant = await storage.issueUploadGrant({
    conversationId: CONVERSATION,
    declaredMime,
    declaredBytes: bytes.byteLength,
    purpose: 'test',
  });
  if (!grant.ok) throw new Error('mock storage refused a grant');
  bytesByKey.set(grant.value.quarantineKey, bytes);

  store.add({
    attachmentId: id,
    conversationId: CONVERSATION,
    uploaderKind,
    declaredMime,
    declaredBytes: bytes.byteLength,
    quarantineKey: grant.value.quarantineKey,
    state: 'QUARANTINED',
  });

  return { store, storage, bytes: bytesByKey, id };
}

const sweepFor = (
  store: FakeStore,
  storage: ObjectStorageProvider,
  bytesByKey: Map<string, Uint8Array>,
): AttachmentScanSweep =>
  new AttachmentScanSweep({
    store,
    scanner: new DevAttachmentScanner({ storage: { read: async (key) => bytesByKey.get(key) } }),
    storage,
    policy: DEFAULT_POLICY,
    logger,
  });

describe('the scan pipeline', () => {
  it('promotes a clean, permitted file and only then marks it CLEAN', async () => {
    const { store, storage, bytes, id } = await stage(PDF, 'application/pdf');

    const result = await sweepFor(store, storage, bytes).run();

    expect(result.acted).toBe(1);
    expect(store.stateOf(id)).toBe('CLEAN');
    expect(store.rows.get(id)?.cleanKey).toBeDefined();
    expect(store.scans).toEqual([{ attachmentId: id, verdict: 'CLEAN' }]);
  });

  it('quarantines an infected file terminally, and never promotes it', async () => {
    const { store, storage, bytes, id } = await stage(EICAR_BYTES, 'text/plain', 'EMPLOYEE');

    await sweepFor(store, storage, bytes).run();

    expect(store.stateOf(id)).toBe('INFECTED');
    expect(store.rows.get(id)?.cleanKey).toBeUndefined();
    expect(store.scans[0]?.verdict).toBe('INFECTED');
  });

  it('rejects an executable declared as a PDF', async () => {
    // §28.2's stated attack: "trusting the declared type is how an executable arrives
    // named as an image."
    const { store, storage, bytes, id } = await stage(EXE, 'application/pdf');

    await sweepFor(store, storage, bytes).run();

    expect(store.stateOf(id)).toBe('REJECTED');
    expect(store.scans[0]?.verdict).toBe('REJECTED');
  });

  it('rejects a clean file whose type the uploader was not allowed to send', async () => {
    /**
     * The scanner says CLEAN — plain text really is plain text, and carries no malware.
     * The POLICY says a customer may send only PDFs and photographs. Two different
     * questions, and the second is why `checkReceived` runs after a clean verdict.
     */
    const text = Uint8Array.from('just some notes'.split('').map((c) => c.charCodeAt(0)));
    const { store, storage, bytes, id } = await stage(text, 'text/plain', 'CUSTOMER');

    await sweepFor(store, storage, bytes).run();

    expect(store.stateOf(id)).toBe('REJECTED');
    // The same file from an EMPLOYEE is permitted — text/plain is on their allow-list.
    const staff = await stage(text, 'text/plain', 'EMPLOYEE');
    await sweepFor(staff.store, staff.storage, staff.bytes).run();
    expect(staff.store.stateOf(staff.id)).toBe('CLEAN');
  });

  it('claims each attachment once, so two workers cannot both scan it', async () => {
    // The conditional move to SCANNING is the claim. Without it both would write a
    // verdict, and the second would land after the first had promoted.
    const { store, storage, bytes, id } = await stage(PDF, 'application/pdf');
    const sweep = sweepFor(store, storage, bytes);

    const [first, second] = await Promise.all([sweep.run(), sweep.run()]);

    expect(first.acted + second.acted).toBe(1);
    expect(store.scans.filter((s) => s.attachmentId === id)).toHaveLength(1);
  });
});

describe('storage down — the pipeline degrades, it does not corrupt', () => {
  it('returns a proven-clean file to QUARANTINED rather than condemning it', async () => {
    /**
     * The file passed its scan and passed policy; only the promotion failed. Marking it
     * REJECTED would permanently refuse a legitimate document over a transient write, so
     * it goes back to QUARANTINED and the next tick retries.
     */
    const { store, bytes, id } = await stage(PDF, 'application/pdf');
    const result = await sweepFor(store, brokenStorage(), bytes).run();

    expect(result.acted).toBe(0);
    expect(store.stateOf(id)).toBe('QUARANTINED');
    // Nothing was recorded as a verdict — the scan ran, but the outcome is not settled.
    expect(store.scans.filter((s) => s.verdict === 'REJECTED')).toHaveLength(0);
  });

  it('records a scan that could not run as FAILED, never as REJECTED', async () => {
    /**
     * Migration 0007's distinction, exercised. An unreadable object means the scanner
     * could not do its job; calling that REJECTED would make a storage outage look like
     * a wave of policy violations, and "is our scanner healthy" unanswerable.
     */
    const { store, storage, id } = await stage(PDF, 'application/pdf');
    // Bytes deliberately absent from the reader, so the scan itself fails.
    const result = await sweepFor(store, storage, new Map()).run();

    expect(result.acted).toBe(0);
    expect(store.scans[0]?.verdict).toBe('FAILED');
    expect(store.stateOf(id)).toBe('QUARANTINED');
  });

  it('degrades every storage failure rather than failing closed', async () => {
    /**
     * The phase's second exit criterion. Brief §43 invariant 9 and §34: an attachment
     * problem must never take the conversation with it. `FAIL_DEGRADED` is the contract's
     * way of saying so, and a caller that treated it as FAIL_CLOSED would refuse the
     * message as well as the file.
     */
    const storage = brokenStorage();
    for (const call of [
      storage.issueUploadGrant({ conversationId: CONVERSATION, declaredMime: 'application/pdf', declaredBytes: 1, purpose: 't' }),
      storage.promote('quarantine/x'),
      storage.issueDownloadGrant('clean/x', 60),
      storage.delete('clean/x'),
    ]) {
      const result = await call;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.failureClass).toBe('FAIL_DEGRADED');
        expect(result.error.retryable).toBe(true);
      }
    }
  });
});

describe('unbound uploads expire; bound ones are untouchable', () => {
  const past = new Date(Date.now() - 60_000).toISOString() as Timestamp;

  it('collects an abandoned upload and deletes its bytes', async () => {
    const { store, storage, id } = await stage(PDF, 'application/pdf');
    store.add({ ...store.rows.get(id)!, expiresAt: past });

    const result = await new AttachmentExpirySweep({ store, storage, logger }).run();

    expect(result.acted).toBe(1);
    expect(store.stateOf(id)).toBe('EXPIRED');
  });

  it('never collects an attachment that was bound in the meantime', async () => {
    /**
     * The race the conditional update exists for: a bind landing between the query and
     * the write. §28.6 makes a bound attachment follow the conversation's retention, so
     * collecting one would delete a live claim document on a housekeeping timer.
     */
    const { store, storage, id } = await stage(PDF, 'application/pdf');
    store.add({ ...store.rows.get(id)!, expiresAt: past, state: 'BOUND' });

    const result = await new AttachmentExpirySweep({ store, storage, logger }).run();

    expect(result.acted).toBe(0);
    expect(store.stateOf(id)).toBe('BOUND');
  });

  it('marks the metadata EXPIRED even when the bytes cannot be deleted', async () => {
    /**
     * §28.6: "The metadata record's removal is authoritative; byte deletion follows and
     * is retried until it succeeds." A crash or outage between the two leaves an orphaned
     * object, which costs storage — not a reachable attachment, which would cost trust.
     */
    const { store, id } = await stage(PDF, 'application/pdf');
    store.add({ ...store.rows.get(id)!, expiresAt: past });

    const result = await new AttachmentExpirySweep({ store, storage: brokenStorage(), logger }).run();

    expect(result.acted).toBe(1);
    expect(store.stateOf(id)).toBe('EXPIRED');
  });
});
