/**
 * What may be pointed at an `<img>` or a `<video>`.
 *
 * The two sources in practice are a browser-minted `blob:` and a download grant from
 * StarLink's own API, so nothing here is closing an open hole. It makes the property
 * true by construction instead of by tracing where the URL came from — which is what a
 * reader needs, and what CodeQL was asking for at both sinks.
 *
 * The interesting cases are the refusals, and the reason they are parsed rather than
 * pattern-matched: a prefix test is defeated by whitespace, control characters and case,
 * all of which browsers tolerate.
 */
import { describe, expect, it } from 'vitest';

import { safeMediaSrc } from './media-src';

describe('safeMediaSrc', () => {
  it('passes the two schemes the product actually uses', () => {
    for (const url of [
      'blob:http://localhost:3010/8f1c-…',
      'https://bucket.s3.ap-south-1.amazonaws.com/clean/abc?X-Amz-Signature=x',
      'http://localhost:3011/v1/dev/objects/download/tok',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      expect(safeMediaSrc(url), url).toBe(url);
    }
  });

  it('refuses a script URL', () => {
    expect(safeMediaSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeMediaSrc('vbscript:msgbox(1)')).toBeUndefined();
  });

  it('refuses the forms that defeat a prefix test', () => {
    /**
     * Every one of these is `javascript:` as a browser reads it, and every one passes a
     * naive `startsWith('javascript:') === false` check. This is the reason the
     * implementation parses instead of comparing strings.
     */
    for (const url of [
      ' javascript:alert(1)',
      '\njavascript:alert(1)',
      '\tjavascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\u0000script:alert(1)',
    ]) {
      expect(safeMediaSrc(url), JSON.stringify(url)).toBeUndefined();
    }
  });

  it('refuses what it cannot parse, rather than passing it through', () => {
    // "I could not tell what this is" must not become "render it anyway" on the one path
    // that puts a remote resource on the page.
    expect(safeMediaSrc('http://[not a url')).toBeUndefined();
  });

  it('treats absent and empty as nothing to show', () => {
    // The caller renders a placeholder for `undefined`; an empty `src` would make the
    // browser re-request the current page as an image.
    expect(safeMediaSrc(undefined)).toBeUndefined();
    expect(safeMediaSrc('')).toBeUndefined();
  });
});
