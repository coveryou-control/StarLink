import { NextResponse, type NextRequest } from 'next/server';

/**
 * A Content-Security-Policy with a real nonce, and HSTS where it means something.
 *
 * ## Why this was missing, and why it mattered
 *
 * `FEATURE_STATUS.md` recorded a restrictive CSP as set. Neither browser surface sent
 * one: `next.config.mjs` carried `X-Content-Type-Options`, `X-Frame-Options` and
 * `Referrer-Policy` and stopped there. The API has always sent
 * `default-src 'none'; frame-ancestors 'none'` — correct for an API and no help at all
 * to the surface that renders colleague-supplied text, filenames, channel names and
 * display names.
 *
 * ## Why a nonce rather than `'unsafe-inline'`
 *
 * The document carries fourteen inline scripts: Next's own bootstrap and RSC payload,
 * plus the two this app injects (the theme, resolved before first paint to avoid a white
 * flash, and the runtime origins). `script-src 'unsafe-inline'` would admit all of them
 * and every injected one too, which is a CSP in name only — it would satisfy an audit
 * and stop nothing.
 *
 * A per-request nonce admits exactly the scripts this server wrote. Next applies it to
 * its own tags automatically when the CSP header names one; `layout.tsx` reads it from
 * the `x-nonce` request header for the two it writes itself.
 *
 * `'strict-dynamic'` lets those trusted scripts load the chunks they need without this
 * policy enumerating every hashed filename webpack produces.
 *
 * ## Why the origins are read here
 *
 * `connect-src` has to name the API and the realtime gateway, and those are runtime
 * values (§37.7) — a build-inlined origin is the exact failure `runtime-origins` exists
 * to prevent, and a CSP baked with staging's origins would silently block production's
 * traffic. Read per request, same as everything else about them.
 */

/**
 * Read INSIDE the request, never at module scope.
 *
 * This was `const API_ORIGIN = process.env.SL_API_ORIGIN ?? …` at the top of the file,
 * and Next evaluates module-scope `process.env` in middleware at BUILD time. So the
 * policy was baked with whichever origin the build machine happened to have, and any
 * deployment with a different one had `connect-src` naming the wrong host — every API
 * call blocked, the app rendering and never hydrating.
 *
 * The browser suite found it: sixteen specs failed on `locator.click` timeouts because
 * the API runs on its own port there. That is exactly the defect `runtime-origins.ts`
 * exists to prevent, in a file whose own header cites it.
 */
const apiOrigin = (): string => process.env.SL_API_ORIGIN ?? 'http://localhost:3011';
const realtimeOrigin = (): string => process.env.SL_REALTIME_ORIGIN ?? 'http://localhost:3100';

/** `http://x` also needs `ws://x`; `https://x` needs `wss://x`. */
const socketOrigin = (origin: string): string => origin.replace(/^http/, 'ws');

export function middleware(request: NextRequest): NextResponse {
  const API_ORIGIN = apiOrigin();
  const REALTIME_ORIGIN = realtimeOrigin();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const policy = [
    `default-src 'self'`,
    /* `strict-dynamic` means the nonce carries to whatever those scripts load, so the
       hashed chunk filenames do not have to be enumerated here. `'self'` stays for
       browsers that do not understand it. */
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    /* Styles are the one concession. Next inlines critical CSS without a nonce, and an
       injected stylesheet cannot execute — it can deface and it can probe layout, which
       is a real but far smaller thing than script execution. Stated rather than hidden. */
    /* Google Fonts: the three brand families are linked from `layout.tsx` rather than
       from CSS, so the STYLESHEET comes from `fonts.googleapis.com` and the faces from
       `fonts.gstatic.com`. Found by driving the product under the policy — reasoning
       about the policy had missed both. */
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    /* `data:` for the inlined glyphs and generated avatars, `blob:` for a voice note or
       an image being previewed before it is sent. */
    /* The API origin serves avatars — a person's photograph and a group's picture are
       `<img src>` straight at `/v1/employee/avatars/…`, not proxied through this app.
       Twenty-six of the twenty-eight violations on the first run were these. */
    `img-src 'self' data: blob: ${API_ORIGIN}`,
    `media-src 'self' blob:`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    /* The API, the gateway's socket, and Google's FCM registration endpoints — the
       browser talks to those directly when a device registers for push. */
    [
      `connect-src 'self'`,
      API_ORIGIN,
      REALTIME_ORIGIN,
      socketOrigin(REALTIME_ORIGIN),
      'https://fcmregistrations.googleapis.com',
      'https://fcm.googleapis.com',
    ].join(' '),
    /* The service worker, and nothing else may become one. */
    `worker-src 'self'`,
    `manifest-src 'self'`,
    /* Nothing embeds, nothing is embedded, nothing navigates a form elsewhere. */
    `object-src 'none'`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);

  /*
     HSTS, but only on a request that actually arrived over TLS.

     Sending it over plain http is ignored by browsers, so it would be decoration — and
     worse than decoration on a LAN address, where a stray `max-age` pinned against a
     host that has no certificate makes the product unreachable until the header expires.
     `x-forwarded-proto` is what a terminating proxy sets; `request.nextUrl.protocol`
     covers a direct TLS listener.

     Two years, with subdomains, and `preload` deliberately ABSENT: preloading is close
     to irreversible and is a decision about the whole coveryou.co.in domain, not about
     one application. That belongs to whoever owns the domain.
  */
  const secure =
    request.headers.get('x-forwarded-proto') === 'https' ||
    request.nextUrl.protocol === 'https:';
  if (secure) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return response;
}

export const config = {
  /*
     Everything except Next's own static output.

     A hashed chunk under `/_next/static` is immutable and cached hard; running this on
     each one would mint a nonce nobody reads and defeat that caching for no benefit.
     The DOCUMENT is what needs the policy.
  */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
