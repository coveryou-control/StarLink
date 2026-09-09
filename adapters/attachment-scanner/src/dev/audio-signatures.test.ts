import { describe, expect, it } from 'vitest';

import { DevAttachmentScanner } from './dev-scanner.js';

/**
 * The container a voice note actually arrives in.
 *
 * Voice notes are attachments and go through this scanner like everything else, so a
 * container it cannot recognise is a voice note that never reaches BOUND and therefore
 * never plays. Browsers do not agree on the format — Chrome and Firefox record WebM/Opus,
 * Safari records MP4/AAC — so "it worked on my machine" is a real risk here in a way it is
 * not for a PDF.
 *
 * The MP4 case is the one worth having: `ftyp` sits FOUR bytes in, behind a length field.
 * A sniffer that only reads from position 0 sees nothing at all in an M4A, and the failure
 * is a scan that reports the declared type is a lie about an entirely valid file.
 */
describe('audio containers are recognised', () => {
  const scannerFor = (bytes: Uint8Array): DevAttachmentScanner =>
    new DevAttachmentScanner({ storage: { read: async () => bytes } });

  /** A header, padded so the scanner has something of plausible length to read. */
  const file = (head: readonly number[], at = 0): Uint8Array => {
    const bytes = new Uint8Array(64);
    head.forEach((byte, index) => (bytes[at + index] = byte));
    return bytes;
  };

  const cases = [
    ['audio/webm', file([0x1a, 0x45, 0xdf, 0xa3])],
    ['audio/ogg', file([0x4f, 0x67, 0x67, 0x53])],
    // `ftyp` at offset 4 — the whole reason the signature table carries an offset.
    ['audio/mp4', file([0x66, 0x74, 0x79, 0x70], 4)],
    ['audio/mpeg', file([0x49, 0x44, 0x33])],
  ] as const;

  it.each(cases)('accepts a %s recording whose bytes match', async (mime, bytes) => {
    const result = await scannerFor(bytes).scan({
      quarantineKey: 'quarantine/8a7d2e64-6c1e-4a55-9f0e-1f2f3a4b5c6d',
      declaredMime: mime,
      declaredBytes: bytes.byteLength,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.verdict).toBe('CLEAN');
  });

  it('still refuses a file whose bytes disagree with what was declared', async () => {
    /* The point of sniffing. Declaring audio over a Windows executable must not get it
       past the scanner just because audio is now an allowed type. */
    const result = await scannerFor(file([0x4d, 0x5a])).scan({
      quarantineKey: 'quarantine/8a7d2e64-6c1e-4a55-9f0e-1f2f3a4b5c6d',
      declaredMime: 'audio/webm',
      declaredBytes: 64,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.verdict).toBe('REJECTED');
  });

  it('an offset signature does not match at position zero', () => {
    /* Anti-overreach: `ftyp` written at the START is not an ISO base-media file, and a
       sniffer that ignored the offset would happily call it one. */
    return scannerFor(file([0x66, 0x74, 0x79, 0x70]))
      .scan({
        quarantineKey: 'quarantine/8a7d2e64-6c1e-4a55-9f0e-1f2f3a4b5c6d',
        declaredMime: 'audio/mp4',
        declaredBytes: 64,
      })
      .then((result) => {
        expect(result.ok && result.value.verdict).not.toBe('CLEAN');
      });
  });
});
