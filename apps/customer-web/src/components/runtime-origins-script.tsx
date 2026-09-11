/**
 * Writes the runtime origins into the document (§37.7).
 *
 * A server component, so `process.env` is read on the server at request time — which is
 * what makes the value environment-injected rather than build-inlined. See
 * `lib/runtime-origins.ts` for why that distinction is load-bearing.
 *
 * `<` is escaped before the JSON reaches the document, and for two years it was not.
 *
 * The replacement read `.replace(/</g, '\u003c')` — and in source that escape IS the
 * character `<`, so it replaced `<` with `<` and did nothing at all. Found twice
 * independently: by a review of the running code, and by CodeQL as
 * `js/identity-replacement`. It needs the doubled backslash, so what reaches the
 * document is the two-character sequence a JS parser turns back into `<` and an HTML
 * parser never reads as a tag.
 *
 * These values come from the
 * operator's own environment rather than from a user, so this is not the usual injection
 * case — but an unescaped `</script>` in a hostname would end the block and silently
 * corrupt the page, and the escape costs nothing.
 */
import { RUNTIME_ORIGINS_KEY, FALLBACK_ORIGINS } from '../lib/runtime-origins';

export function RuntimeOriginsScript(): React.JSX.Element {
  const origins = {
    api: process.env.SL_API_ORIGIN ?? FALLBACK_ORIGINS.api,
  };
  return (
    <script
      // The only way to seed a global before the bundle evaluates. The payload is JSON
      // built here from the server's own environment, never interpolated markup.
      dangerouslySetInnerHTML={{
        __html: `window.${RUNTIME_ORIGINS_KEY}=${JSON.stringify(origins).replace(/</g, '\\u003c')}`,
      }}
    />
  );
}
