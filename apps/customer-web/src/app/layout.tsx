import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { RuntimeOriginsScript } from '../components/runtime-origins-script';

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
  title: 'CoverYou — Chat',
  description: 'Talk to CoverYou',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zooming is left available. Locking it is a common mobile-chat habit and an
  // accessibility failure: someone who needs to magnify text is not a layout problem.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <head>
        <RuntimeOriginsScript />
      </head>
      <body>{children}</body>
    </html>
  );
}
