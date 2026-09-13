import { describe, expect, it } from 'vitest';

import { looksLikeImage } from './avatar-store.js';

/**
 * The server's half of avatar safety.
 *
 * The strong protection is on the client: `avatar-picker.tsx` decodes the chosen file into
 * a canvas and reads it back out as PNG, so what leaves the machine is pixels and nothing
 * that was not pixels survives — an SVG's script, a polyglot's trailing payload, the GPS
 * coordinates in a phone photograph's EXIF.
 *
 * But that protection lives in a browser, and a caller who skips the browser skips it. So
 * the server asks the narrow question this function answers: do these bytes begin the way
 * the declared type begins? A file that does not is refused rather than stored and served
 * back later under a content type the browser will act on.
 *
 * It is not a scan and must not be described as one. What it stops is relabelling.
 */

/** The eight-byte PNG signature, followed by enough padding to clear the length floor. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);

const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('looksLikeImage', () => {
  it('accepts each type it claims to accept', () => {
    expect(looksLikeImage(PNG, 'image/png')).toBe(true);
    expect(looksLikeImage(JPEG, 'image/jpeg')).toBe(true);
    expect(looksLikeImage(WEBP, 'image/webp')).toBe(true);
  });

  it('refuses a file relabelled as another image type', () => {
    /*
       The case this exists for. A caller sends real PNG bytes and calls them a JPEG, or
       the reverse — harmless on its own, and the same mechanism is how something that is
       not an image at all gets stored under a type the browser will render.
    */
    expect(looksLikeImage(PNG, 'image/jpeg')).toBe(false);
    expect(looksLikeImage(JPEG, 'image/png')).toBe(false);
    expect(looksLikeImage(WEBP, 'image/png')).toBe(false);
  });

  it('refuses an SVG however it is labelled', () => {
    /*
       An SVG can carry script, which is why it is not in the accepted list at all. This
       asserts that calling it something else does not get it in — the type is refused
       AND the bytes do not match the types that are allowed.
    */
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    expect(looksLikeImage(svg, 'image/svg+xml')).toBe(false);
    expect(looksLikeImage(svg, 'image/png')).toBe(false);
    expect(looksLikeImage(svg, 'image/jpeg')).toBe(false);
    expect(looksLikeImage(svg, 'image/webp')).toBe(false);
  });

  it('refuses an unknown content type outright', () => {
    /* Rule 4's shape, applied to a content type: unknown is denied, never waved through. */
    expect(looksLikeImage(PNG, 'application/octet-stream')).toBe(false);
    expect(looksLikeImage(PNG, 'text/html')).toBe(false);
    expect(looksLikeImage(PNG, '')).toBe(false);
  });

  it('refuses anything too short to have a signature', () => {
    /*
       Not pedantry. Node's base64 decoder silently drops invalid characters rather than
       throwing, so a garbage string arrives here as a short buffer — and a length check
       that read past the end would throw inside a request handler instead of refusing.
    */
    expect(looksLikeImage(Buffer.alloc(0), 'image/png')).toBe(false);
    expect(looksLikeImage(Buffer.from([0x89, 0x50]), 'image/png')).toBe(false);
    expect(looksLikeImage(Buffer.alloc(11), 'image/webp')).toBe(false);
  });

  it('accepts a JPEG whose end marker is missing', () => {
    /*
       Deliberate. A truncated JPEG is a broken picture, not a security problem — the
       browser renders what it can — and requiring the trailing EOI would reject files that
       are merely damaged while stopping nothing.
    */
    expect(looksLikeImage(JPEG, 'image/jpeg')).toBe(true);
  });
});
