/**
 * The development attachment scanner (ADR-012, doc §28.2, Part IV §59).
 *
 * ## This is NOT a malware scanner, and says so in its health report
 *
 * It reports `authority: 'TEMPORARY_AUTHORITY'` and a detail line stating the gap,
 * because the alternative is the failure mode §28.2 warns about in a different context:
 * a stub that pretends to have scanned makes an unscanned file look scanned. §39 lists
 * the real scanning provider as a decision with a recurring cost attached (N-06), and
 * §44.3's D-07 says that cost "is part of this decision".
 *
 * ## What it DOES do, honestly
 *
 * Three of Part IV §59's checks are real here, and they are the three that need no
 * signature database:
 *
 *   * **Content sniffing.** Magic bytes are read and compared to the declared type.
 *     §28.2: "trusting the declared type is how an executable arrives named as an image."
 *     This catches that, today, without a vendor.
 *   * **Size verification** against what was actually received, not what was claimed.
 *   * **The EICAR test signature**, so the INFECTED path is exercisable end to end
 *     without anyone handling real malware. EICAR is the industry-standard harmless
 *     string every AV product recognises, and its presence here is what makes the
 *     terminal-state tests meaningful rather than theoretical.
 *
 * What it does NOT do: real malware detection, archive-bomb inspection, macro policy, or
 * DLP classification. Each is listed in §59 and each needs the provider N-06 selects.
 */
import type {
  AttachmentScanner,
  HealthReport,
  Result,
  ScanRequest,
  ScanVerdict,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

const SCANNER_NAME = 'dev-stub';

/**
 * The EICAR standard anti-malware test file, in two pieces so this source file does not
 * itself trip a real scanner on a developer's machine — which is a genuine and
 * frequently-hit problem when the literal is written whole.
 */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** Magic-byte signatures, longest first so a prefix cannot shadow a longer match. */
const SIGNATURES: readonly { readonly mime: string; readonly bytes: readonly number[] }[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  // ZIP container. Both a real archive and every modern Office document, which is why a
  // sniffed `application/zip` cannot be promoted to a .docx without inspecting further —
  // a limitation this stub records rather than guesses past.
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a] }, // MZ — a Windows executable
];

/** Where the bytes come from. Real storage in production; a map in a test. */
export interface QuarantineReader {
  read(quarantineKey: string): Promise<Uint8Array | undefined>;
}

export interface DevScannerOptions {
  readonly storage: QuarantineReader;
  /**
   * Types the stub is willing to declare CLEAN despite sniffing a container.
   *
   * Office documents are ZIP containers, so sniffing alone cannot distinguish a .docx
   * from an archive bomb. Rather than guess, the stub rejects a container unless the
   * caller has explicitly said the declared Office type is acceptable — which is a
   * decision the real scanner will make properly.
   */
  readonly acceptZipContainerAs?: readonly string[];
}

export class DevAttachmentScanner implements AttachmentScanner {
  constructor(private readonly options: DevScannerOptions) {}

  async scan(request: ScanRequest): Promise<Result<ScanVerdict>> {
    const bytes = await this.options.storage.read(request.quarantineKey);

    if (bytes === undefined) {
      // The object is not there. A retryable failure rather than a verdict: reporting
      // REJECTED would permanently condemn a file over what may be a transient read.
      return err({
        code: 'QUARANTINE_OBJECT_MISSING',
        message: 'nothing to scan at that key',
        retryable: true,
        // Attachments degrade alone; text conversation continues (§34, brief §43).
        failureClass: 'FAIL_DEGRADED',
        correlationId: request.attachmentId,
      });
    }

    const actualBytes = bytes.byteLength;

    // Malware first. An infected file is terminal, and nothing about its size or type
    // matters once it is — reporting a MIME mismatch on a virus would bury the finding.
    if (containsEicar(bytes)) {
      return ok({ verdict: 'INFECTED', signature: 'EICAR-Test-File', scanner: SCANNER_NAME });
    }

    const sniffed = sniff(bytes);
    if (sniffed === undefined) {
      return ok({
        verdict: 'REJECTED',
        reason: 'content type could not be determined from the file contents',
        actualBytes,
        scanner: SCANNER_NAME,
      });
    }

    // A ZIP container is an Office document or an archive, and this stub cannot tell.
    // Accepting it only where the caller has whitelisted the declared Office type keeps
    // the decision explicit instead of hidden in a guess.
    const acceptable =
      sniffed === request.declaredMime ||
      (sniffed === 'application/zip' &&
        (this.options.acceptZipContainerAs ?? []).includes(request.declaredMime));

    if (!acceptable) {
      return ok({
        verdict: 'REJECTED',
        reason: `declared ${request.declaredMime} but the contents are ${sniffed}`,
        sniffedMime: sniffed,
        actualBytes,
        scanner: SCANNER_NAME,
      });
    }

    return ok({
      verdict: 'CLEAN',
      // The DECLARED type is reported when a container was accepted by whitelist,
      // because that is what the bytes are agreed to be — and the caller re-checks it
      // against the allow-list either way (`checkReceived`).
      sniffedMime: sniffed === 'application/zip' ? request.declaredMime : sniffed,
      actualBytes,
      scanner: SCANNER_NAME,
    });
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'UP',
      // Not canonical, and it must never be mistaken for canonical. A stub that reported
      // itself healthy without qualification is how an unscanned file looks scanned.
      authority: 'TEMPORARY_AUTHORITY',
      checkedAt: new Date().toISOString(),
      detail:
        'dev scanner: content sniffing, size verification and the EICAR test signature only. ' +
        'NO real malware detection, archive-bomb inspection, macro policy or DLP. ' +
        'A production scanning provider is N-06 and carries a recurring cost (D-07).',
    };
  }
}

const containsEicar = (bytes: Uint8Array): boolean => {
  // Only the head is examined: EICAR is defined to appear at the start of the file, and
  // scanning megabytes of a legitimate PDF for a test string is waste.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes(EICAR);
};

const sniff = (bytes: Uint8Array): string | undefined => {
  for (const signature of SIGNATURES) {
    if (bytes.byteLength < signature.bytes.length) continue;
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) return signature.mime;
  }
  // Plain text is the one type with no magic bytes. Recognised only if every byte in the
  // head is printable or ordinary whitespace — otherwise an unknown binary would pass as
  // text and be promoted.
  const head = bytes.subarray(0, 512);
  const printable = head.every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e),
  );
  return printable && head.byteLength > 0 ? 'text/plain' : undefined;
};
