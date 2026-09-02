/**
 * Upload policy and server-side validation (doc §28.2, §28.5, D-07).
 *
 * ## Every check here is server-side, and that is the whole section
 *
 * §28.2's own wording: a size limit enforced in the browser "is a courtesy". Types are an
 * **allow-list, never a deny-list**. The declared type is compared against the SNIFFED
 * type because "trusting the declared type is how an executable arrives named as an
 * image". The byte count is verified "against what was received, not what was claimed".
 *
 * ## D-07, answered 2026-08-27: customer uploads are permitted for CLAIMS ONLY
 *
 * §44.3 offered (a) not permitted · (b) permitted with limits and scanning · (c)
 * permitted, claims only. (c) was chosen, and it carries a cost §44.3 names explicitly:
 * "If permitted, AV scanning is mandatory and is a recurring cost — that cost is part of
 * this decision." The approvers §44.3 lists are CTO + Claims, so this is built and
 * awaiting their confirmation rather than settled.
 *
 * The narrowness is enforced HERE rather than in a controller, because "customers may
 * upload only to Claims" is a rule about who may put bytes in the system, and a rule of
 * that kind sitting in one handler is a rule that the second handler forgets.
 *
 * ## Employee scanning is a stated, deliberate gap in V1-A
 *
 * §28.2 says so in as many words, and gives the reason — "employees are authenticated and
 * attributable while customers are neither to the same degree" — along with the condition
 * that voids it: "It becomes unacceptable the moment D-07 admits customer uploads."
 *
 * D-07 has now admitted them. So {@link DEFAULT_POLICY} makes scanning mandatory for
 * BOTH, which is a deviation from §28.5's table in the safe direction and is recorded as
 * such. Scanning only the customer half of a shared pipeline would mean an employee
 * forwarding a customer's unscanned file to a colleague, and the pipeline cannot tell the
 * difference once the bytes are in quarantine.
 */
import type { PrincipalKind } from '@starlink/shared-contracts';

export interface UploaderPolicy {
  /** An ALLOW-LIST of MIME types. §28.2: "never a deny-list". */
  readonly allowedMimeTypes: readonly string[];
  readonly maxBytes: number;
  /** §28.5. Mandatory for customers; see the header for why it is on for employees too. */
  readonly scanRequired: boolean;
  /**
   * Categories a principal of this kind may attach to. `undefined` means no restriction.
   *
   * D-07's "claims only" for customers lives here. Matched on the category ROOT, so
   * `claims.new` and `claims.documents` are both covered without a row each.
   */
  readonly allowedCategoryRoots?: readonly string[];
}

export interface AttachmentPolicy {
  readonly employee: UploaderPolicy;
  readonly customer: UploaderPolicy;
}

/**
 * The shipped policy. Every value is configuration in principle (ADR-017) and a
 * placeholder in practice until the attachment policy is administered — but unlike hours
 * or SLA targets, the document DOES give the shape of these.
 */
export const DEFAULT_POLICY: AttachmentPolicy = Object.freeze({
  employee: {
    // §28.5: "Broader — claims documents, images, PDFs".
    allowedMimeTypes: Object.freeze([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/tiff',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ]),
    maxBytes: 25 * 1024 * 1024,
    // See the header: §28.2's exemption for employees is void once customers may upload.
    scanRequired: true,
  },
  customer: {
    // §28.5: "Narrower". Documents and photographs of documents — what a claim needs —
    // and nothing that carries a macro or an embedded executable.
    allowedMimeTypes: Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']),
    // §28.5: "Lower".
    maxBytes: 10 * 1024 * 1024,
    scanRequired: true,
    // D-07, answered "claims only".
    allowedCategoryRoots: Object.freeze(['claims']),
  },
});

export type UploadRefusal =
  | 'UPLOADS_NOT_PERMITTED_FOR_CATEGORY'
  | 'MIME_NOT_ALLOWED'
  | 'TOO_LARGE'
  | 'EMPTY';

export type ValidationRefusal =
  | 'MIME_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'TOO_LARGE';

export interface UploadIntent {
  readonly uploaderKind: PrincipalKind;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  /** The conversation's category, for D-07's restriction. */
  readonly categoryId?: string;
}

export const policyFor = (
  policy: AttachmentPolicy,
  uploaderKind: PrincipalKind,
): UploaderPolicy => (uploaderKind === 'CUSTOMER' ? policy.customer : policy.employee);

/**
 * May this upload be granted at all? Checked BEFORE any storage grant is issued.
 *
 * Refusing here means no bytes are ever accepted — §28.1's "reject → no bytes stored".
 */
export function checkUploadIntent(
  policy: AttachmentPolicy,
  intent: UploadIntent,
): { ok: true } | { ok: false; refusal: UploadRefusal } {
  const rules = policyFor(policy, intent.uploaderKind);

  if (rules.allowedCategoryRoots !== undefined) {
    // An absent category cannot satisfy a restriction. §21.5 lets a customer start
    // without choosing one, and "no category" must not become "any category".
    const root = intent.categoryId?.split('.')[0];
    if (root === undefined || !rules.allowedCategoryRoots.includes(root)) {
      return { ok: false, refusal: 'UPLOADS_NOT_PERMITTED_FOR_CATEGORY' };
    }
  }

  // Allow-list, matched exactly. No prefix matching: `image/*` would admit `image/svg+xml`,
  // which is a document that executes script.
  if (!rules.allowedMimeTypes.includes(intent.declaredMime)) {
    return { ok: false, refusal: 'MIME_NOT_ALLOWED' };
  }

  if (intent.declaredBytes <= 0) return { ok: false, refusal: 'EMPTY' };
  if (intent.declaredBytes > rules.maxBytes) return { ok: false, refusal: 'TOO_LARGE' };

  return { ok: true };
}

/**
 * What the scanner found, checked against what was claimed.
 *
 * Run AFTER the bytes are in quarantine and BEFORE anything is promoted. Both mismatches
 * are rejections rather than corrections: §28.2 treats a declared/sniffed disagreement as
 * a rejection outright, because the interesting case is not a browser guessing wrongly
 * but a caller lying deliberately.
 */
export function checkReceived(
  policy: AttachmentPolicy,
  uploaderKind: PrincipalKind,
  claimed: { declaredMime: string; declaredBytes: number },
  received: { sniffedMime: string; actualBytes: number },
): { ok: true } | { ok: false; refusal: ValidationRefusal } {
  const rules = policyFor(policy, uploaderKind);

  if (received.sniffedMime !== claimed.declaredMime) {
    return { ok: false, refusal: 'MIME_MISMATCH' };
  }
  // The sniffed type must ALSO be on the allow-list. Belt and braces: if the two agree
  // on something the allow-list never permitted, the intent check should have caught it,
  // and a disagreement between the two checks is worth failing rather than trusting.
  if (!rules.allowedMimeTypes.includes(received.sniffedMime)) {
    return { ok: false, refusal: 'MIME_MISMATCH' };
  }
  if (received.actualBytes !== claimed.declaredBytes) {
    return { ok: false, refusal: 'SIZE_MISMATCH' };
  }
  // Re-checked against the ceiling, because the declared size was a claim and this is
  // the measurement. A client that under-declared to pass the first check does not pass
  // this one.
  if (received.actualBytes > rules.maxBytes) return { ok: false, refusal: 'TOO_LARGE' };

  return { ok: true };
}

/**
 * A filename safe to store as metadata and show on download.
 *
 * §28.3: "Sanitised; never used as a storage key and never echoed into a path." The key
 * is server-generated and opaque, so this exists only so the name shown to a human cannot
 * carry a path traversal, a control character or a right-to-left override that makes
 * `evil‮gpj.exe` render as `evilexe.jpg`.
 */
export function sanitiseFilename(raw: string): string {
  const withoutPaths = raw.replace(/[/\\]+/g, '_');
  const printable = withoutPaths
    // Control characters, and the bidirectional overrides that disguise an extension.
    // Matching control characters IS the check: a file named with an embedded NUL is
    // the attack, not an accident.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  // Leading dots hide a file on POSIX and produce an empty display name; a bare `..`
  // is a traversal attempt wearing a name.
  const withoutLeadingDots = printable.replace(/^\.+/, '');
  const bounded = withoutLeadingDots.slice(0, 200);
  return bounded === '' ? 'attachment' : bounded;
}
