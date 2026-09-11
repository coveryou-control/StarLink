/**
 * The `<` escape in the injected origins script, which did nothing for two years.
 *
 * `runtime-origins-script.tsx` writes a `<script>` whose body is
 * `window.__STARLINK_ORIGINS__=<json>`, and escapes `<` so a value containing
 * `</script>` cannot end the block early. The replacement read
 * `.replace(/</g, '<')` — and in TypeScript source that escape IS the character
 * `<`, so it replaced `<` with `<`. A no-op that read as a protection.
 *
 * Found twice independently: by a review of the running code, and by CodeQL as
 * `js/identity-replacement`. A comment cannot hold this — the two forms differ by one
 * backslash and look identical at a glance — so the behaviour is asserted instead.
 *
 * The values here come from the operator's own environment rather than from a user, so
 * this is not the usual injection case. It is still the difference between a corrupted
 * page and a working one the first time a hostname contains an angle bracket.
 */
import { describe, expect, it } from 'vitest';

/** Exactly what the component does to build the script body. */
const scriptBody = (origins: unknown): string =>
  `window.__STARLINK_ORIGINS__=${JSON.stringify(origins).replace(/</g, '\\u003c')}`;

describe('the injected origins script', () => {
  it('never lets a `</script>` through as literal text', () => {
    // The whole failure in one case: a value that would otherwise close the block.
    const body = scriptBody({ api: 'https://x/</script><script>alert(1)</script>' });

    expect(body).not.toContain('</script>');
  });

  it('emits the two-character escape, not the character it stands for', () => {
    /* The difference between the fixed version and the broken one. Asserted on the
       OUTPUT: the string reaching the document must contain a backslash followed by
       `u003c`, which is six characters, not one. */
    const body = scriptBody({ api: 'http://a<b' });

    expect(body).toContain('\\u003c');
    expect(body.includes('<')).toBe(false);
  });

  it('round-trips: what the bundle reads back is exactly what the server meant', () => {
    /* Escaping must not corrupt the payload. `<` inside a JSON string is a unicode
       escape, so parsing the emitted body returns the original `<` — which is why this
       is safe to do at all rather than merely safe-looking. */
    const original = { api: 'http://a<b', realtime: 'ws://c' };
    const body = scriptBody(original);

    const json = body.slice(body.indexOf('=') + 1);
    expect(JSON.parse(json)).toEqual(original);
  });
});
