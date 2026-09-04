/**
 * Builds the conversation wallpaper.
 *
 * ## A constellation, because the product is called StarLink
 *
 * The ask was "a background behind the chat, the way WhatsApp has one". Theirs is their
 * artwork and is not ours to ship, so this is the same idea drawn from our own name: stars,
 * and the lines between them. A link between two points is what the product does — one
 * person to another — and it is what the name already says, so the pattern needs no
 * explaining.
 *
 * A first version used insurance motifs: a shield, an umbrella, a car. It read as clip art.
 * Sixteen recognisable OBJECTS behind a conversation compete with it — each one is a thing
 * to identify, and the eye keeps going back to them. A constellation is texture. It has no
 * subject to read, which is the whole job of a background.
 *
 * ## Why generated
 *
 * One source, two outputs. The pattern needs a different ink on a light ground than on a
 * dark one, and hand-maintaining two copies is how they drift. Emitted as data URIs, so
 * there is no extra request and nothing that can arrive after the first paint.
 *
 * Run: `node scripts/generate-wallpaper.mjs` from apps/employee-web.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The tile. Large enough that the repeat is not a rhythm you can count. */
const TILE = 340;

/**
 * The stars, named so the links below can refer to them.
 *
 * `[x, y, kind, size]` — a `dot` is a filled point, a `spark` is a four-pointed star. All of
 * them sit well inside the tile: a shape crossing the edge would have to be drawn twice to
 * tile seamlessly, and there is no reason to spend that.
 */
const STARS = {
  a1: [46, 58, 'spark', 7],
  a2: [104, 34, 'dot'],
  a3: [138, 84, 'spark', 5],
  a4: [92, 122, 'dot'],

  b1: [232, 44, 'dot'],
  b2: [286, 78, 'spark', 6],
  b3: [248, 126, 'dot'],

  c1: [40, 208, 'dot'],
  c2: [98, 248, 'spark', 6.5],
  c3: [156, 214, 'dot'],
  c4: [132, 292, 'dot'],

  d1: [236, 196, 'spark', 5.5],
  d2: [300, 238, 'dot'],
  d3: [252, 288, 'dot'],

  /* Lone points, so the tile is not four tidy clusters and nothing else. */
  e1: [186, 150, 'spark', 8],
  e2: [26, 148, 'dot'],
  e3: [176, 40, 'dot'],
  e4: [312, 158, 'dot'],
  e5: [58, 314, 'spark', 4.5],
  e6: [206, 318, 'dot'],
  e7: [116, 172, 'dot'],
  e8: [298, 316, 'dot'],
};

/**
 * Which stars are joined.
 *
 * Deliberately not all of them. A fully connected field is a mesh, and a mesh reads as a
 * diagram; a constellation is a few joined and the rest left alone, which is what makes it
 * look like a sky rather than a network graph.
 */
const LINKS = [
  ['a1', 'a2'],
  ['a2', 'a3'],
  ['a3', 'a4'],
  ['b1', 'b2'],
  ['b2', 'b3'],
  ['c1', 'c2'],
  ['c2', 'c3'],
  ['c2', 'c4'],
  ['d1', 'd2'],
  ['d2', 'd3'],
  ['e1', 'a3'],
  ['e1', 'e7'],
];

/** A four-pointed star: concave sides, so it reads as a twinkle rather than a plus. */
const sparkPath = (x, y, r) => {
  const w = r * 0.34;
  return (
    `M ${x} ${y - r} ` +
    `C ${x + w} ${y - w} ${x + w} ${y - w} ${x + r} ${y} ` +
    `C ${x + w} ${y + w} ${x + w} ${y + w} ${x} ${y + r} ` +
    `C ${x - w} ${y + w} ${x - w} ${y + w} ${x - r} ${y} ` +
    `C ${x - w} ${y - w} ${x - w} ${y - w} ${x} ${y - r} Z`
  );
};

const svgFor = (ink, lineAlpha, starAlpha) => {
  const lines = LINKS.map(([from, to]) => {
    const a = STARS[from];
    const b = STARS[to];
    if (a === undefined || b === undefined) throw new Error(`unknown star: ${from}/${to}`);
    return `<line x1='${a[0]}' y1='${a[1]}' x2='${b[0]}' y2='${b[1]}'/>`;
  }).join('');

  const sparks = Object.values(STARS)
    .filter(([, , kind]) => kind === 'spark')
    .map(([x, y, , r]) => `<path d='${sparkPath(x, y, r)}'/>`)
    .join('');

  const dots = Object.values(STARS)
    .filter(([, , kind]) => kind === 'dot')
    .map(([x, y]) => `<circle cx='${x}' cy='${y}' r='1.9'/>`)
    .join('');

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE}' height='${TILE}' ` +
    `viewBox='0 0 ${TILE} ${TILE}'>` +
    // The links sit under the stars and are fainter: the points are what you notice, the
    // lines are what you find when you look.
    `<g stroke='${ink}' stroke-opacity='${lineAlpha}' stroke-width='1' ` +
    `stroke-linecap='round'>${lines}</g>` +
    `<g fill='${ink}' fill-opacity='${starAlpha}'>${dots}</g>` +
    `<g fill='none' stroke='${ink}' stroke-opacity='${starAlpha}' stroke-width='1.4' ` +
    `stroke-linejoin='round'>${sparks}</g>` +
    `</svg>`
  );
};

/**
 * A single small constellation, for the sign-in page's corner.
 *
 * Not `svgFor`: that draws a 340px TILE, designed to repeat seamlessly and therefore to
 * spread its stars evenly. This is a composition — five stars and four links, weighted to
 * one side, with space around it — because it is drawn once at a known position and its
 * job is to be noticed peripherally and then ignored.
 *
 * The alpha is baked in here rather than applied by the page: nothing fades this on the
 * way through, and the first version was drawn at 0.5 on the assumption that something
 * would. It rendered as a large piece of line art in the corner competing with the form —
 * the opposite of a whisper. A tenth is where it stops being a picture and starts being a
 * texture you notice on the second look.
 */
const traceSvg = (ink, alpha) => {
  const points = [
    [34, 108],
    [96, 62],
    [150, 118],
    [214, 54],
    [186, 158],
  ];
  const links = [
    [0, 1],
    [1, 2],
    [2, 4],
    [1, 3],
  ];

  const lines = links
    .map(([a, b]) => {
      const [x1, y1] = points[a];
      const [x2, y2] = points[b];
      return `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}'/>`;
    })
    .join('');

  // The two brightest points get the four-pointed figure; the rest stay dots, so the
  // group has a hierarchy rather than five identical marks.
  const sparkles = [points[1], points[3]]
    .map(([x, y]) => `<path d='${sparkPath(x, y, 9)}'/>`)
    .join('');
  const dots = points.map(([x, y]) => `<circle cx='${x}' cy='${y}' r='2.4'/>`).join('');

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='248' height='200' viewBox='0 0 248 200'>` +
    `<g stroke='${ink}' stroke-opacity='${Number(alpha) * 0.55}' stroke-width='1' ` +
    `stroke-linecap='round'>${lines}</g>` +
    `<g fill='${ink}' fill-opacity='${alpha}'>${dots}</g>` +
    `<g fill='none' stroke='${ink}' stroke-opacity='${alpha}' stroke-width='1.4' ` +
    `stroke-linejoin='round'>${sparkles}</g>` +
    `</svg>`
  );
};

/**
 * Percent-encoding, not base64.
 *
 * A `url()` needs only the handful of characters below escaped, and leaving the rest as
 * text keeps the pattern greppable and diffable — base64 would make a one-point change an
 * unreviewable wall.
 *
 * Colours arrive RAW, as `#rrggbb`. They were pre-encoded as `%23rrggbb` once, and the
 * first replacement below turns every `%` into `%25` — so `%23` became `%2523`, the stroke
 * attribute held a literal string instead of a colour, and the whole pattern rendered with
 * no stroke. Applied, and invisible.
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
const starCount = Object.keys(STARS).length;

writeFileSync(
  target,
  `/* GENERATED by scripts/generate-wallpaper.mjs — do not edit by hand.
 *
 * The conversation wallpaper: ${starCount} stars and ${LINKS.length} links on a ${TILE}px
 * tile. Named after the product, and texture rather than pictures — see the generator.
 *
 * Three inks: the pattern sits on a light ground, a dark one, and the sign-in screen —
 * where it carries the brand's colour instead of the thread's near-colourless indigo.
 * Regenerate with \`node scripts/generate-wallpaper.mjs\`.
 */
:root {
  /*
     A cool near-white, not the warm paper an earlier version used.

     Warm cream under brown line art is another messenger's look, and beside CY Orange it
     turned the whole column sepia. A sky is cool, the bubbles are the only warm thing on
     the screen, and a background's job is to leave them that way.
  */
  --thread-ground: #f7f8fa;
  --thread-wallpaper: ${dataUri(svgFor('#2b3a63', '0.09', '0.16'))};

  /*
     The same sky, in the brand's ink, for the sign-in screen.

     The thread's wallpaper is nearly colourless because it sits under text all day. The
     sign-in page holds one card and nothing else, so the pattern can carry the product's
     own colour — it is the one moment in the application where the name and the picture
     are allowed to be the point.

     Stronger too: 14% and 26% against the thread's 9% and 16%. There is no text over it
     to protect, and at the thread's strength the pattern simply vanished on a page with no
     bubbles to give it scale.
  */
  /*
     A TRACE, not a tile — for the sign-in page.

     The full pattern was there and had to go: 250px of repeating stars behind a 360px form
     is two competing grids, and the screen read as busy rather than branded. This is one
     small asymmetric group, drawn once and anchored off a corner without repeating, so the
     product's own figure is present as a whisper and never as a wallpaper.

     No backticks in this comment: it lives inside the output template literal, and one
     would end the string. The parse error then points at a line further down that is
     perfectly fine.

     Its own coordinates rather than a crop of the tile: a crop lands wherever the tile's
     stars happen to fall, and half of them would be cut by the edge.
  */
  --signin-trace: ${dataUri(traceSvg('#2b3a63', '0.1'))};
}

:root[data-theme='dark'] {
  --thread-ground: var(--surface-raised);
  --thread-wallpaper: ${dataUri(svgFor('#ffffff', '0.05', '0.11'))};
  --signin-trace-dark: ${dataUri(traceSvg('#ffffff', '0.13'))};
}
`,
  'utf8',
);

console.log(`wrote ${starCount} stars and ${LINKS.length} links on a ${TILE}px tile -> ${target}`);
