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
 * NINE, and the count is arithmetic rather than taste. Six was chosen to match the buckets
 * the old function had, on the reasoning that a conversation holds a handful of people. That
 * reasoning had the birthday problem the wrong way round: with six hues and four speakers the
 * chance that all four differ is 6/6 x 5/6 x 4/6 x 3/6 = **28%**. Nearly three groups in four
 * had two people wearing one colour, which is worse than no scheme at all - it says "these two
 * are related" about two people who are not.
 *
 * Nine is as many as the constraints allow. Every hue must sit at least 24 degrees from all
 * five reserved hues and at least 25 from its neighbours, and those exclusions leave three
 * usable arcs - roughly 62-122, 170-205 and 253-337 - which hold nine and not ten.
 *
 * Nine still collides at five speakers, so the palette is only half the answer.
 * `distinctIdentityHues` is the other half: within one conversation nobody shares a colour,
 * whatever the hash says.
 *
 * ## Why a hue rather than a pair of colours
 *
 * The tint and the ink are derived from the SAME number, in CSS, per theme — so they
 * cannot drift apart the way a hand-maintained pair of tokens does, and dark mode is one
 * extra rule rather than six more values. `identity-colour.test.ts` proves every hue clears
 * AA on its own tint in both themes.
 */
export const IDENTITY_HUES = [68, 95, 120, 176, 201, 259, 285, 311, 336] as const;

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

/**
 * One colour each, guaranteed, for the people in ONE conversation.
 *
 * ## Why the hash alone is not enough
 *
 * `identityHue` is a hash into nine buckets, so two colleagues in the same room can land on
 * the same hue - and with five speakers it is more likely than not. A palette whose whole
 * job is "tell these people apart at a glance" cannot leave that to chance: two matching
 * names in one thread do not read as a coincidence, they read as a relationship.
 *
 * ## How the collisions are settled
 *
 * Everybody keeps their hashed hue where they can have it, so a person is usually the same
 * colour in every room - which is the property `identity-colour`'s docblock is about, and
 * which is worth keeping wherever it does not cost distinctness.
 *
 * Where two people want one hue, the id that sorts first keeps it and the other walks the
 * palette to the next free one. Sorting by id rather than by arrival order is what makes
 * this STABLE: the assignment does not depend on who spoke first, on which page of history
 * has loaded, or on the order the server returned the participants in. Load an older page,
 * scroll back, reopen the thread tomorrow - the same person is the same colour.
 *
 * ## When there are more people than hues
 *
 * Past nine, reuse is unavoidable and the function says so by simply wrapping. Ten people in
 * one room is past the point where colour is doing the identifying anyway - the names are,
 * and they are right there. What matters is that the first nine never collide.
 */
export function distinctIdentityHues(ids: readonly string[]): ReadonlyMap<string, number> {
  const assigned = new Map<string, number>();
  const taken = new Set<number>();

  /* Sorted, and de-duplicated: the same id twice must not consume two hues. */
  const ordered = [...new Set(ids.filter((id) => id !== ''))].sort();

  for (const id of ordered) {
    const preferred = identityHue(id);
    if (!taken.has(preferred)) {
      assigned.set(id, preferred);
      taken.add(preferred);
      continue;
    }
    /* Walk forward from the preferred hue so the substitute is still near the colour this
       person wears elsewhere, rather than jumping to the other end of the wheel. */
    const start = IDENTITY_HUES.indexOf(preferred as (typeof IDENTITY_HUES)[number]);
    let placed = false;
    for (let step = 1; step < IDENTITY_HUES.length; step += 1) {
      const candidate = IDENTITY_HUES[(start + step) % IDENTITY_HUES.length]!;
      if (taken.has(candidate)) continue;
      assigned.set(id, candidate);
      taken.add(candidate);
      placed = true;
      break;
    }
    /* Every hue is spoken for - more people than colours. See the note above. */
    if (!placed) assigned.set(id, preferred);
  }

  return assigned;
}

/**
 * The style for one person, from a map `distinctIdentityHues` built.
 *
 * Falls back to the bare hash for anybody the map does not know, so a message from somebody
 * who has left the conversation still gets a colour rather than none.
 */
export function identityStyleFrom(
  hues: ReadonlyMap<string, number>,
  id: string | undefined,
): CSSProperties {
  const hue = id !== undefined ? hues.get(id) : undefined;
  return { ['--identity-h' as string]: String(hue ?? identityHue(id)) };
}
