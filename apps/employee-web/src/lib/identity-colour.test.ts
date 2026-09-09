import { describe, expect, it } from 'vitest';

import { IDENTITY_HUES, RESERVED_HUES, identityHue, identityStyle } from './identity-colour';

/**
 * The identity palette, and the two things that make it one.
 *
 * A person is the same colour everywhere, and no person's colour is a colour the product
 * already means something by. The second is the one the old `senderColour` broke: it drew
 * people in `--base-critical-label`, which is the red that means an error has happened.
 */

/** The tint and ink the stylesheet derives, mirrored here so contrast can be asserted. */
/*
   Ink at 28%, not 30%.

   At 30 the green and teal ends measured 4.50 and 4.46 against their own tints — under AA
   by a rounding error, which is the least useful kind of failure to ship. Green and yellow
   carry more luminance than blue at the same HSL lightness, so a single lightness across
   six hues has to be set by its worst case rather than its average.
*/
const LIGHT = { tint: [65, 91], ink: [62, 28] } as const;
const DARK = { tint: [30, 24], ink: [70, 76] } as const;

/** HSL to sRGB, so contrast can be computed from the same numbers the CSS uses. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

/** Shortest way round the wheel. 350 and 10 are twenty degrees apart, not three hundred. */
const apart = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('a person is the same colour everywhere', () => {
  it('gives the same id the same hue every time', () => {
    const id = '018f5eed-de70-7000-8000-000000000003';
    expect(identityHue(id)).toBe(identityHue(id));
  });

  it('does not depend on where it is called from', () => {
    /* The whole point. The list, the thread, the header and the reaction panel each call
       this independently, and a person who came out differently in any one of them is the
       defect this replaced — brick in the list, blue in the thread, on the same circle. */
    const id = 'a-principal-id';
    const surfaces = [identityHue(id), identityHue(id), identityHue(id)];
    expect(new Set(surfaces).size).toBe(1);
  });

  it('only ever returns a hue from the palette', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `018f5eed-de70-7000-8000-${String(i).padStart(12, '0')}`);
    for (const id of ids) expect(IDENTITY_HUES).toContain(identityHue(id));
  });

  it('spreads a realistic set of people across the palette', () => {
    /* A palette that collapses onto one bucket is a flat tint with extra steps. */
    const ids = Array.from({ length: 60 }, (_, i) => `018f5eed-de70-7000-8000-${String(i).padStart(12, '0')}`);
    const used = new Set(ids.map(identityHue));
    expect(used.size).toBe(IDENTITY_HUES.length);
  });

  it('falls back rather than throwing on a missing id', () => {
    expect(IDENTITY_HUES).toContain(identityHue(undefined));
    expect(IDENTITY_HUES).toContain(identityHue(''));
  });

  it('hands the stylesheet a number, not a colour', () => {
    /* A component that computed `#dcecdc` would be light-mode-only, and would have to know
       which theme it is in to do better. */
    const style = identityStyle('018f5eed-de70-7000-8000-000000000003') as Record<string, string>;
    expect(Number(style['--identity-h'])).toBeGreaterThan(0);
    expect(IDENTITY_HUES).toContain(Number(style['--identity-h']));
  });
});

describe('no person looks like a status', () => {
  it.each(IDENTITY_HUES)('%i is clear of every reserved hue', (hue) => {
    /*
       Measured off the running product: accent 7, critical 1, warning 38, success 146,
       info 229. The old palette did not avoid these — it WAS these, which is how a
       colleague's name came out in the red that means something failed.
    */
    for (const [name, reserved] of Object.entries(RESERVED_HUES)) {
      expect(apart(hue, reserved), `${hue} is too close to ${name} (${reserved})`).toBeGreaterThanOrEqual(24);
    }
  });

  it('keeps the hues far enough apart from each other to tell at 32px', () => {
    const sorted = [...IDENTITY_HUES].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(apart(sorted[i]!, sorted[i - 1]!)).toBeGreaterThanOrEqual(25);
    }
  });
});

describe('every pair is readable, in both themes', () => {
  it.each(IDENTITY_HUES)('%i clears AA in light', (hue) => {
    const tint = hslToRgb(hue, LIGHT.tint[0], LIGHT.tint[1]);
    const ink = hslToRgb(hue, LIGHT.ink[0], LIGHT.ink[1]);
    expect(contrast(ink, tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(IDENTITY_HUES)('%i clears AA in dark', (hue) => {
    const tint = hslToRgb(hue, DARK.tint[0], DARK.tint[1]);
    const ink = hslToRgb(hue, DARK.ink[0], DARK.ink[1]);
    expect(contrast(ink, tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(IDENTITY_HUES)('%i reads as a name on the page itself, not only on its tint', (hue) => {
    /* `.author` is ink on the THREAD, with no circle behind it — so the ink has to work
       against the page as well as against its own tint. */
    const inkLight = hslToRgb(hue, LIGHT.ink[0], LIGHT.ink[1]);
    expect(contrast(inkLight, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);

    const inkDark = hslToRgb(hue, DARK.ink[0], DARK.ink[1]);
    expect(contrast(inkDark, [14, 14, 16])).toBeGreaterThanOrEqual(4.5);
  });
});
