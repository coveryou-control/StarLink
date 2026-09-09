'use client';

import type { CSSProperties } from 'react';

/**
 * One colour per person, the same colour everywhere they appear.
 *
 * ## What this replaces, and why the old one could not work
 *
 * `senderColour` mapped a principal onto six SEMANTIC tokens — `--base-info-label`,
 * `--base-success-label`, `--base-warning-label`, `--base-critical-label`,
 * `--brand-primary-700` and a grey. So a colleague's name was rendered in the exact red
 * that means "error", or the exact green that means "success", or the amber that means
 * "warning". Measured: Rishitt's name and monogram came out `rgb(198, 12, 8)`, which is
 * `--base-critical-label` to the byte. Borrowing the status palette for identity is a
 * category error in both directions — it makes people look like alerts, and it is why the
 * product had two greens with only one of them meaning anything.
 *
 * It was also applied to the THREAD only. The conversation list, the chat header and the
 * header's avatar stack used one flat tint for everybody, so the same person was
 * `rgb(160, 62, 49)` brick in the list and `rgb(27, 60, 206)` blue three inches to the
 * right — on an identical pink circle in both places, because the tint was never part of
 * the scheme at all. A blue R on a pink circle is not a decision anybody made; it is two
 * half-schemes overlapping.
 *
 * ## The hues, and why these six
 *
 * A hue is reserved if the product already means something by it. Measured off the running
 * app: accent 7°, critical 1°, warning 38°, success 146°, info 229°. Every hue below sits
 * at least 24° from all five, so no monogram can be mistaken for a status, and they are
 * spread far enough from each other to be told apart at 32px.
 *
 * Six, matching the buckets the old function had: a conversation holds a handful of people,
 * and more buckets would mean finer distinctions than anybody can hold in their head.
 *
 * ## Why a hue rather than a pair of colours
 *
 * The tint and the ink are derived from the SAME number, in CSS, per theme — so they
 * cannot drift apart the way a hand-maintained pair of tokens does, and dark mode is one
 * extra rule rather than six more values. `identity-colour.test.ts` proves every hue clears
 * AA on its own tint in both themes.
 */
export const IDENTITY_HUES = [95, 172, 198, 262, 300, 335] as const;

/** Hues the product already means something by. Kept here so the test can assert distance. */
export const RESERVED_HUES = {
  accent: 7,
  critical: 1,
  warning: 38,
  success: 146,
  info: 229,
} as const;

/**
 * Stable across sessions, machines and surfaces, because it is a pure function of the id.
 *
 * The same FNV-ish walk the old one used — it was never the problem, and changing it would
 * reshuffle every colour in the product for no gain.
 */
export function identityHue(id: string | undefined): number {
  if (id === undefined || id === '') return IDENTITY_HUES[0];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return IDENTITY_HUES[hash % IDENTITY_HUES.length] ?? IDENTITY_HUES[0];
}

/**
 * The style a monogram carries. Everything else is done by the stylesheet.
 *
 * A custom property rather than a computed colour so the two themes can resolve it
 * differently from one number — a component that wrote `background: '#dcecdc'` would be
 * light-mode-only and would need to know which theme it is in, which a component should
 * not have to.
 */
export function identityStyle(id: string | undefined): CSSProperties {
  return { ['--identity-h' as string]: String(identityHue(id)) };
}
