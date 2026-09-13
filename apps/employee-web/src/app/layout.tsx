import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import './globals.css';
import { SessionProvider } from '../components/session-provider';
import { RuntimeOriginsScript } from '../components/runtime-origins-script';
import { themeBootScript } from '../lib/theme';
import { chatBackgroundBootScript } from '../lib/chat-background';
import { inputModalityBootScript } from '../lib/input-modality';

/**
 * Rendered per request, not prerendered.
 *
 * This is what makes `RuntimeOriginsScript` actually runtime. Next prerenders a layout
 * that reads no request data, and a prerendered layout reads `process.env` at BUILD time
 * — which would reintroduce the exact defect the injector exists to remove, while looking
 * like it had been fixed. The build output is the tell: these routes must be listed
 * `ƒ (Dynamic)`, never `○ (Static)`.
 *
 * The cost is small and the alternative is wrong: every route on this surface is behind a
 * session or a live conversation, so there is no meaningful static output to lose.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'StarLink — Employee',
  description: 'CoverYou Conversation OS',
  applicationName: 'StarLink',
  appleWebApp: { capable: true, title: 'StarLink', statusBarStyle: 'default' },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};

/**
 * `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` resolve to anything other
 * than zero. Without it the composer sits under the home indicator on a notched phone and
 * the stylesheet's insets are dead code that looks like it works.
 *
 * `maximumScale` and `userScalable` are deliberately left at their defaults. Locking zoom
 * is the usual companion to this block and it is an accessibility regression: somebody who
 * needs to pinch a message larger must be able to.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b1b3a',
};

export default async function RootLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  /*
     The nonce the middleware minted for THIS request.

     Next applies it to its own inline scripts automatically once the CSP header names
     one; the four this layout writes itself are not Next's, so they carry it by hand.
     Without it they are exactly the scripts the policy is designed to refuse — and the
     three boot scripts run before first paint, so the failure would be a white flash and
     a wrong theme rather than an error anybody notices.

     `headers()` is what makes this layout dynamic per request, which it already had to
     be for the runtime origins.
  */
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <RuntimeOriginsScript nonce={nonce} />
        {/*
          The three brand families, fetched here rather than from CSS.

          `ds/fonts.css` used to open with `@import url('https://fonts.googleapis.com/…')`
          and it never once loaded: an `@import` is only honoured before every other rule
          in the sheet, and that file is inlined at line 53 of `globals.css`, behind the
          ten `@font-face` declarations `emoji-font.css` brings in at line 1. The browser
          drops such an import silently — no console error, no network request — so the
          whole product rendered in `system-ui` while the tokens named Poppins.

          A `<link>` cannot be invalidated by stylesheet ordering, and it starts the fetch
          in parallel with the stylesheet instead of waiting for it to parse. The two
          `preconnect`s open the TLS handshakes to both hosts before the CSS names them;
          `gstatic` needs `crossOrigin` because font files are fetched anonymously and a
          preconnect on the wrong credentials mode opens a connection nothing reuses.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400;1,600&family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap"
        />
        {/*
          The theme, resolved before the first paint.

          Read in a component effect it would arrive one render late, which is a white
          flash on every load for anybody using dark. `suppressHydrationWarning` because
          this script mutates `<html>` before React reaches it, which is the point.
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {/* Same reason as the theme's: read from an effect, the first paint would be the
            default ground and the second the chosen one — a visible flash on the largest
            surface on the screen, every load. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: chatBackgroundBootScript }} />
        {/* Pointer-or-keyboard, before the first paint — see `input-modality.ts`. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: inputModalityBootScript }} />
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
