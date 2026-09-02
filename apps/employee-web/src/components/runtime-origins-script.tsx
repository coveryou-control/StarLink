/**
 * Writes the runtime origins into the document (§37.7).
 *
 * A server component, so `process.env` is read on the server at request time — which is
 * what makes the value environment-injected rather than build-inlined. See
 * `lib/runtime-origins.ts` for why that distinction is load-bearing.
 *
 * `<` is escaped before the JSON reaches the document. These values come from the
 * operator's own environment rather than from a user, so this is not the usual injection
 * case — but an unescaped `</script>` in a hostname would end the block and silently
 * corrupt the page, and the escape costs nothing.
 */
import { RUNTIME_ORIGINS_KEY, FALLBACK_ORIGINS } from '../lib/runtime-origins';

export function RuntimeOriginsScript(): React.JSX.Element {
  const origins = {
    api: process.env.SL_API_ORIGIN ?? FALLBACK_ORIGINS.api,
    realtime: process.env.SL_REALTIME_ORIGIN ?? FALLBACK_ORIGINS.realtime,
    /**
     * Stage 2's customer workspace, off by default (see `customerWorkspaceEnabled`).
     *
     * Compared against the string rather than coerced: `Boolean('false')` is `true`, and a
     * flag that turns itself on when an operator writes the word "false" is worse than no
     * flag. Only the exact string `'true'` enables it.
     */
    customerWorkspace: process.env.SL_CUSTOMER_WORKSPACE_ENABLED === 'true',
  };
  return (
    <script
      // The only way to seed a global before the bundle evaluates. The payload is JSON
      // built here from the server's own environment, never interpolated markup.
      dangerouslySetInnerHTML={{
        __html: `window.${RUNTIME_ORIGINS_KEY}=${JSON.stringify(origins).replace(/</g, '\u003c')}`,
      }}
    />
  );
}
