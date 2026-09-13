'use client';

/**
 * The picture you just sent, drawn from the copy already in your browser.
 *
 * ## The defect
 *
 * A sent image appeared in the thread as a file card — `PNG photo.png 853 KB` — and stayed
 * one. Measured: still a card six seconds after the send, and only ever a picture after a
 * reload. Two things caused it, and the second is why it persisted rather than flickered:
 *
 *   1. The optimistic row's attachment carried `state: 'BOUND'` and no `contentType`, so
 *      `mediaKindOf` — which decides from the sniffed type — had nothing to decide on and
 *      returned "this is a file".
 *   2. Nothing replaces the optimistic row until the thread is re-read, so the wrong
 *      answer was not a frame, it was the state of the message.
 *
 * ## Why a local URL rather than just the missing field
 *
 * Adding `contentType` alone fixes it, and the picture would then appear once a download
 * grant came back — a round trip, and an audited one, for a file this browser uploaded a
 * moment ago. §28.4's ledger reads "this file was shown to this person", and an entry
 * saying somebody was shown their own photograph immediately after sending it is noise in
 * a record that is meant to mean something.
 *
 * So the bytes are kept where they already are. `URL.createObjectURL` over the `File` the
 * person chose costs nothing, is instant, and is the same picture — this is how every
 * messenger shows you your own media the moment you press send.
 *
 * ## The cap, and why there is one
 *
 * An object URL holds its blob until revoked, so an unbounded map of them is a session
 * that grows by the size of everything sent through it — and one of the files this was
 * built for is a 3.6MB screen recording. The oldest entry past the cap is revoked, which
 * makes the worst case a picture reverting to a fetched grant rather than a leak. Twenty
 * is well past what a session sends and small enough to bound.
 *
 * Nothing here survives a reload, which is correct: after one, the attachment is a real
 * BOUND object with a real sniffed type and the ordinary path is the right one.
 */

/** Insertion-ordered, which is what makes the eviction below oldest-first. */
const held = new Map<string, string>();
const CAP = 20;

/** What may be drawn from a local copy. The same families `mediaKindOf` will draw. */
const DRAWABLE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime))$/;

/**
 * Keeps the bytes of a just-chosen file against the id the server gave it.
 *
 * Silent about anything it will not draw: a PDF has no local rendering here, and holding
 * a blob nothing reads is the leak this file's cap exists to prevent.
 */
export function rememberLocalMedia(attachmentId: string, file: File): void {
  if (!DRAWABLE.test(file.type)) return;
  if (held.has(attachmentId)) return;
  if (typeof URL.createObjectURL !== 'function') return;

  held.set(attachmentId, URL.createObjectURL(file));

  while (held.size > CAP) {
    const oldest = held.keys().next();
    if (oldest.done === true) break;
    const url = held.get(oldest.value);
    if (url !== undefined) URL.revokeObjectURL(url);
    held.delete(oldest.value);
  }
}

/** The local copy, when this session still holds one. */
export function localMediaFor(attachmentId: string): string | undefined {
  return held.get(attachmentId);
}
