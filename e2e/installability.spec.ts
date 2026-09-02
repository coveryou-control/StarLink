/**
 * The employee surface can be installed (NFR-MOB-1).
 *
 * *"Employee surface usable on tablet and phone; field staff are not desk-bound."*
 *
 * ## Why this is a browser test and not a file check
 *
 * Every part of this can be present in the repository and absent from the running
 * application, silently. `app/manifest.ts` only becomes `/manifest.webmanifest` if Next
 * picks the route up; the icons only exist if `public/` was copied into the build; the
 * `<link rel="manifest">` only appears if the root layout renders; and `viewport-fit=cover`
 * only reaches the document if the `viewport` export is shaped the way Next expects.
 *
 * A phone that cannot install the app degrades to a browser tab and nobody files a bug,
 * so nothing else would notice. Fetching the real URLs from the real server is the only
 * check that means anything.
 *
 * ## What it deliberately does not claim
 *
 * Not offline capability. There is no service worker, on purpose — a cache means a version
 * of the application that survives a deploy, and an offline send queue collides with the
 * rule that a message is durable before it is delivered. Installability and offline are
 * separable and only the first is built.
 */
import { expect, test } from '@playwright/test';

import { ORIGINS } from './support/env.js';

test('the employee surface is installable (NFR-MOB-1)', async ({ request }) => {
  const response = await request.get(`${ORIGINS.employeeWeb}/manifest.webmanifest`);
  expect(response.status(), 'no manifest is served').toBe(200);

  const manifest = (await response.json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };

  expect(manifest.name).toContain('StarLink');
  // `standalone`, not `browser`: `browser` is a manifest that installs to a tab, which is
  // the state this exists to move away from.
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/conversations');

  /**
   * Both purposes must be declared. Without `maskable` Android draws the icon on a white
   * plate inside the platform shape; with only `maskable` a platform that does not crop
   * shows the full-bleed square.
   */
  const purposes = new Set(manifest.icons.map((i) => i.purpose));
  expect(purposes.has('any'), 'no `any` icon').toBe(true);
  expect(purposes.has('maskable'), 'no `maskable` icon').toBe(true);

  // Every icon the manifest names must actually be served. A 404 here is invisible: the
  // install prompt simply never appears.
  for (const icon of manifest.icons) {
    const file = await request.get(`${ORIGINS.employeeWeb}${icon.src}`);
    expect(file.status(), `${icon.src} is not served`).toBe(200);
    expect(file.headers()['content-type'], `${icon.src} is not a PNG`).toContain('image/png');
  }

  const document = await (await request.get(`${ORIGINS.employeeWeb}/sign-in`)).text();
  expect(document, 'the document does not link its manifest').toContain('manifest.webmanifest');
  /**
   * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve to anything but
   * zero. Without it the composer sits under the home indicator on a notched phone and
   * the stylesheet's insets are dead code that looks like it works.
   */
  expect(document, 'viewport-fit=cover is missing').toContain('viewport-fit=cover');
});
