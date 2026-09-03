import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { SessionProvider } from '../components/session-provider';
import { RuntimeOriginsScript } from '../components/runtime-origins-script';
import { themeBootScript } from '../lib/theme';
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

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <RuntimeOriginsScript />
        {/*
          The theme, resolved before the first paint.

          Read in a component effect it would arrive one render late, which is a white
          flash on every load for anybody using dark. `suppressHydrationWarning` because
          this script mutates `<html>` before React reaches it, which is the point.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {/* Pointer-or-keyboard, before the first paint — see `input-modality.ts`. */}
        <script dangerouslySetInnerHTML={{ __html: inputModalityBootScript }} />
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
