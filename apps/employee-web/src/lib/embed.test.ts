import { describe, expect, it } from 'vitest';

import { EMBED_ATTRIBUTE, EMBED_KEY, EMBED_PARAM, embedBootScript } from './embed';

/**
 * Embedding is refused unless an operator has named a host.
 *
 * ## Why this is a test and not a review note
 *
 * `frame-ancestors` is the whole clickjacking defence for a signed-in employee workspace,
 * and it is the class of setting that gets loosened once, for one environment, by somebody
 * debugging an iframe that will not load. The loosening is invisible: nothing renders
 * differently, no request fails, and the product works exactly as well with the door open.
 *
 * So the DEFAULT is pinned here. A change that makes an unset `SL_EMBED_ORIGINS` mean
 * anything other than "nobody may frame this" fails the build with the reason attached.
 *
 * The middleware's own function is re-derived rather than imported: `middleware.ts` pulls in
 * `next/server`, which needs a request context this suite has no business constructing. What
 * is asserted is the RULE — and `app/frame-policy.test.ts` reads the middleware's source to
 * prove the rule is the one that file actually implements.
 */
const EMBED_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i;

const parse = (raw: string | undefined): readonly string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => EMBED_ORIGIN.test(origin));

const frameAncestors = (raw: string | undefined): string => {
  const hosts = parse(raw);
  return hosts.length === 0 ? `frame-ancestors 'none'` : `frame-ancestors 'self' ${hosts.join(' ')}`;
};

describe('who may frame the workspace', () => {
  it('refuses everybody when no host is named', () => {
    for (const unset of [undefined, '', '   ', ',', ' , ']) {
      expect(frameAncestors(unset), `SL_EMBED_ORIGINS=${JSON.stringify(unset)}`).toBe(
        `frame-ancestors 'none'`,
      );
    }
  });

  it('admits the hosts an operator named, and nothing else', () => {
    expect(frameAncestors('https://host-one.coveryou.com')).toBe(
      `frame-ancestors 'self' https://host-one.coveryou.com`,
    );
    expect(
      frameAncestors('https://host-one.coveryou.com, https://host-two.coveryou.com'),
    ).toBe(`frame-ancestors 'self' https://host-one.coveryou.com https://host-two.coveryou.com`);
  });

  it('drops anything that is not a bare origin', () => {
    /**
     * A malformed entry in a CSP source list can WIDEN the policy rather than narrowing it —
     * a stray `*` is the obvious one, and a path or a trailing slash is the one somebody
     * actually types. Dropped rather than passed through, so a typo costs an operator a host
     * that does not load instead of a policy that admits the internet.
     */
    for (const bad of [
      '*',
      "'unsafe-inline'",
      'https://*.coveryou.com',
      'https://host-one.coveryou.com/app',
      'https://host-one.coveryou.com/',
      'host-one.coveryou.com',
      'javascript:alert(1)',
      'data:',
    ]) {
      expect(parse(bad), `${bad} was admitted`).toEqual([]);
    }
  });

  it('keeps the good entries when one in a list is malformed', () => {
    expect(parse('https://a.coveryou.com, *, https://b.coveryou.com')).toEqual([
      'https://a.coveryou.com',
      'https://b.coveryou.com',
    ]);
  });

  it('admits a port, because a host application in development has one', () => {
    expect(parse('http://localhost:4000')).toEqual(['http://localhost:4000']);
  });
});

describe('the boot script', () => {
  /*
     Asserted as TEXT because it is text: it is injected into the document as a string, so
     nothing type-checks it and nothing imports it. What the tests below pin is that the three
     names it shares with the module cannot drift apart from it.
  */
  it('reads the parameter, the key and the attribute the module declares', () => {
    expect(embedBootScript).toContain(EMBED_PARAM);
    expect(embedBootScript).toContain(EMBED_KEY);
    expect(embedBootScript).toContain(EMBED_ATTRIBUTE);
  });

  it('clears the mode when the host asks for it, rather than only setting it', () => {
    /* `?embed=0` has to be able to turn it OFF. Without the else branch the flag would be a
       one-way door: set once in a tab, and every later StarLink page in that tab would render
       without a brand row for reasons nobody could see. */
    expect(embedBootScript).toContain('removeItem');
    expect(embedBootScript).toContain('removeAttribute');
  });

  it('cannot throw, whatever the browser allows', () => {
    /* `sessionStorage` throws outright in a browser set to block site data, and this runs in
       the head — an exception here would stop every script after it, including the theme. */
    expect(embedBootScript.startsWith('(function(){try{')).toBe(true);
    expect(embedBootScript.endsWith('}catch(_){}})();')).toBe(true);
  });
});
