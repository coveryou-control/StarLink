/**
 * The S3 driver's rules, tested against a stubbed client.
 *
 * ## What is and is not proven here
 *
 * No network, and therefore no proof that a presigned URL is accepted by a real S3 — that
 * needs a bucket and belongs to the staging smoke test. What IS proven is everything the
 * driver decides for itself: the prefixes, the refusals, that promote MOVES rather than
 * copies, and that a delete failure does not undo a successful promote.
 *
 * Those are the parts a mistake would make dangerous rather than merely broken — an
 * unscanned object becoming downloadable, or a promote reporting failure after the clean
 * copy already exists.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { S3ObjectStorage } from './s3-object-storage.js';
import { CLEAN_PREFIX, QUARANTINE_PREFIX } from '../mock/mock-object-storage.js';

/** Records every command it is sent, and can be told to fail a chosen one. */
function stubClient(failOn?: (command: unknown) => boolean): {
  client: S3Client;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      if (failOn?.(command) === true) throw new Error('s3 said no');
      return {};
    }),
  } as unknown as S3Client;
  return { client, sent };
}

/**
 * A REAL client with dummy credentials, for the two presigning cases.
 *
 * Signing is pure local computation — no request is made — so this needs no network and
 * no bucket, and it exercises the actual SigV4 path rather than a stub's idea of it. The
 * command-dispatch cases keep the stub, because those are about which commands are sent.
 */
const signingClient = (): S3Client =>
  new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret-key' },
  });

const storage = (client: S3Client): S3ObjectStorage =>
  new S3ObjectStorage({ bucket: 'starlink-test', region: 'ap-south-1', client });

describe('S3ObjectStorage', () => {
  it('grants uploads into quarantine under an opaque key', async () => {
    /**
     * §28.3: a key carrying a conversation id or a filename both leaks information and
     * invites enumeration. It must be quarantine-prefixed and otherwise meaningless.
     */
    const result = await storage(signingClient()).issueUploadGrant({
      conversationId: '018f2c5a-0000-7000-8000-00000000000a',
      declaredMime: 'application/pdf',
      declaredBytes: 1024,
      purpose: 'test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quarantineKey.startsWith(QUARANTINE_PREFIX)).toBe(true);
    const opaque = result.value.quarantineKey.slice(QUARANTINE_PREFIX.length);
    expect(opaque, 'the key leaks the conversation id').not.toContain('018f2c5a');
    expect(opaque, 'the key leaks a filename').not.toContain('.pdf');
    expect(result.value.url, 'the grant is not a signed URL').toContain('X-Amz-Signature');
  });

  it('refuses to promote anything that is not quarantined', async () => {
    /**
     * The prefix is how the system knows a scan applied to this object. Promoting an
     * arbitrary key would make a file reachable that nothing ever scanned — the one
     * outcome §28 exists to prevent.
     */
    const { client, sent } = stubClient();
    const result = await storage(client).promote('clean/already-promoted');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_QUARANTINED');
    expect(sent, 'it talked to S3 before refusing').toHaveLength(0);
  });

  it('promotes as a MOVE — copy then delete, not a copy', async () => {
    /**
     * A file left in quarantine after passing its scan is a second artefact of a clean
     * file that still looks unscanned. The delete is what makes this a move.
     */
    const { client, sent } = stubClient();
    const key = `${QUARANTINE_PREFIX}abc`;
    const result = await storage(client).promote(key);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cleanKey).toBe(`${CLEAN_PREFIX}abc`);
    expect(sent[0]).toBeInstanceOf(CopyObjectCommand);
    expect(sent[1], 'the quarantined original survived the promote').toBeInstanceOf(
      DeleteObjectCommand,
    );
  });

  it('still succeeds when the quarantine delete fails after a successful copy', async () => {
    /**
     * The clean copy exists, so the attachment is reachable and correct. Reporting failure
     * would make the caller retry a copy that already succeeded; the real cost of a stale
     * quarantine object is storage, not correctness, and the expiry sweep collects it.
     */
    const { client } = stubClient((c) => c instanceof DeleteObjectCommand);
    const result = await storage(client).promote(`${QUARANTINE_PREFIX}abc`);

    expect(result.ok, 'a failed cleanup undid a successful promote').toBe(true);
  });

  it('fails the promote when the COPY fails', async () => {
    // The control for the case above: only the delete is forgiving.
    const { client } = stubClient((c) => c instanceof CopyObjectCommand);
    const result = await storage(client).promote(`${QUARANTINE_PREFIX}abc`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROMOTE_FAILED');
    expect(result.error.retryable, 'a transient S3 failure must be retryable').toBe(true);
  });

  it('refuses to issue a download grant for an unpromoted object', async () => {
    // An unscanned object must never become downloadable, whatever the caller passes.
    const { client } = stubClient();
    const result = await storage(client).issueDownloadGrant(`${QUARANTINE_PREFIX}abc`, 60);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_CLEAN');
  });

  it('issues a download grant for a promoted object', async () => {
    // The positive control: without it, every refusal above is satisfied by a driver that
    // refuses everything.
    const result = await storage(signingClient()).issueDownloadGrant(`${CLEAN_PREFIX}abc`, 60);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toContain('X-Amz-Signature');
  });

  it('degrades rather than fails hard, on every error path', async () => {
    /**
     * §34.4 and brief §43 invariant 9: a storage failure costs the FILE, never the
     * conversation. `FAIL_CLOSED` here would let an attachment outage take messaging down.
     */
    const { client } = stubClient(() => true);
    const promoted = await storage(client).promote(`${QUARANTINE_PREFIX}abc`);
    const deleted = await storage(client).delete('clean/x');

    for (const result of [promoted, deleted]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.failureClass).toBe('FAIL_DEGRADED');
    }
  });

  it('reports health with HeadBucket, and reports DOWN rather than throwing', async () => {
    const up = stubClient();
    expect((await storage(up.client).health()).status).toBe('UP');
    expect(up.sent[0], 'health should not need object-level permission').toBeInstanceOf(
      HeadBucketCommand,
    );

    const down = stubClient(() => true);
    const report = await storage(down.client).health();
    expect(report.status, 'a health probe must not throw into /readyz').toBe('DOWN');
  });
});
