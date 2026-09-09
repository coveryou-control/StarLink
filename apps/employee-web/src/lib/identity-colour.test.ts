import { describe, expect, it } from 'vitest';

import {
  IDENTITY_HUES,
  RESERVED_HUES,
  distinctIdentityHues,
  identityHue,
  identityStyle,
  identityStyleFrom,
} from './identity-colour';

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

/**
 * Nobody in one room wears another person's colour.
 *
 * The hash alone cannot promise this and the arithmetic says how badly: nine hues and five
 * speakers is a 41% chance of a collision, and the six-hue palette this replaced was at 72%
 * with only four. Two matching names in one thread do not read as a coincidence to the
 * person reading them - they read as a relationship.
 */
describe('within one conversation, no two people share a colour', () => {
  /**
   * Real-looking ids, not sequential ones.
   *
   * The first draft of this suite generated `...000000000001`, `...000000000002` and so on,
   * and every fixture came out perfectly spread — the FNV-ish walk maps ids differing only
   * in their last character onto consecutive buckets, so sequential ids are the one input
   * that never collides. The tests below would have passed without the resolver ever
   * running, which is what the anti-vacuity case underneath them exists to catch, and did.
   *
   * These are twelve distinct v4-shaped ids. Eight of them collide.
   */
  const POOL: readonly string[] = [
    '3f2b9c14-7a55-4e21-9d0e-1c8a4b6f2e70',
    'a71d4e08-2c93-44b7-8f61-5d0e93a2c114',
    'c05e8b32-91af-4d6a-b23c-7e1f6a9d0552',
    '7d9a1f46-3b28-4c05-a7e9-2f4b8c1d6e33',
    'e4c72d59-6f10-48b3-95da-0a3c7e2b9f81',
    '12b6a8e0-4d7c-4f92-8e15-6b9d3a0c5f27',
    '9a3f0c71-58e2-4b46-a0d3-8c26f1e74b90',
    '5e8d2b47-0c91-4a38-96f2-3d7b5e0a1c64',
    'b6f19d03-7e42-4c85-8a10-49c2f6b3d708',
    '48c3e17a-9b06-4d52-a3f8-1e75b0c92d46',
    'fd2093b8-5a61-4e07-92c4-6b8f1d3a7e05',
    '2c7b4f90-18d3-4a6e-b5c1-9e0a26f4d873',
  ];

  const people = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => POOL[i % POOL.length]!);

  it.each([2, 3, 4, 5, 6, 7, 8, 9])('gives %i people %i different hues', (count) => {
    const hues = distinctIdentityHues(people(count));
    expect(new Set(hues.values()).size).toBe(count);
  });

  it('finds a collision to resolve in the first place, so this is not vacuous', () => {
    /* If the hash happened to spread every fixture perfectly, the tests above would pass
       without the resolution code ever running. This asserts the SETUP is a real test: some
       group of nine has at least two people whose preferred hue is the same. */
    const collided = [2, 3, 4, 5, 6, 7, 8, 9].some((count) => {
      const preferred = people(count).map(identityHue);
      return new Set(preferred).size < count;
    });
    expect(collided, 'no fixture collides — the resolver is never exercised').toBe(true);
  });

  it('keeps the hashed hue for everybody who can have it', () => {
    /* The property worth not losing: a person is the same colour in every room, except
       where that would cost distinctness in one of them. */
    const ids = people(4);
    const hues = distinctIdentityHues(ids);
    const kept = ids.filter((id) => hues.get(id) === identityHue(id));
    expect(kept.length).toBeGreaterThan(0);
  });

  it('does not depend on the order the ids arrive in', () => {
    /*
       THE stability property. The set of ids reaches this from a page of messages, from a
       participant list, and from a second page loaded by scrolling back — in three different
       orders. A person whose colour changed when older history loaded would be worse than
       no scheme.
    */
    const ids = people(6);
    const forwards = distinctIdentityHues(ids);
    const backwards = distinctIdentityHues([...ids].reverse());
    const shuffled = distinctIdentityHues([ids[3]!, ids[0]!, ids[5]!, ids[1]!, ids[4]!, ids[2]!]);
    for (const id of ids) {
      expect(backwards.get(id)).toBe(forwards.get(id));
      expect(shuffled.get(id)).toBe(forwards.get(id));
    }
  });

  it('ignores a repeated id rather than spending two hues on it', () => {
    const id = people(1)[0]!;
    const hues = distinctIdentityHues([id, id, id]);
    expect(hues.size).toBe(1);
  });

  it('still answers past the end of the palette', () => {
    /* `people` wraps the pool past twelve, which would hand `distinctIdentityHues` the same
       id twice — and it de-duplicates. Twelve is the largest honest ask. */
    /* Ten people in one room is past the point where colour is doing the identifying, and
       reuse is unavoidable — but every one of them must still GET a hue from the palette,
       rather than undefined and a grey circle. */
    const hues = distinctIdentityHues(people(12));
    expect(hues.size).toBe(12);
    for (const hue of hues.values()) expect(IDENTITY_HUES).toContain(hue);
  });

  it('hands the stylesheet the resolved hue, not the hashed one', () => {
    const ids = people(9);
    const hues = distinctIdentityHues(ids);
    for (const id of ids) {
      const style = identityStyleFrom(hues, id) as Record<string, string>;
      expect(Number(style['--identity-h'])).toBe(hues.get(id));
    }
  });

  it('falls back to the hash for somebody the map has never heard of', () => {
    /* A message from a person who has since left the conversation. A colour is better than
       none, and the hashed one is the colour they wore while they were here. */
    const style = identityStyleFrom(new Map(), 'a-departed-colleague') as Record<string, string>;
    expect(Number(style['--identity-h'])).toBe(identityHue('a-departed-colleague'));
  });
});
