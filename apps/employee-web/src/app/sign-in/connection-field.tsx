/**
 * The sign-in canvas: conversations arriving from the right and converging into one star.
 *
 * ## Why this is drawn rather than tiled
 *
 * Everywhere else in the product the constellation is a repeating 340px tile, because a
 * chat background has to survive being any size and must never draw attention. This is the
 * opposite brief: one composition, seen once, at a known scale, whose whole job is to be
 * looked at. A tile cannot converge on anything — every 340px it starts again — so the
 * figure the page is built around is impossible to express that way.
 *
 * ## Why the geometry is computed and not hand-authored path data
 *
 * Fourteen curves with varying trajectories are unreadable and unmaintainable as literal
 * cubic Béziers, and hand-drawn ones would not actually converge: the reason the lines look
 * intentional is that every one of them genuinely terminates at the star's centre and
 * approaches it along a flattening tangent. That is three lines of arithmetic and a
 * paragraph of explanation, or four hundred characters of coordinates nobody can revise.
 *
 * `mulberry32` seeded with a constant gives the variation without randomness: the same
 * fourteen curves on the server and on the client, every render. `Math.random()` here would
 * be a hydration mismatch, and a different picture on every reload.
 *
 * ## Scale
 *
 * Authored in a 1440x900 viewBox and sliced, so the composition is anchored rather than
 * stretched — `preserveAspectRatio` keeps the star's proportions at every window shape and
 * lets the right-hand ends of the lines run off the edge, which is where they should go.
 */
import type { ReactNode } from 'react';

const W = 1440;
const H = 900;

/** The point everything arrives at. Left third, slightly above centre. */
const STAR = { x: 344, y: 430 };

/** Deterministic, so server and client draw the same picture. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Strand {
  d: string;
  width: number;
  opacity: number;
  stroke: string;
  /** Where along the curve a node sits, or none. Nodes are punctuation, not decoration. */
  node?: number;
}

/**
 * One curve from off the right edge to the star.
 *
 * The second control point is pinned near the star and on its horizontal axis, which is
 * what makes the arrival read as convergence: whatever the line did on its way across, it
 * flattens into the star's own axis in the last stretch. Without that they merely end in
 * the same place, like spokes, and the figure looks like a wheel instead of a confluence.
 */
function strand(startY: number, sway: number, rng: () => number): Strand {
  // The first control point stays near the start height, so a line keeps its own altitude
  // across the right half instead of turning for the star the moment it appears.
  const c1x = 1080 + rng() * 220;
  const c1y = startY + sway * 0.5;

  /*
     The second control point is far to the RIGHT of the star — six to nine hundred units —
     and that distance is the whole difference between convergence and a starburst.

     Pinned close to the star (the first attempt used +150) every curve turns hard in its
     last stretch and the fourteen of them arrive as spokes: the figure reads as an
     explosion radiating outward rather than as traffic flowing in. Pushed far out, the
     approach is long and nearly horizontal, the lines run almost parallel as they close,
     and they merge into the star instead of pointing at it.
  */
  const c2x = STAR.x + 620 + rng() * 300;
  const c2y = STAR.y + (rng() - 0.5) * 30;

  const warm = rng() > 0.44;
  // A shade short of the exact centre, spread slightly, so fourteen strokes do not stack
  // into one dark knot at a single coordinate.
  const endX = STAR.x + 6 + rng() * 26;
  const endY = STAR.y + (rng() - 0.5) * 14;

  return {
    d: `M ${W + 120} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`,
    width: 0.6 + rng() * 0.7,
    opacity: 0.17 + rng() * 0.26,
    stroke: warm ? 'url(#sf-warm)' : 'url(#sf-cool)',
    ...(rng() > 0.52 ? { node: 0.3 + rng() * 0.36 } : {}),
  };
}

const STRANDS: Strand[] = (() => {
  const rng = mulberry32(20260906);
  const out: Strand[] = [];
  // Spread beyond the top and bottom edges: lines that all begin inside the frame look
  // like a diagram of themselves. These come from somewhere off-screen.
  for (let i = 0; i < 14; i += 1) {
    const t = i / 13;
    const startY = -140 + t * (H + 280);
    // Alternating sway, scaled by distance from the vertical middle, so the curves nearest
    // the star's own height stay calm and the outer ones take the long way round.
    const sway = (i % 2 === 0 ? -1 : 1) * (90 + Math.abs(t - 0.5) * 460) * (0.55 + rng() * 0.7);
    out.push(strand(startY, sway, rng));
  }
  return out;
})();

/** Cubic Bézier evaluation, to place a node ON its line rather than near it. */
function pointAt(d: string, t: number): { x: number; y: number } {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const [p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y] = n as [
    number, number, number, number, number, number, number, number,
  ];
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * p0x + b * c1x + c * c2x + e * p1x,
    y: a * p0y + b * c1y + c * c2y + e * p1y,
  };
}

/**
 * A four-point star with concave flanks, drawn from unit geometry.
 *
 * The horizontal radius is much the larger of the two, which is what makes it read as a
 * star of light on an axis rather than a diamond — and it is the same axis the lines
 * arrive on, so the figure and the strands are one shape rather than two.
 */
function sparkle(cx: number, cy: number, rx: number, ry: number): string {
  /*
     The waist. At 0.13 the flanks bulge and the shape reads as a diamond with dented
     sides; at 0.05 they pinch to needle points and it reads as light. This single number
     is the difference between a star and a blob, and it wants to be small.
  */
  const wx = rx * 0.05;
  const wy = ry * 0.05;
  return [
    `M ${cx} ${cy - ry}`,
    `C ${cx + wx} ${cy - wy * 2.4}, ${cx + rx * 0.28} ${cy - wy}, ${cx + rx} ${cy}`,
    `C ${cx + rx * 0.28} ${cy + wy}, ${cx + wx} ${cy + wy * 2.4}, ${cx} ${cy + ry}`,
    `C ${cx - wx} ${cy + wy * 2.4}, ${cx - rx * 0.28} ${cy + wy}, ${cx - rx} ${cy}`,
    `C ${cx - rx * 0.28} ${cy - wy}, ${cx - wx} ${cy - wy * 2.4}, ${cx} ${cy - ry}`,
    'Z',
  ].join(' ');
}

export function ConnectionField(): ReactNode {
  return (
    <svg
      className="signin-canvas"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Coral into indigo along the direction of travel, so a strand changes hue as it
            approaches — the two brand colours meeting at the star rather than sitting
            beside each other. */}
        <linearGradient id="sf-warm" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#f05d49" stopOpacity="0" />
          <stop offset="32%" stopColor="#f05d49" stopOpacity="0.9" />
          <stop offset="82%" stopColor="#e0533f" stopOpacity="1" />
          <stop offset="100%" stopColor="#7b5cd6" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="sf-cool" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#6f5bd0" stopOpacity="0" />
          <stop offset="38%" stopColor="#6f5bd0" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#5b47c4" stopOpacity="1" />
        </linearGradient>

        <radialGradient id="sf-bloom-warm">
          <stop offset="0%" stopColor="#f05d49" stopOpacity="0.2" />
          <stop offset="45%" stopColor="#f8a08f" stopOpacity="0.07" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sf-bloom-cool">
          <stop offset="0%" stopColor="#6b52d8" stopOpacity="0.17" />
          <stop offset="55%" stopColor="#a99bee" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>

        {/* The glow. `userSpaceOnUse` with an explicit region because the default -10%/120%
            filter box clips a blur this wide and leaves a visible square edge. */}
        <filter id="sf-glow" filterUnits="userSpaceOnUse" x="0" y="140" width="900" height="580">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id="sf-glow-tight" filterUnits="userSpaceOnUse" x="60" y="230" width="700" height="400">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>

      {/* Bloom first, so everything else sits in its light. */}
      <ellipse cx={STAR.x + 10} cy={STAR.y} rx="360" ry="200" fill="url(#sf-bloom-warm)" />
      <ellipse cx={STAR.x + 170} cy={STAR.y + 8} rx="320" ry="170" fill="url(#sf-bloom-cool)" />

      <g fill="none" strokeLinecap="round">
        {STRANDS.map((s, i) => (
          <path
            key={i}
            d={s.d}
            stroke={s.stroke}
            strokeWidth={s.width}
            strokeOpacity={s.opacity}
          />
        ))}
      </g>

      {/* Nodes: a handful of points where a line carries something. Placed ON the curve. */}
      <g>
        {STRANDS.map((s, i) => {
          if (s.node === undefined) return null;
          const p = pointAt(s.d, s.node);
          const warm = s.stroke.includes('warm');
          return (
            <circle
              key={`n${i}`}
              cx={p.x}
              cy={p.y}
              r={2.6}
              fill={warm ? '#f05d49' : '#6a54d4'}
              fillOpacity={0.72}
            />
          );
        })}
      </g>

      {/* The star: a blurred double underneath doing the glowing, a crisp one on top doing
          the drawing. One shape trying to do both is either soft or hard, never lit. */}
      {/*
         ONE star, lit from two sides — not a coral shape beside an indigo one.

         Two things make it read as a single object rather than a pair of fins. The centres
         sit close together (±26, where ±100 read as two shapes that happen to touch), so
         the lobes interpenetrate and the white core belongs to both. And the vertical
         radius is roughly a quarter of the horizontal: a tall star is a diamond, and it
         was the height, more than anything else, that made the first attempt look like a
         butterfly rather than a point of light on the same axis the strands travel.
      */}
      <g filter="url(#sf-glow)" opacity="0.5">
        <path d={sparkle(STAR.x - 26, STAR.y, 268, 80)} fill="#f0563f" />
        <path d={sparkle(STAR.x + 30, STAR.y, 178, 70)} fill="#5f45d4" />
      </g>
      <g filter="url(#sf-glow-tight)">
        <path d={sparkle(STAR.x - 20, STAR.y, 250, 70)} fill="#f4674f" fillOpacity="0.9" />
        <path d={sparkle(STAR.x + 26, STAR.y, 164, 60)} fill="#6448d8" fillOpacity="0.86" />
      </g>
      {/* The core. Small and bright: the arms are the shape, this is the light source. */}
      <path d={sparkle(STAR.x, STAR.y, 152, 40)} fill="#ffffff" fillOpacity="0.45" />
      <path d={sparkle(STAR.x, STAR.y, 44, 19)} fill="#ffffff" fillOpacity="0.96" />
    </svg>
  );
}
