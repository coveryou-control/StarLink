/**
 * The S3-compatible object-storage driver (N-03/A-20).
 *
 * ## Why this had to exist before anything could be deployed
 *
 * `loadConfig` refuses to start on `staging` or `production` unless
 * `SL_ADAPTER_OBJECT_STORAGE=remote`, because the `local` driver's upload URLs are served
 * by `DevUploadController`, which itself refuses outside `dev`/`test` — so a deployed
 * process would have issued grants that every upload then failed against, silently. And
 * `remote` previously threw `requires an S3 driver (Phase 12)` at construction. The result
 * was a product with **no setting under which a deployed environment could boot at all**.
 *
 * Stage 1 needs it as much as Stage 2 does: employee-to-employee conversations carry
 * internal attachments, so storage is on the critical path for the internal pilot, not
 * only for the customer one.
 *
 * ## S3-compatible, not AWS-specific
 *
 * Everything below is plain S3 API. `SL_STORAGE_ENDPOINT` lets it point at MinIO for
 * staging and at AWS for production without a code change, and `forcePathStyle` is set
 * when an endpoint is given because MinIO addresses buckets by path where AWS uses the
 * host. One driver, two deployments — which is what stops staging proving something
 * production does not do.
 *
 * ## The quarantine model is preserved exactly
 *
 * `quarantine/` and `clean/` are the same prefixes the mock and local drivers use, and
 * `promote` is still a MOVE rather than a copy: a file left in quarantine after passing
 * its scan is a second artefact of a clean file that still looks unscanned, and §28's
 * whole point is that reachability follows the scan. S3 has no move, so this is
 * copy-then-delete, and the delete is what makes it a move.
 *
 * ## Credentials
 *
 * Never read here. The SDK resolves them from the environment or the instance role, which
 * is what lets a deployment use an IAM role and never hold a long-lived secret at all.
 * Passing them through application config would make that impossible.
 */
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  HealthReport,
  ObjectStorageProvider,
  Result,
  UploadGrant,
  UploadGrantRequest,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

import { CLEAN_PREFIX, QUARANTINE_PREFIX } from '../mock/mock-object-storage.js';

export interface S3ObjectStorageOptions {
  readonly bucket: string;
  readonly region: string;
  /** Set for MinIO or any non-AWS S3 service. Absent means AWS. */
  readonly endpoint?: string;
  /** How long an upload grant stays usable. §28.3 keeps this short. */
  readonly uploadTtlSeconds?: number;
  /** Injected in tests; the real client is constructed here otherwise. */
  readonly client?: S3Client;
}

/**
 * A storage failure degrades the FILE path and never the conversation (§34.4, brief §43
 * invariant 9). Same shape the mock returns, so callers cannot tell the drivers apart by
 * their failures — which is what makes the local suites meaningful evidence about this one.
 */
const fail = (code: string, message: string, retryable: boolean): Result<never> =>
  err({
    code,
    message,
    retryable,
    failureClass: 'FAIL_DEGRADED',
    correlationId: 's3',
  });

export class S3ObjectStorage implements ObjectStorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly uploadTtl: number;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.uploadTtl = options.uploadTtlSeconds ?? 15 * 60;
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint !== undefined
          ? {
              endpoint: options.endpoint,
              // MinIO addresses buckets by path; AWS by host. Set only when an endpoint
              // is given, so AWS keeps its own default.
              forcePathStyle: true,
            }
          : {}),
      });
  }

  /**
   * A presigned PUT straight into quarantine.
   *
   * The key is an opaque UUID carrying no conversation id and no filename: §28.3 is
   * explicit that a key with meaning in it both leaks information and invites enumeration.
   * The client uploads directly to storage — bytes never pass through the API, which is
   * what keeps a 20MB attachment off the request path a customer's message shares.
   */
  async issueUploadGrant(_request: UploadGrantRequest): Promise<Result<UploadGrant>> {
    const quarantineKey = `${QUARANTINE_PREFIX}${crypto.randomUUID()}`;
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: quarantineKey }),
        { expiresIn: this.uploadTtl },
      );
      return ok({
        url,
        quarantineKey,
        expiresAt: new Date(Date.now() + this.uploadTtl * 1000).toISOString(),
      });
    } catch (cause) {
      return fail('UPLOAD_GRANT_FAILED', describe(cause), true);
    }
  }

  /**
   * Quarantine to clean, as a MOVE.
   *
   * Refuses a key that is not quarantine-prefixed rather than promoting it: the prefix is
   * how the system knows a scan applied to this object, and promoting an arbitrary key
   * would make a file reachable that nothing ever scanned.
   */
  async promote(quarantineKey: string): Promise<Result<{ cleanKey: string }>> {
    if (!quarantineKey.startsWith(QUARANTINE_PREFIX)) {
      return fail('NOT_QUARANTINED', 'only a quarantined object can be promoted', false);
    }
    const cleanKey = `${CLEAN_PREFIX}${quarantineKey.slice(QUARANTINE_PREFIX.length)}`;

    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: cleanKey,
          CopySource: `${this.bucket}/${quarantineKey}`,
        }),
      );
    } catch (cause) {
      return fail('PROMOTE_FAILED', describe(cause), true);
    }

    /**
     * The delete is what makes it a move — but a failure here must NOT fail the promote.
     *
     * The clean copy already exists, so the attachment is reachable and correct. Reporting
     * failure now would make the caller retry a copy that has already succeeded, and the
     * real consequence of a stale quarantine object is a bytes bill, not a correctness
     * problem. The expiry sweep collects it.
     */
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: quarantineKey }))
      .catch(() => undefined);

    return ok({ cleanKey });
  }

  /**
   * A short-lived presigned GET.
   *
   * Authorization happened before this was called — the URL itself is a bearer capability,
   * which is why the TTL is the caller's and deliberately small (§28.5).
   */
  async issueDownloadGrant(cleanKey: string, ttlSeconds: number): Promise<Result<{ url: string }>> {
    if (!cleanKey.startsWith(CLEAN_PREFIX)) {
      // An unscanned object must never become downloadable, whatever the caller passes.
      return fail('NOT_CLEAN', 'only a promoted object can be downloaded', false);
    }
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: cleanKey }),
        { expiresIn: ttlSeconds },
      );
      return ok({ url });
    } catch (cause) {
      return fail('DOWNLOAD_GRANT_FAILED', describe(cause), true);
    }
  }

  async delete(key: string): Promise<Result<void>> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return ok(undefined);
    } catch (cause) {
      return fail('DELETE_FAILED', describe(cause), true);
    }
  }

  /**
   * Reported by `/readyz` as a SOFT dependency.
   *
   * CANONICAL, not TEMPORARY_AUTHORITY: unlike the identity adapters, this IS the system
   * of record for the bytes — there is no upstream S3 that will later replace it.
   *
   * `HeadBucket` rather than a list: it needs no object-level permission and returns
   * nothing, so a health probe cannot become a way to enumerate the bucket.
   */
  async health(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { status: 'UP', authority: 'CANONICAL', checkedAt };
    } catch {
      return { status: 'DOWN', authority: 'CANONICAL', checkedAt };
    }
  }

  /** Test-only escape hatch for draining a stream body; not part of the port. */
  static async collect(body: unknown): Promise<Buffer> {
    if (!(body instanceof Readable)) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
