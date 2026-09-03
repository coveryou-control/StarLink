/**
 * Builds the conversation wallpaper.
 *
 * ## Ours, not a copy of anybody's
 *
 * The ask was "a background behind the chat, the way WhatsApp has one". WhatsApp's doodle
 * wallpaper is their artwork and is not ours to ship, so this is the same IDEA — a faint
 * tiled line pattern behind the messages — drawn from CoverYou's own subject matter. The
 * motifs are the things this company insures and the things this product does: a shield, an
 * umbrella, a house, a car, a heart, a policy document, a clipboard, a stamp. Somebody who
 * looks closely sees an insurer's desk, not a beach ball and a snowboard.
 *
 * ## Why generated
 *
 * One source, two outputs. The pattern needs a different ink on a light ground than on a
 * dark one, and hand-maintaining two copies of sixteen paths is how they drift. The script
 * emits both as data URIs in a CSS file, so there is no extra request, nothing to 404, and
 * the committed output is reviewable.
 *
 * A data URI rather than a file in `public/`: the pattern is ~2KB encoded, which is smaller
 * than the request that would fetch it, and it cannot arrive after the first paint.
 *
 * Run: `node scripts/generate-wallpaper.mjs` from apps/employee-web.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The tile. Big enough that the repeat is not a texture you can count. */
const TILE = 300;

/**
 * Each motif is a path in its own 24×24 box, placed with a translate, a rotation and a
 * scale. Every one sits well inside the tile: a shape crossing the edge would have to be
 * drawn twice to tile seamlessly, and at this opacity the cost of avoiding that is nothing.
 */
const MOTIFS = {
  // Cover, in the most literal sense.
  shield: 'M12 3.2 19 6v5.4c0 4.2-2.9 7.4-7 9.4-4.1-2-7-5.2-7-9.4V6l7-2.8Z',
  umbrella: 'M12 4.2c4.3 0 7.8 3.2 7.8 7.2H4.2c0-4 3.5-7.2 7.8-7.2ZM12 11.4v6.4a2 2 0 0 1-4 0',
  // The four things a policy is usually about.
  house: 'M4 11 12 4.6 20 11M6.2 9.6V19h11.6V9.6M10 19v-4.6h4V19',
  car: 'M4 15.5v-2.2l1.8-4.2h12.4L20 13.3v2.2M4 15.5h16M4 15.5v2h2.6v-2M17.4 15.5v2H20v-2M7.4 12.9h9.2',
  heart: 'M12 19.4S4.6 15 4.6 9.9A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7.4 1.9c0 5.1-7.4 9.5-7.4 9.5Z',
  life: 'M4.6 12a7.4 7.4 0 1 0 14.8 0 7.4 7.4 0 0 0-14.8 0Zm3.2 0a4.2 4.2 0 1 0 8.4 0 4.2 4.2 0 0 0-8.4 0ZM6.2 6.2l2.6 2.6M17.8 6.2l-2.6 2.6M6.2 17.8l2.6-2.6M17.8 17.8l-2.6-2.6',
  // The desk it all happens on.
  document: 'M6.4 3.8h7.2L18 8.2v12H6.4ZM13.4 3.8v4.6H18M9 12.4h6M9 15.6h6',
  clipboard: 'M8.6 5.2H6.8v15h10.4v-15h-1.8M9.2 3.6h5.6v3.2H9.2Z',
  envelope: 'M4.4 6.8h15.2v10.4H4.4ZM4.4 6.8 12 13l7.6-6.2',
  stamp: 'M8.4 10.6V7.4a3.6 3.6 0 0 1 7.2 0v3.2M6 10.6h12v4.2H6ZM6.6 17.2h10.8',
  // The product itself.
  bubble: 'M20 11.4c0 3.7-3.6 6.6-8 6.6a9.6 9.6 0 0 1-2.5-.33L5 19.6l1.2-3.1A6.3 6.3 0 0 1 4 11.4C4 7.7 7.6 4.8 12 4.8s8 2.9 8 6.6Z',
  paperclip: 'M15.6 9.2 9.4 15.4a2.6 2.6 0 0 0 3.7 3.7l6.6-6.6a4.6 4.6 0 0 0-6.5-6.5L6.6 12.6',
  check: 'M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Zm-3.4 7.7 2.4 2.4 4.4-4.6',
  clock: 'M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2ZM12 8v4.3l2.8 1.7',
  // Two small ones, to break up the rhythm.
  spark: 'M12 5.4 13.3 10l4.6 1.3-4.6 1.3L12 17.2l-1.3-4.6L6.1 11.3 10.7 10Z',
  pin: 'M12 4.6c-2.6 0-4.6 2-4.6 4.5 0 3.4 4.6 9 4.6 9s4.6-5.6 4.6-9c0-2.5-2-4.5-4.6-4.5Zm0 6.3a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z',
};

/**
 * Where each one sits. `[motif, x, y, rotation, scale]`.
 *
 * Placed by hand rather than by a random seed. A scatter that a script produces has clumps
 * and holes, and at this size the eye finds both; sixteen positions is few enough to just
 * arrange. Rotations are all small — a motif at 40° reads as a mistake rather than as
 * casual.
 */
const LAYOUT = [
  ['shield', 24, 22, -8, 1.15],
  ['bubble', 108, 14, 6, 1.0],
  ['house', 196, 30, -5, 1.2],
  ['spark', 268, 18, 10, 0.8],
  ['document', 12, 108, 7, 1.05],
  ['heart', 84, 96, -10, 0.95],
  ['car', 156, 110, 4, 1.15],
  ['clock', 240, 96, -6, 0.95],
  ['pin', 60, 176, 9, 0.85],
  ['umbrella', 130, 186, -7, 1.1],
  ['clipboard', 212, 172, 5, 1.0],
  ['paperclip', 278, 150, -12, 0.8],
  ['life', 20, 246, -4, 1.05],
  ['envelope', 96, 262, 8, 0.95],
  ['check', 176, 250, -9, 0.9],
  ['stamp', 250, 254, 6, 1.05],
];

const svgFor = (ink, alpha) => {
  const shapes = LAYOUT.map(([name, x, y, rotate, scale]) => {
    const d = MOTIFS[name];
    if (d === undefined) throw new Error(`unknown motif: ${name}`);
    return (
      `<g transform='translate(${x} ${y}) rotate(${rotate}) scale(${scale})'>` +
      `<path d='${d}'/></g>`
    );
  }).join('');

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE}' height='${TILE}' ` +
    `viewBox='0 0 ${TILE} ${TILE}'>` +
    `<g fill='none' stroke='${ink}' stroke-opacity='${alpha}' stroke-width='1.5' ` +
    `stroke-linecap='round' stroke-linejoin='round'>${shapes}</g></svg>`
  );
};

/**
 * Percent-encoding, not base64.
 *
 * A `url()` only needs the handful of characters below escaped, and leaving the rest as
 * text keeps the pattern greppable and diffable in the generated file — base64 would make
 * every change to one path an unreviewable wall.
 */
/*
   Colours arrive here RAW, as `#rrggbb`.

   They were pre-encoded as `%23rrggbb` at the call sites, and the first replacement below
   turns every `%` into `%25` — so `%23` became `%2523`, the stroke attribute held a literal
   string instead of a colour, and the whole pattern rendered with no stroke at all. The
   background was "applied" and invisible, which is the worst of both.
*/
const dataUri = (svg) =>
  `url("data:image/svg+xml,${svg
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/"/g, '%22')}")`;

const HERE = dirname(fileURLToPath(import.meta.url));
const target = resolve(HERE, '..', 'src', 'app', 'chat-wallpaper.css');

writeFileSync(
  target,
  `/* GENERATED by scripts/generate-wallpaper.mjs — do not edit by hand.
 *
 * The conversation wallpaper: ${LAYOUT.length} line-art motifs on a ${TILE}px tile, drawn
 * from what CoverYou insures and what this product does. Ours, not a copy of another
 * messenger's artwork.
 *
 * Two inks, because the pattern has to sit on a light ground and a dark one and a single
 * colour cannot do both. Regenerate with \`node scripts/generate-wallpaper.mjs\`.
 */
/*
   The ground and the ink, as a pair.

   A first attempt drew near-black hairlines at 4.5% on the app's cool #FAFAFA and the
   result was invisible — technically applied, and not a wallpaper. Two things fix it and
   both matter:

   - The ink is a warm BROWN, not black. Grey line art on grey reads as a dirty screen;
     the same lines with a hue read as drawn on purpose.
   - The ground is a warm off-white rather than the cool one the rest of the shell uses.
     Paper is warm, and the warmth is most of why a patterned chat background feels like a
     surface rather than like a texture laid over an interface.

   The dark theme needs neither: white lines on a dark ground already have somewhere to go,
   and warming a dark surface just makes it look stained.
*/
:root {
  --thread-ground: #fbf8f5;
  --thread-wallpaper: ${dataUri(svgFor('#7a5a42', '0.17'))};
}

:root[data-theme='dark'] {
  --thread-ground: var(--surface-raised);
  --thread-wallpaper: ${dataUri(svgFor('#ffffff', '0.055'))};
}
`,
  'utf8',
);

console.log(`wrote ${LAYOUT.length} motifs on a ${TILE}px tile -> ${target}`);
