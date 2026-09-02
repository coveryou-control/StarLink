/**
 * A place for an upload to land in development. DEV AND TEST ONLY.
 *
 * ## Why this exists at all
 *
 * ADR-012 has the client upload DIRECTLY to object storage against a pre-signed PUT, so
 * the application never sees the bytes — that is the point of the design, and it is what
 * keeps a large upload from occupying an API connection. Against MinIO or S3 the URL in
 * an upload grant is a real endpoint and nothing here is involved.
 *
 * `MockObjectStorage` is an in-process map with no HTTP server, so in the dev stack there
 * is no such endpoint and an upload has nowhere to go. Without this the whole pipeline is
 * unreachable locally: grants are issued, nothing is ever uploaded, and every attachment
 * expires unbound.
 *
 * ## It refuses to exist outside development
 *
 * Guarded on `SL_ENV`, and failing closed on an unset value — "the operator forgot" and
 * "this is a laptop" are indistinguishable from in here, and only one of them is safe.
 * The same posture the seeder takes for the same reason.
 *
 * An endpoint that accepts bytes into quarantine on behalf of another principal would be
 * a genuine hole in production, so this is not merely untidy there — it is the kind of
 * thing that must be impossible rather than merely discouraged.
 */
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { LocalObjectStorage, MockObjectStorage } from '@starlink/adapter-object-storage';
import type { ObjectStorageProvider, UUID } from '@starlink/shared-contracts';
import type { PgAttachmentStore } from '@starlink/database';
import { ATTACHMENT_STORE, CONFIG, OBJECT_STORAGE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Public, refuse, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();
const bodySchema = z.object({ base64: z.string().min(1).max(40_000_000) });

@Controller('v1/dev')
export class DevUploadController {
  constructor(
    @Inject(ATTACHMENT_STORE) private readonly store: PgAttachmentStore,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageProvider,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Accepts bytes for a granted attachment.
   *
   * `@Public()` because the real equivalent is a pre-signed URL carrying its own
   * authority — the grant IS the authorization, and it was issued only after the upload
   * policy passed. What stands in for that here is the quarantine key: bytes are accepted
   * only against a key the mock already granted, so this cannot write to arbitrary
   * storage.
   *
   * Base64 rather than a raw body, deliberately: a raw-body parser is global
   * configuration, and adding one for a dev-only route would change how every other
   * endpoint reads its input.
   */
  @Post('attachments/:attachmentId/bytes')
  @Public()
  async put(
    @Param('attachmentId') attachmentIdRaw: string,
    @Body() body: unknown,
    @Req() _request: AuthenticatedRequest,
  ): Promise<unknown> {
    // Fail closed on anything that is not explicitly a development environment.
    if (this.config.SL_ENV !== 'dev' && this.config.SL_ENV !== 'test') return refuse();
    if (!(this.storage instanceof MockObjectStorage)) return refuse();

    const attachmentId = uuid.safeParse(attachmentIdRaw);
    const parsed = bodySchema.safeParse(body);
    if (!attachmentId.success || !parsed.success) return refuse();

    const record = await this.store.byId(attachmentId.data as UUID);
    // Only into a key that was actually granted, and only while it is still awaiting
    // its upload. A second write after the scan has started would change the bytes
    // underneath a verdict.
    if (record?.quarantineKey === undefined || record.state !== 'UPLOAD_GRANTED') return refuse();

    const bytes = Buffer.from(parsed.data.base64, 'base64');
    if (!this.storage.put(record.quarantineKey, new Uint8Array(bytes))) return refuse();

    return { bytes: bytes.byteLength };
  }

  /**
   * The object endpoints a BROWSER can actually use. DEV AND TEST ONLY.
   *
   * ## Why these exist beside the base64 route above
   *
   * That route is addressed by attachment id and takes a JSON envelope, which is fine for
   * a test written in Node and useless to the upload path ADR-012 actually specifies: the
   * client is handed a URL in the grant and PUTs the file straight to it. Until now the
   * URL for the dev driver was `memory://…`, so no browser could complete an upload at
   * all — the pipeline was reachable only from a test.
   *
   * These are addressed by the OPAQUE OBJECT ID from the grant, which is what stands in
   * for a pre-signed URL's own authority: bytes are accepted only against a key the
   * adapter itself issued, and a download is only reachable through a short-lived token
   * minted when the §28.4 ladder passed. Neither can name an arbitrary object.
   *
   * Both are `@Public()` for the same reason the route above is: a pre-signed URL carries
   * its authority in the URL, and sending a session cookie to a storage host would be
   * handing credentials to something with no business holding them. Both fail closed
   * outside `dev`/`test`, and both refuse unless the LOCAL driver is the one installed —
   * so promoting an environment to a real S3 driver removes these from service without a
   * code change.
   */
  @Post('objects/:objectId')
  @Public()
  async putObject(
    @Param('objectId') objectIdRaw: string,
    @Req() request: AuthenticatedRequest & { body?: unknown },
  ): Promise<unknown> {
    const local = this.localDriver();
    if (local === undefined) return refuse();

    const objectId = uuid.safeParse(objectIdRaw);
    if (!objectId.success) return refuse();

    /**
     * The bytes may only be written ONCE, while the object is still awaiting them.
     *
     * The base64 route above has carried this check since it was written, with the reason
     * stated: *"A second write after the scan has started would change the bytes underneath
     * a verdict."* This route — the one a browser actually uses — shipped without it, and
     * the omission is a scan bypass, not an untidiness:
     *
     *   1. The uploader POSTs a benign PDF and announces it.
     *   2. `MockObjectStorage.put` accepts any key still in the quarantine set, and only
     *      `promote` removes it — so QUARANTINED and SCANNING both still accept writes.
     *   3. The scan sweep reads the bytes, records a CLEAN verdict, and then promotes.
     *      Anything POSTed between the read and the promote is what gets copied to the
     *      clean key.
     *
     * The result is an object in CLEAN whose recorded verdict, sniffed MIME and byte count
     * describe different content — servable to everyone the message reaches. No cookie is
     * needed (the route is `@Public()`, as a pre-signed URL is) and nothing has to be
     * guessed: the object id is in the uploader's own grant.
     *
     * Keyed by quarantine key rather than attachment id, because that is what this route
     * receives; the lookup is by the same column the grant wrote.
     */
    const record = await this.store.byQuarantineKey(`quarantine/${objectId.data}`);
    if (record === undefined || record.state !== 'UPLOAD_GRANTED') return refuse();

    /**
     * The raw body, placed here by a parser scoped to this path in `main.ts`.
     *
     * Scoped rather than global on purpose: a raw-body parser applied to the whole app
     * would change how every other endpoint reads its input, which is the reason the
     * base64 route above exists at all.
     */
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) return refuse();

    if (!local.acceptUpload(objectId.data, new Uint8Array(body))) return refuse();
    return { bytes: body.byteLength };
  }

  @Get('objects/download/:token')
  @Public()
  async getObject(
    @Param('token') tokenRaw: string,
    @Res() response: {
      status: (code: number) => { end: () => void };
      setHeader: (key: string, value: string) => void;
      end: (body?: Buffer) => void;
    },
  ): Promise<void> {
    const local = this.localDriver();
    const token = uuid.safeParse(tokenRaw);
    const bytes = local !== undefined && token.success ? local.resolveDownload(token.data) : undefined;

    if (bytes === undefined) {
      // An expired, spent or unknown token is the same answer as a nonexistent object
      // (§27.3). Not `refuse()`, because this hand-rolls the response rather than
      // returning a value for Nest to serialise.
      response.status(404).end();
      return;
    }

    /**
     * Served as an opaque download, never as a renderable document.
     *
     * `application/octet-stream` plus `Content-Disposition: attachment` and `nosniff` —
     * the same posture §27.11 takes for the API. A dev endpoint that rendered a
     * customer-supplied HTML file inline on the API's own origin would be a stored XSS in
     * the one place a session cookie lives.
     */
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('content-disposition', 'attachment');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    response.end(Buffer.from(bytes));
  }

  /** The installed driver, if it is the local one and this environment allows it. */
  private localDriver(): LocalObjectStorage | undefined {
    if (this.config.SL_ENV !== 'dev' && this.config.SL_ENV !== 'test') return undefined;
    return this.storage instanceof LocalObjectStorage ? this.storage : undefined;
  }
}
