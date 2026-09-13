'use client';

/**
 * How many files, and how large — asked of the server, applied in the composer.
 *
 * ## Why this is not a constant
 *
 * The numbers are the API's. A browser holding its own copy is a browser that will one day
 * offer a limit the policy no longer has, and somebody will act on the offer: they will
 * spend four minutes on a 24MB export because the composer said 25MB, and meet a refusal at
 * the end. So the figures come from `GET /attachments/limits` and this module holds none of
 * its own.
 *
 * ## Why the client checks at all, when the server already refuses
 *
 * Not for safety — §28.2 is explicit that a browser-side size limit "is a courtesy", and
 * the grant is refused server-side before a single byte moves either way. It is for the
 * SENTENCE. A refusal that arrives from the server can only talk about one file, arrives
 * after the person has picked eleven, and cannot say "these two are fine and that one is
 * not" while the file dialog is still fresh in mind. Sorting the batch here is what makes
 * the message specific enough to act on.
 *
 * ## What happens to a file that is too large
 *
 * It is named, with its limit, and the person is told to put it on Drive and paste the
 * link. That is the actual answer — there is no "compress it" the product can offer and no
 * raising of the ceiling available to them — and saying it beside the refusal is the
 * difference between a dead end and a next step.
 */
import { api } from './api-client';

export interface AttachmentLimits {
  readonly maxPerMessage: number;
  readonly maxBytes: number;
  /** Ceilings that replace `maxBytes` for one MIME family (the part before the slash). */
  readonly maxBytesByFamily: Readonly<Record<string, number>>;
}

/**
 * What to do with one batch of chosen files.
 *
 * `accepted` is what should be uploaded, in the order it was picked. `refusals` is what was
 * not, each with the sentence to show for it — plural because picking ten files can fail in
 * two different ways at once, and a single "some files were not attached" would leave the
 * person to work out which and why.
 */
export interface Triage {
  readonly accepted: readonly File[];
  readonly refusals: readonly string[];
}

/**
 * The ceiling for one file, by MIME family.
 *
 * Mirrors `ceilingFor` in `@starlink/attachments`, which is the authority — this reads the
 * same shape out of what that authority sent. It is not a second copy of the numbers: there
 * are no numbers here.
 */
export function ceilingFor(limits: AttachmentLimits, type: string): number {
  const family = type.split('/')[0] ?? '';
  return limits.maxBytesByFamily[family] ?? limits.maxBytes;
}

/**
 * Megabytes, the way a limit is spoken rather than the way it is stored.
 *
 * Whole numbers: every ceiling in the policy is a round number of MB, and "10.0 MB" reads
 * like a measurement of the file rather than a statement of the rule. If a ceiling ever is
 * fractional this rounds down, which errs toward under-promising.
 */
const asMegabytes = (bytes: number): string => `${Math.floor(bytes / (1024 * 1024))} MB`;

/**
 * Sorts a batch into what will be sent and what will not.
 *
 * `alreadyStaged` is how many files the composer is already holding, because the count
 * limit is per MESSAGE and not per gesture — attaching six and then six more is the same
 * eleven-file message as attaching twelve at once, and only counting the batch would let
 * the second route through.
 */
export function triage(
  files: readonly File[],
  alreadyStaged: number,
  limits: AttachmentLimits,
): Triage {
  const accepted: File[] = [];
  const refusals: string[] = [];
  /* Counted as files are accepted rather than by slicing up front, so that a file refused
     for its SIZE does not consume one of the slots. Somebody who picks eleven files, one of
     them oversized, gets ten attached — not nine and two complaints. */
  let room = Math.max(0, limits.maxPerMessage - alreadyStaged);
  const overCount: string[] = [];

  for (const file of files) {
    const ceiling = ceilingFor(limits, file.type);
    if (file.size > ceiling) {
      refusals.push(
        `“${file.name}” is larger than the ${asMegabytes(ceiling)} limit. ` +
          `Put it on Drive and share the link instead.`,
      );
      continue;
    }
    if (room === 0) {
      overCount.push(file.name);
      continue;
    }
    accepted.push(file);
    room -= 1;
  }

  if (overCount.length > 0) {
    /* One sentence for the whole overflow, not one per file. Eleven separate lines saying
       the same thing is not eleven times as informative, and the useful facts are the
       limit and which files did not make it. */
    refusals.push(
      `A message can carry ${limits.maxPerMessage} files. ` +
        `${overCount.length === 1 ? '“' + overCount[0] + '” was' : overCount.length + ' were'} ` +
        `not attached — send them in another message.`,
    );
  }

  return { accepted, refusals };
}

/**
 * The limits, fetched once per page and remembered.
 *
 * Held in a module-level promise rather than in component state because every composer on
 * the page wants the same answer and it does not change between them. A failed fetch is not
 * cached: the next attach tries again, because the alternative is a session that has
 * permanently lost its ability to describe its own limits over one dropped request.
 */
let inFlight: Promise<AttachmentLimits> | undefined;

export function attachmentLimits(): Promise<AttachmentLimits> {
  inFlight ??= api.attachmentLimits().catch((cause: unknown) => {
    inFlight = undefined;
    throw cause;
  });
  return inFlight;
}

/** Test seam: forget what was fetched, so a case can supply its own. */
export function forgetAttachmentLimits(): void {
  inFlight = undefined;
}
