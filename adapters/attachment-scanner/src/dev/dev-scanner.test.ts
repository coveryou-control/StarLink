/**
 * The development scanner.
 *
 * Two kinds of test here, and the second matters more:
 *
 *   * That the three real checks work — content sniffing, size, and the EICAR signature.
 *   * That the stub is HONEST about what it does not do. A scanner that reported itself
 *     as canonical would make an unscanned file look scanned, which is the failure §28.2
 *     spends a paragraph on.
 */
import { describe, expect, it } from 'vitest';
import type { UUID } from '@starlink/shared-contracts';

import { DevAttachmentScanner, type QuarantineReader } from './dev-scanner.js';

const ATTACHMENT = '018f2c5a-5caa-7000-8000-00000000000a' as UUID;

const storageOf = (bytes: Uint8Array | undefined): QuarantineReader => ({
  read: async () => bytes,
});

const bytesOf = (...parts: (number[] | string)[]): Uint8Array => {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) flat.push(ch.charCodeAt(0));
    else flat.push(...part);
  }
  return Uint8Array.from(flat);
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXE_MAGIC = [0x4d, 0x5a];

const scan = async (bytes: Uint8Array | undefined, declaredMime: string, declaredBytes = 0) =>
  new DevAttachmentScanner({ storage: storageOf(bytes) }).scan({
    attachmentId: ATTACHMENT,
    quarantineKey: 'quarantine/x',
    declaredMime,
    declaredBytes,
  });

describe('content sniffing (§28.2)', () => {
  it('passes a PDF that really is a PDF', async () => {
    const result = await scan(bytesOf(PDF_MAGIC, '-1.7 rest of file'), 'application/pdf');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.verdict).toBe('CLEAN');
    expect(result.ok && result.value.verdict === 'CLEAN' && result.value.sniffedMime).toBe(
      'application/pdf',
    );
  });

  it('catches an executable declared as a PDF', async () => {
    /**
     * §28.2's stated reason for sniffing at all: "trusting the declared type is how an
     * executable arrives named as an image."
     */
    const result = await scan(bytesOf(EXE_MAGIC, 'this program cannot be run in DOS mode'), 'application/pdf');
    expect(result.ok && result.value.verdict).toBe('REJECTED');
    expect(result.ok && result.value.verdict === 'REJECTED' && result.value.sniffedMime).toBe(
      'application/x-msdownload',
    );
  });

  it('catches a PNG declared as a PDF', async () => {
    // Not malicious, and still refused: §28.2 makes a mismatch a rejection outright,
    // because the interesting case is a caller lying rather than a browser guessing.
    const result = await scan(bytesOf(PNG_MAGIC, 'IHDR'), 'application/pdf');
    expect(result.ok && result.value.verdict).toBe('REJECTED');
  });

  it('refuses a file whose type cannot be determined', async () => {
    // An unknown binary must not pass as text and be promoted.
    const result = await scan(Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'application/pdf');
    expect(result.ok && result.value.verdict).toBe('REJECTED');
  });

  it('reports the measured size, not the declared one', async () => {
    const bytes = bytesOf(PDF_MAGIC, 'x'.repeat(100));
    const result = await scan(bytes, 'application/pdf', 999_999);
    expect(result.ok && result.value.verdict === 'CLEAN' && result.value.actualBytes).toBe(
      bytes.byteLength,
    );
  });
});

describe('malware', () => {
  it('detects the EICAR test signature', async () => {
    /**
     * EICAR is the industry-standard harmless string every AV product recognises. Having
     * it here is what makes the INFECTED terminal-state tests exercisable end to end
     * without anyone handling real malware.
     */
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const result = await scan(bytesOf(eicar), 'text/plain');
    expect(result.ok && result.value.verdict).toBe('INFECTED');
    expect(result.ok && result.value.verdict === 'INFECTED' && result.value.signature).toBe(
      'EICAR-Test-File',
    );
  });

  it('reports INFECTED ahead of any type mismatch', async () => {
    // A virus declared as a PDF is a virus. Reporting the MIME mismatch instead would
    // bury the finding under a policy violation.
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const result = await scan(bytesOf(eicar), 'application/pdf');
    expect(result.ok && result.value.verdict).toBe('INFECTED');
  });
});

describe('a missing object is retryable, never a verdict', () => {
  it('fails rather than condemning the file', async () => {
    // Reporting REJECTED would permanently condemn an attachment over what may be a
    // transient read against object storage.
    const result = await scan(undefined, 'application/pdf');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.retryable).toBe(true);
    // And it degrades the file path only — text conversation is unaffected (§34).
    expect(!result.ok && result.error.failureClass).toBe('FAIL_DEGRADED');
  });
});

describe('ZIP containers are not guessed past', () => {
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const zipBytes = bytesOf([0x50, 0x4b, 0x03, 0x04], 'word/document.xml');

  it('refuses a container by default, because it cannot tell a .docx from an archive', async () => {
    const result = await scan(zipBytes, docx);
    expect(result.ok && result.value.verdict).toBe('REJECTED');
  });

  it('accepts one only where the caller has explicitly whitelisted the declared type', async () => {
    // An explicit decision rather than a hidden guess. The real scanner will inspect the
    // container properly; this records that the stub cannot.
    const scanner = new DevAttachmentScanner({
      storage: storageOf(zipBytes),
      acceptZipContainerAs: [docx],
    });
    const result = await scanner.scan({
      attachmentId: ATTACHMENT,
      quarantineKey: 'quarantine/x',
      declaredMime: docx,
      declaredBytes: zipBytes.byteLength,
    });
    expect(result.ok && result.value.verdict).toBe('CLEAN');
  });
});

describe('the stub is honest about being a stub', () => {
  it('never reports itself as canonical', async () => {
    const health = await new DevAttachmentScanner({ storage: storageOf(undefined) }).health();
    expect(health.authority).toBe('TEMPORARY_AUTHORITY');
  });

  it('states the gap in its own health detail', async () => {
    /**
     * Asserted rather than trusted, because this sentence is the only thing standing
     * between "we scan attachments" and the truth. §39 and N-06 make the real provider a
     * decision with a recurring cost; until it is made, anyone reading health must see
     * what is missing.
     */
    const health = await new DevAttachmentScanner({ storage: storageOf(undefined) }).health();
    const detail = (health.detail ?? '').toLowerCase();
    expect(detail).toContain('no real malware detection');
    for (const gap of ['archive-bomb', 'macro policy', 'dlp']) {
      expect(detail).toContain(gap);
    }
  });
});
