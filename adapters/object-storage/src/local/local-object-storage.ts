/**
 * The development object-storage driver: real HTTP URLs, in-process bytes.
 *
 * ## The defect this replaces
 *
 * `SL_ADAPTER_OBJECT_STORAGE=local` was aliased to `MockObjectStorage`, whose upload grant
 * returns `memory://upload/quarantine/<uuid>`. The browser client does exactly what
 * ADR-012 says and `fetch`es that URL directly — against a scheme no browser implements.
 * So **an attachment could not be uploaded from any browser, in any runnable
 * configuration**: grants were issued, no bytes ever arrived, and every attachment expired
 * unbound. For a claims pilot, where the document IS the request, that is the product not
 * working rather than a rough edge.
 *
 * The dev sink that existed for this (`POST /v1/dev/attachments/:id/bytes`) took base64
 * JSON and was referenced by one integration test and no frontend, so the pipeline was
 * proven end to end by a test and unreachable by a person.
 *
 * ## What this is, and what it is not
 *
 * It is the SHAPE of ADR-012 with a local endpoint standing in for the storage host: the
 * grant carries a URL, the client PUTs bytes straight to it without a session cookie, the
 * grant is the authorization, and the application still never reads a byte on the request
 * path. Downloads are a short-lived, single-object, opaque token — a pre-signed GET,
 * modelled rather than described.
 *
 * It is NOT the production driver and does not pretend to be. Bytes live in this process's
 * memory and are lost on restart. ADR-012 names MinIO for dev and S3-compatible storage
 * for production (N-03, A-20); both slot in behind `ObjectStorageProvider` without
 * touching anything above.
 *
 * ## Two limits an operator cannot currently see from outside
 *
 * `/readyz` reports database, identity and AI only — object storage is not among them — and
 * this class does not override `health()`, so it would report `authority: 'MOCK'`
 * indistinguishably from the in-memory mock if it were asked. An earlier version of this
 * comment asserted the opposite. Until both are fixed, "which storage driver is installed"
 * is answerable only by reading the configuration.
 *
 * And the URLs it issues are served by `DevUploadController`, which refuses outside
 * `SL_ENV=dev|test`. **This driver therefore cannot carry an upload in a deployed
 * environment**, which is why `validateStartupConfiguration` now refuses to start on it
 * there rather than issuing grants nothing can honour.
 *
 * ## Why the URLs are relative
 *
 * The grant returns a PATH, not an absolute URL, and the client resolves it against the
 * API origin it already holds (`new URL(path, apiOrigin)` — an absolute URL from a real
 * driver is unaffected by the base). That avoids adding a "what is my own public origin"
 * setting, which is a question this process cannot answer correctly behind a proxy anyway,
 * and which would be one more thing to get wrong at deploy time.
 */
import type {
  Result,
  UploadGrant,
  UploadGrantRequest,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

import { CLEAN_PREFIX, MockObjectStorage, QUARANTINE_PREFIX } from '../mock/mock-object-storage.js';

/** Where the dev endpoints live. Kept here so the adapter and the controller agree. */
export const DEV_OBJECT_PATH = '/v1/dev/objects';

const fail = (code: string, message: string): Result<never> =>
  err({
    code,
    message,
    retryable: false,
    failureClass: 'FAIL_DEGRADED',
    correlationId: 'local',
  });

interface DownloadToken {
  readonly cleanKey: string;
  readonly expiresAtMs: number;
}

export class LocalObjectStorage extends MockObjectStorage {
  /**
   * Live download grants.
   *
   * Modelled rather than skipped because "short-lived and single-object" is the property
   * §28.4 and FR-ATT-5 actually rely on. A URL that simply named the key would be a
   * permanent, guessable link to a customer's document, and the pipeline above would look
   * identical while being materially less safe than what it claims to be.
   */
  private readonly downloads = new Map<string, DownloadToken>();

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  override async issueUploadGrant(request: UploadGrantRequest): Promise<Result<UploadGrant>> {
    const grant = await super.issueUploadGrant(request);
    if (!grant.ok) return grant;

    // The opaque half of the key only: `quarantine/` is an internal prefix and putting a
    // slash in a path segment would need escaping for no benefit.
    const objectId = grant.value.quarantineKey.slice(QUARANTINE_PREFIX.length);
    return ok({ ...grant.value, url: `${DEV_OBJECT_PATH}/${objectId}` });
  }

  override async issueDownloadGrant(
    cleanKey: string,
    ttlSeconds: number,
  ): Promise<Result<{ url: string }>> {
    // Delegated first, so the refusal to serve an unpromoted object keeps happening in one
    // place. Overriding it here would be a second implementation of the only rule that
    // matters.
    const base = await super.issueDownloadGrant(cleanKey, ttlSeconds);
    if (!base.ok) return base;

    const token = crypto.randomUUID();
    this.downloads.set(token, {
      cleanKey,
      expiresAtMs: this.now() + Math.max(1, ttlSeconds) * 1000,
    });
    return ok({ url: `${DEV_OBJECT_PATH}/download/${token}` });
  }

  /**
   * Accepts bytes for a granted object. DEV AND TEST ONLY.
   *
   * Returns whether the key was one this adapter granted — which is what stands in for a
   * pre-signed URL's own authority. It cannot write to an arbitrary key.
   */
  acceptUpload(objectId: string, bytes: Uint8Array): boolean {
    return this.put(`${QUARANTINE_PREFIX}${objectId}`, bytes);
  }

  /** Resolves a download token to bytes, or nothing. Expiry is enforced here, not by a sweep. */
  resolveDownload(token: string): Uint8Array | undefined {
    const grant = this.downloads.get(token);
    if (grant === undefined) return undefined;
    if (grant.expiresAtMs <= this.now()) {
      this.downloads.delete(token);
      return undefined;
    }
    // `readClean` refuses anything not promoted, so an object deleted or rolled back
    // between the grant and the fetch yields nothing rather than stale bytes.
    return this.readClean(grant.cleanKey);
  }

  override async delete(key: string): Promise<Result<void>> {
    // A deleted object must not remain reachable through a token issued before it went.
    for (const [token, grant] of this.downloads) {
      if (grant.cleanKey === key) this.downloads.delete(token);
    }
    return super.delete(key);
  }

  /** Exposed for the expiry sweep's own tests; the prefix is otherwise internal. */
  static cleanKeyFor(objectId: string): string {
    return `${CLEAN_PREFIX}${objectId}`;
  }

  /** Used by the dev endpoint to report a genuinely unusable configuration rather than 404. */
  static unavailable(): Result<never> {
    return fail('LOCAL_STORAGE_UNAVAILABLE', 'the local object storage driver is not installed');
  }
}
