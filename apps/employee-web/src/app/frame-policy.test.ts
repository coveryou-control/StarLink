import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One file decides who may frame this workspace.
 *
 * ## The defect this guards against
 *
 * There are two headers that answer "may another page put this in an iframe":
 * `X-Frame-Options` and `Content-Security-Policy: frame-ancestors`. They used to live in
 * different files — a flat `DENY` in `next.config.mjs` and the CSP in `middleware.ts` — which
 * was harmless only while the answer was "nobody, ever".
 *
 * The moment a host application can be admitted by `SL_EMBED_ORIGINS`, two files each
 * asserting a frame policy is two files that can disagree. And the disagreement is the worst
 * kind: it does not fail a build, it does not log, and it surfaces as one host application's
 * iframe coming up blank in whichever browser happens to prefer the legacy header.
 *
 * `embed.test.ts` pins the RULE by re-deriving it. This pins that the rule lives where that
 * file says it lives — together, they mean the tested rule is the shipped one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const middleware = readFileSync(join(here, '..', 'middleware.ts'), 'utf8');
const nextConfig = readFileSync(join(here, '..', '..', 'next.config.mjs'), 'utf8');

/** Comments discuss both headers at length; only the code may be read as setting one. */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the frame policy has one home', () => {
  it('is not set anywhere but the middleware', () => {
    expect(
      strip(nextConfig),
      '`next.config.mjs` sets X-Frame-Options again — it belongs beside `frame-ancestors`',
    ).not.toContain('X-Frame-Options');
  });

  it('sets both headers from the same list of hosts', () => {
    const code = strip(middleware);
    expect(code).toContain('SL_EMBED_ORIGINS');
    expect(code).toContain('frame-ancestors');
    expect(code).toContain('X-Frame-Options');
  });

  it('defaults to refusing, in both headers', () => {
    const code = strip(middleware);
    /* The two default branches, verbatim. A change that makes an unset setting mean anything
       other than "nobody may frame this" has to edit this test to say so. */
    expect(code).toContain(`frame-ancestors 'none'`);
    expect(code).toMatch(/hosts\.length === 0[\s\S]{0,120}X-Frame-Options', 'DENY'/);
  });

  it('drops the legacy header only when a host has been named', () => {
    /**
     * `X-Frame-Options` has no allowlist worth using — `ALLOW-FROM` admits one origin and is
     * unimplemented in every current browser — so with hosts named it must be OMITTED and
     * `frame-ancestors` must carry the policy alone. Sending `DENY` alongside an allowlist
     * would refuse the very host the operator just admitted.
     */
    expect(strip(middleware)).toMatch(/else\s+response\.headers\.delete\('X-Frame-Options'\)/);
  });

  it('still refuses to be framed by a page it did not name, in its own CSP', () => {
    /* `frame-src 'none'` is the other direction — what THIS app may embed — and it stays
       shut. Embedding a host application inside the embed is nobody's feature. */
    expect(strip(middleware)).toContain(`frame-src 'none'`);
  });
});
