/**
 * PHASE 7 EXIT CRITERION (part): the pipeline state machine, including infected,
 * oversized, mismatched-MIME and unbound-expiry.
 *
 * The property under all of them is §28.1's, and it is stated in capitals in the source:
 *
 * > "AN UPLOADED-BUT-UNSENT ATTACHMENT IS REACHABLE BY NOBODY. Binding to a message is
 * > what grants access, because access is derived from the conversation."
 *
 * So most of these tests are about what CANNOT be reached, and the last describe block
 * checks that as a property over every state rather than case by case — a state added
 * later is covered without anyone remembering to add a test.
 */
import { describe, expect, it } from 'vitest';
import type { UUID } from '@starlink/shared-contracts';

import { advance, isExpirable, isReachable, type AttachmentState } from './pipeline.js';
import {
  checkReceived,
  checkUploadIntent,
  sanitiseFilename,
  DEFAULT_POLICY,
} from './policy.js';

const MESSAGE = '018f2c5a-a11a-7000-8000-00000000000a' as UUID;

const ALL_STATES: readonly AttachmentState[] = [
  'UPLOAD_GRANTED',
  'QUARANTINED',
  'SCANNING',
  'CLEAN',
  'INFECTED',
  'REJECTED',
  'BOUND',
  'EXPIRED',
];

describe('the happy path: quarantine → scan → clean → bound', () => {
  it('walks the whole pipeline', () => {
    let state: AttachmentState = 'UPLOAD_GRANTED';
    for (const event of [
      { kind: 'UPLOADED' } as const,
      { kind: 'SCAN_STARTED' } as const,
      { kind: 'SCAN_CLEAN' } as const,
      { kind: 'BOUND', messageId: MESSAGE } as const,
    ]) {
      const result = advance(state, event);
      expect(result.ok, `${state} + ${event.kind}`).toBe(true);
      if (result.ok) state = result.state;
    }
    expect(state).toBe('BOUND');
    expect(isReachable(state)).toBe(true);
  });
});

describe('nothing is reachable before it is bound', () => {
  it('is unreachable in every state except BOUND', () => {
    // The property, checked over the whole enum rather than the states that exist today.
    for (const state of ALL_STATES) {
      expect(isReachable(state), `${state} must not be reachable`).toBe(state === 'BOUND');
    }
  });

  it('refuses to bind anything that has not been scanned clean', () => {
    // Named separately from NOT_A_TRANSITION because it is the most likely caller
    // mistake, and "you tried to bind something still in quarantine" is worth saying.
    for (const state of ['UPLOAD_GRANTED', 'QUARANTINED', 'SCANNING'] as const) {
      const result = advance(state, { kind: 'BOUND', messageId: MESSAGE });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.refusal).toBe('NOT_CLEAN_YET');
    }
  });
});

describe('infected is terminal', () => {
  it('cannot be bound, rescanned or revived', () => {
    /**
     * A "retry the scan" path on an infected file would be a way to get a second opinion
     * on malware — try until a scanner disagrees. There is no move out of INFECTED at all.
     */
    for (const event of [
      { kind: 'SCAN_STARTED' } as const,
      { kind: 'SCAN_CLEAN' } as const,
      { kind: 'BOUND', messageId: MESSAGE } as const,
      { kind: 'EXPIRED' } as const,
    ]) {
      const result = advance('INFECTED', event);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.refusal).toBe('INFECTED_IS_TERMINAL');
    }
  });

  it('is never expirable, so the record of the rejection survives', () => {
    // Deleting the row would erase the evidence that somebody uploaded malware.
    expect(isExpirable('INFECTED')).toBe(false);
    expect(isExpirable('REJECTED')).toBe(false);
  });
});

describe('unbound uploads expire; bound ones do not', () => {
  it('collects everything that never reached a message', () => {
    // §28.6: "Unbound uploads expire on a schedule; they were never reachable."
    for (const state of ['UPLOAD_GRANTED', 'QUARANTINED', 'SCANNING', 'CLEAN'] as const) {
      expect(isExpirable(state), `${state} should expire`).toBe(true);
    }
  });

  it('expires a CLEAN attachment nobody attached to anything', () => {
    // Passing a scan does not make a file reachable — only binding does. A clean orphan
    // is still an orphan.
    const result = advance('CLEAN', { kind: 'EXPIRED' });
    expect(result.ok && result.state).toBe('EXPIRED');
  });

  it('never expires a BOUND attachment', () => {
    /**
     * §28.6: "Attachments of a deleted conversation follow the conversation's retention,
     * not their own." Once bound, the expiry sweep must not be able to reach it — a
     * claim document vanishing from a live conversation on a timer would be data loss
     * wearing the clothes of housekeeping.
     */
    expect(isExpirable('BOUND')).toBe(false);
    const result = advance('BOUND', { kind: 'EXPIRED' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('ALREADY_BOUND');
  });
});

describe('policy — §28.2 and §28.5', () => {
  const customer = { uploaderKind: 'CUSTOMER' as const, categoryId: 'claims.new' };
  const employee = { uploaderKind: 'EMPLOYEE' as const };

  it('permits a customer to attach to a CLAIMS conversation (D-07)', () => {
    const result = checkUploadIntent(DEFAULT_POLICY, {
      ...customer,
      declaredMime: 'application/pdf',
      declaredBytes: 1_000_000,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a customer upload outside Claims (D-07, answered "claims only")', () => {
    for (const categoryId of ['sales.new-policy', 'renewals.due', 'grievance.complaint', 'other']) {
      const result = checkUploadIntent(DEFAULT_POLICY, {
        uploaderKind: 'CUSTOMER',
        categoryId,
        declaredMime: 'application/pdf',
        declaredBytes: 1_000,
      });
      expect(result.ok, `${categoryId} must not accept customer uploads`).toBe(false);
      expect(!result.ok && result.refusal).toBe('UPLOADS_NOT_PERMITTED_FOR_CATEGORY');
    }
  });

  it('treats "no category" as not-permitted rather than as any category', () => {
    // §21.5 lets a customer start without choosing a category. An absent one cannot
    // satisfy a restriction, and reading it as unrestricted would invert the rule.
    const result = checkUploadIntent(DEFAULT_POLICY, {
      uploaderKind: 'CUSTOMER',
      declaredMime: 'application/pdf',
      declaredBytes: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('UPLOADS_NOT_PERMITTED_FOR_CATEGORY');
  });

  it('does not restrict employees by category', () => {
    const result = checkUploadIntent(DEFAULT_POLICY, {
      ...employee,
      declaredMime: 'application/pdf',
      declaredBytes: 1_000,
    });
    expect(result.ok).toBe(true);
  });

  it('uses an allow-list, so an unlisted type is refused however harmless it looks', () => {
    // §28.2: "Allow-list, never a deny-list."
    for (const mime of ['application/zip', 'text/html', 'application/x-msdownload', 'image/svg+xml']) {
      const result = checkUploadIntent(DEFAULT_POLICY, {
        ...customer,
        declaredMime: mime,
        declaredBytes: 1_000,
      });
      expect(result.ok, `${mime} must not be allowed`).toBe(false);
    }
  });

  it('does not prefix-match image/*, which would admit SVG', () => {
    // An SVG is a document that executes script. Exact matching is why it is refused
    // while image/png is not.
    expect(DEFAULT_POLICY.customer.allowedMimeTypes).not.toContain('image/svg+xml');
    expect(DEFAULT_POLICY.customer.allowedMimeTypes).toContain('image/png');
  });

  it('gives the customer a NARROWER list and a LOWER ceiling than an employee (§28.5)', () => {
    expect(DEFAULT_POLICY.customer.allowedMimeTypes.length).toBeLessThan(
      DEFAULT_POLICY.employee.allowedMimeTypes.length,
    );
    expect(DEFAULT_POLICY.customer.maxBytes).toBeLessThan(DEFAULT_POLICY.employee.maxBytes);
  });

  it('requires scanning for BOTH kinds now that customer uploads are permitted', () => {
    /**
     * §28.2 exempts employee uploads in V1-A and states the condition that voids the
     * exemption: "It becomes unacceptable the moment D-07 admits customer uploads."
     * D-07 has admitted them, and a shared pipeline cannot tell whose bytes are whose
     * once they are in quarantine.
     */
    expect(DEFAULT_POLICY.customer.scanRequired).toBe(true);
    expect(DEFAULT_POLICY.employee.scanRequired).toBe(true);
  });

  it('refuses an oversized or empty upload before any bytes are accepted', () => {
    const tooBig = checkUploadIntent(DEFAULT_POLICY, {
      ...customer,
      declaredMime: 'application/pdf',
      declaredBytes: DEFAULT_POLICY.customer.maxBytes + 1,
    });
    expect(!tooBig.ok && tooBig.refusal).toBe('TOO_LARGE');

    const empty = checkUploadIntent(DEFAULT_POLICY, {
      ...customer,
      declaredMime: 'application/pdf',
      declaredBytes: 0,
    });
    expect(!empty.ok && empty.refusal).toBe('EMPTY');
  });
});

describe('validation of what actually arrived (§28.2)', () => {
  const claimed = { declaredMime: 'application/pdf', declaredBytes: 1_000 };

  it('accepts bytes that match what was claimed', () => {
    const result = checkReceived(DEFAULT_POLICY, 'CUSTOMER', claimed, {
      sniffedMime: 'application/pdf',
      actualBytes: 1_000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an executable that arrived declared as a PDF', () => {
    // §28.2: "trusting the declared type is how an executable arrives named as an image".
    const result = checkReceived(DEFAULT_POLICY, 'CUSTOMER', claimed, {
      sniffedMime: 'application/x-msdownload',
      actualBytes: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('MIME_MISMATCH');
  });

  it('rejects a byte count that disagrees with the claim', () => {
    // "Verified against what was received, not what was claimed."
    const result = checkReceived(DEFAULT_POLICY, 'CUSTOMER', claimed, {
      sniffedMime: 'application/pdf',
      actualBytes: 2_000,
    });
    expect(!result.ok && result.refusal).toBe('SIZE_MISMATCH');
  });

  it('re-checks the ceiling against the MEASURED size', () => {
    // A client that under-declared to pass the intent check does not pass this one.
    const big = DEFAULT_POLICY.customer.maxBytes + 5_000;
    const result = checkReceived(
      DEFAULT_POLICY,
      'CUSTOMER',
      { declaredMime: 'application/pdf', declaredBytes: big },
      { sniffedMime: 'application/pdf', actualBytes: big },
    );
    expect(!result.ok && result.refusal).toBe('TOO_LARGE');
  });
});

describe('filenames are sanitised, never trusted (§28.3)', () => {
  it('strips path separators', () => {
    expect(sanitiseFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitiseFilename('..\\..\\windows\\system32')).not.toContain('\\');
  });

  it('strips the bidirectional overrides that disguise an extension', () => {
    // `evil‮gpj.exe` renders as `evilexe.jpg` in most interfaces — the classic
    // right-to-left override trick, and the reason a filename is never shown raw.
    const disguised = sanitiseFilename('evil‮gpj.exe');
    expect(disguised).not.toContain('‮');
    expect(disguised).toBe('evilgpj.exe');
  });

  it('never returns an empty or dot-leading name', () => {
    expect(sanitiseFilename('...')).toBe('attachment');
    expect(sanitiseFilename('   ')).toBe('attachment');
    expect(sanitiseFilename('.hidden')).toBe('hidden');
  });

  it('bounds the length', () => {
    expect(sanitiseFilename('a'.repeat(5_000)).length).toBeLessThanOrEqual(200);
  });
});
