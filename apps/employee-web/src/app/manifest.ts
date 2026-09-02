import type { MetadataRoute } from 'next';

/**
 * Installability (NFR-MOB-1).
 *
 * ## Why a manifest at all
 *
 * Field staff are not desk-bound, and the surface they use all day was reachable only as
 * a browser tab — which on a phone means the URL bar, the tab strip and the browser
 * chrome all take height from a screen that has none to spare, and the product has no
 * presence on the home screen. A manifest costs one file and turns the same build into
 * something that can be installed and opened like an application.
 *
 * ## `standalone`, not `fullscreen`
 *
 * `fullscreen` removes the status bar, which takes the clock, the battery and the signal
 * strength away from somebody who is out of the office and needs all three. The gain
 * would be about 24px.
 *
 * ## What this deliberately does NOT add
 *
 * No service worker. A service worker means a cache, a cache means a version of the
 * application that survives a deploy, and offline messaging means a queue of unsent
 * messages — which collides directly with rule 1 (a message is durable before it is
 * delivered) and would need a design, not a file. Installability and offline capability
 * are separable, and only the first is claimed here.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'StarLink — Employee',
    short_name: 'StarLink',
    description: 'CoverYou Conversation OS — employee surface',
    start_url: '/conversations',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#fbfaf9',
    theme_color: '#0b1b3a',
    icons: [
      // Each file is declared twice, once per purpose. The spec allows a space-separated
      // `"any maskable"` and Next's `MetadataRoute.Manifest` type does not, so two entries
      // say the same thing in a form that typechecks.
      //
      // Both purposes matter. Without `maskable`, Android draws the icon on a white plate
      // inside the platform shape; with only `maskable`, a platform that does not crop
      // shows the full-bleed square. The mark sits inside the central 52% of the canvas,
      // comfortably within the 80% safe zone, so the crop takes background and nothing
      // else and the same file is correct for both.
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
