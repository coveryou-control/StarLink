/**
 * In-memory object storage.
 *
 * Models the part of the pipeline that carries the security meaning (ADR-012):
 * uploads land in QUARANTINE and are reachable by nobody; only an explicit promote
 * moves an object to a servable key; download grants are short-lived and single-object.
 *
 * The mock enforces the quarantine rule rather than merely storing bytes, because a
 * mock that lets you serve straight from quarantine would let a caller be written that
 * only works against the mock.
 */
import type {
  HealthReport,
  ObjectStorageProvider,
  Result,
  UploadGrant,
  UploadGrantRequest,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

export const QUARANTINE_PREFIX = 'quarantine/';
export const CLEAN_PREFIX = 'clean/';

const fail = (code: string, message: string): Result<never> =>
  err({
    code,
    message,
    retryable: false,
    // Attachment failures degrade the file path only; text conversation continues
    // (brief §43 invariant 9).
    failureClass: 'FAIL_DEGRADED',
    correlationId: 'mock',
  });

export class MockObjectStorage implements ObjectStorageProvider {
  // `protected` rather than `private` so `LocalObjectStorage` can reuse the quarantine
  // model instead of reimplementing it — the promote rule is the part worth having exactly
  // once, and a second copy of it is a second chance to get it wrong.
  protected readonly quarantine = new Set<string>();
  protected readonly clean = new Set<string>();
  /**
   * The bytes, which real object storage holds and this has to model.
   *
   * Present because the scan step needs to READ what was uploaded, and a mock that
   * tracked only key names would make the pipeline untestable end to end — the scanner
   * would find nothing at every key and every attachment would fail as unreadable. Held
   * separately from the key sets so a promote moves the key without copying the bytes.
   */
  protected readonly bytes = new Map<string, Uint8Array>();

  async issueUploadGrant(_request: UploadGrantRequest): Promise<Result<UploadGrant>> {
    // Opaque, server-generated key carrying no meaning: a key containing a
    // conversation id or a filename leaks information and invites enumeration
    // (doc §28.3).
    const quarantineKey = `${QUARANTINE_PREFIX}${crypto.randomUUID()}`;
    this.quarantine.add(quarantineKey);
    return ok({
      url: `memory://upload/${quarantineKey}`,
      quarantineKey,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  }

  /**
   * Accepts bytes for a granted key. DEV AND TEST ONLY.
   *
   * Real object storage receives the upload DIRECTLY from the client against a
   * pre-signed URL (ADR-012), and the application never touches the bytes. Nothing in
   * production calls this; it exists so the dev stack has somewhere for an upload to
   * land, and so the pipeline can be exercised without an S3 endpoint.
   */
  put(quarantineKey: string, bytes: Uint8Array): boolean {
    if (!this.quarantine.has(quarantineKey)) return false;
    this.bytes.set(quarantineKey, bytes);
    return true;
  }

  /** What the scanner reads. Quarantine only — a clean key is served, never re-scanned. */
  readQuarantine(quarantineKey: string): Uint8Array | undefined {
    return this.quarantine.has(quarantineKey) ? this.bytes.get(quarantineKey) : undefined;
  }

  /**
   * What a DOWNLOAD serves. Promoted keys only. DEV AND TEST ONLY.
   *
   * The mirror of `readQuarantine`, and the same reasoning: real storage serves the object
   * itself against a pre-signed GET and the application never touches the bytes. Refusing a
   * quarantine key here is not defence in depth for its own sake — it is the one rule this
   * whole class exists to model, and a reader that ignored it would let a caller be written
   * that serves unscanned files and passes its tests.
   */
  readClean(cleanKey: string): Uint8Array | undefined {
    return this.clean.has(cleanKey) ? this.bytes.get(cleanKey) : undefined;
  }

  async promote(quarantineKey: string): Promise<Result<{ cleanKey: string }>> {
    if (!this.quarantine.has(quarantineKey)) {
      return fail('NOT_QUARANTINED', 'only a quarantined object can be promoted');
    }
    const cleanKey = `${CLEAN_PREFIX}${quarantineKey.slice(QUARANTINE_PREFIX.length)}`;
    this.quarantine.delete(quarantineKey);
    this.clean.add(cleanKey);
    const bytes = this.bytes.get(quarantineKey);
    if (bytes !== undefined) {
      // The object moves; it is not duplicated. A copy left in quarantine would be a
      // second, unscanned-looking artefact of a file that has already passed.
      this.bytes.set(cleanKey, bytes);
      this.bytes.delete(quarantineKey);
    }
    return ok({ cleanKey });
  }

  async issueDownloadGrant(cleanKey: string, ttlSeconds: number): Promise<Result<{ url: string }>> {
    if (cleanKey.startsWith(QUARANTINE_PREFIX)) {
      // An unscanned object must never be servable, whatever the caller asks for.
      return fail('QUARANTINED_OBJECT', 'refusing to serve an unpromoted object');
    }
    return ok({ url: `memory://download/${cleanKey}?ttl=${ttlSeconds}` });
  }

  async delete(key: string): Promise<Result<void>> {
    this.quarantine.delete(key);
    this.clean.delete(key);
    this.bytes.delete(key);
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}
