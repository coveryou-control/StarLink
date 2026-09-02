import { describe, expect, it } from 'vitest';
import { objectStorageConformance } from '@starlink/shared-contracts';
import { MockObjectStorage } from './mock-object-storage.js';

objectStorageConformance({ describe, it, expect: expect as never }, async () => new MockObjectStorage());

describe('quarantine boundary', () => {
  it('refuses to issue a download grant for an unpromoted object', async () => {
    // The whole pipeline exists so that an unscanned file is reachable by nobody
    // (ADR-012). A mock that allowed this would let a caller be written that only
    // works against the mock.
    const storage = new MockObjectStorage();
    const grant = await storage.issueUploadGrant({
      conversationId: crypto.randomUUID(),
      declaredMime: 'application/pdf',
      declaredBytes: 2048,
      purpose: 'claim-document',
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;

    const download = await storage.issueDownloadGrant(grant.value.quarantineKey, 60);
    expect(download.ok).toBe(false);
    if (!download.ok) expect(download.error.code).toBe('QUARANTINED_OBJECT');
  });

  it('will not promote an object it never quarantined', async () => {
    const storage = new MockObjectStorage();
    const result = await storage.promote('quarantine/never-uploaded');
    expect(result.ok).toBe(false);
  });

  it('serves an object only after promotion', async () => {
    const storage = new MockObjectStorage();
    const grant = await storage.issueUploadGrant({
      conversationId: crypto.randomUUID(),
      declaredMime: 'image/png',
      declaredBytes: 128,
      purpose: 'evidence',
    });
    if (!grant.ok) throw new Error('grant failed');
    const promoted = await storage.promote(grant.value.quarantineKey);
    if (!promoted.ok) throw new Error('promote failed');
    const download = await storage.issueDownloadGrant(promoted.value.cleanKey, 60);
    expect(download.ok).toBe(true);
  });

  it('generates opaque keys that leak nothing about the conversation', async () => {
    // Doc §28.3: a key containing a conversation id, a customer name or the original
    // filename discloses information and invites enumeration.
    const storage = new MockObjectStorage();
    const conversationId = crypto.randomUUID();
    const grant = await storage.issueUploadGrant({
      conversationId,
      declaredMime: 'application/pdf',
      declaredBytes: 1,
      purpose: 'claim-document',
    });
    if (!grant.ok) throw new Error('grant failed');
    expect(grant.value.quarantineKey.includes(conversationId)).toBe(false);
    expect(grant.value.quarantineKey.includes('claim-document')).toBe(false);
  });

  it('degrades attachments without threatening the conversation', async () => {
    const storage = new MockObjectStorage();
    const result = await storage.promote('quarantine/missing');
    expect(result.ok).toBe(false);
    // Attachment failure must never escalate into a conversation failure.
    if (!result.ok) expect(result.error.failureClass).toBe('FAIL_DEGRADED');
  });
});
