/**
 * The sign-in canvas: light trails flowing in from the right, converging into the StarLink
 * star on the left.
 *
 * ## The star is the subject, and its proportion is the whole thing
 *
 * A four-point star with deep concave flanks, TALLER than it is wide — about 1:1.7. That
 * ratio is the thing to protect. An earlier version made it 3.5:1 the other way, reasoning
 * that long horizontal arms would echo the trails arriving on the same axis. It was wrong:
 * stretched horizontally the shape stops reading as a star and starts reading as a lens
 * flare, and a mark nobody recognises at a glance is no foundation for a logo. The arms do
 * still reach along the horizontal — as LIGHT (the wash below), not as geometry.
 *
 * One shape with a gradient across it, not two overlapping shapes. Coral enters at the left
 * point, violet leaves at the right, and they meet at a white core, so the two brand colours
 * are one object rather than a coral star sitting beside an indigo one.
 *
 * ## The trails
 *
 * Nine, not fourteen, and light trails rather than a wireframe: broad smooth curves with a
 * long, nearly-horizontal approach, over three very wide and very faint ribbons that give
 * the field depth. A handful of nodes, no more — a node on every line is a network diagram.
 *
 * ## Why the geometry is computed
 *
 * `mulberry32` seeded with a constant gives variation without randomness: the same picture
 * on the server and on the client, every render. `Math.random()` here would be a hydration
 * mismatch and a different page on every reload. Nine hand-authored curves would be four
 * hundred characters of coordinates nobody can revise.
 */
import type { ReactNode } from 'react';

const W = 1440;
const H = 900;

/** The star's centre. Left fifth, a little above the vertical middle. */
const STAR = { x: 302, y: 438 };

/**
 * Half-width and half-height.
 *
 * `STAR_RY / STAR_RX` is about 1.7, and it must stay greater than one. This single ratio
 * decides whether the mark reads as a star or as a smear.
 */
const STAR_RX = 108;
const STAR_RY = 172;

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
  node?: number;
}

/**
 * One light trail, from off the right edge to the star.
 *
 * The second control point sits far to the RIGHT of the star, and that distance is what
 * makes the arrival read as convergence rather than as a starburst: whatever the curve did
 * on its way across, its last stretch is long and nearly horizontal, so the nine run almost
 * parallel as they close and merge into the star instead of pointing at it.
 */
function strand(startY: number, sway: number, rng: () => number): Strand {
  const c1x = 1000 + rng() * 240;
  const c1y = startY + sway;
  const c2x = STAR.x + 560 + rng() * 320;
  const c2y = STAR.y + (rng() - 0.5) * 40;
  const endX = STAR.x + 26 + rng() * 40;
  const endY = STAR.y + (rng() - 0.5) * 22;

  const warm = rng() > 0.45;
  return {
    d: `M ${W + 140} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`,
    width: 0.9 + rng() * 0.9,
    opacity: 0.3 + rng() * 0.32,
    stroke: warm ? 'url(#sf-warm)' : 'url(#sf-cool)',
    ...(rng() > 0.62 ? { node: 0.3 + rng() * 0.34 } : {}),
  };
}

const STRANDS: Strand[] = (() => {
  const rng = mulberry32(20260906);
  const out: Strand[] = [];
  for (let i = 0; i < 9; i += 1) {
    const t = i / 8;
    const startY = -120 + t * (H + 240);
    // Alternating sway, larger the further a trail starts from the star's own height, so
    // the middle ones stay calm and the outer ones take the long way round.
    const sway = (i % 2 === 0 ? -1 : 1) * (110 + Math.abs(t - 0.5) * 420) * (0.6 + rng() * 0.6);
    out.push(strand(startY, sway, rng));
  }
  return out;
})();

/** The wide, faint ribbons behind the trails. Depth, not detail. */
const RIBBONS: { d: string; stroke: string }[] = (() => {
  const rng = mulberry32(77001);
  return [0.24, 0.5, 0.78].map((t, i) => {
    const startY = t * H;
    const sway = (i === 1 ? -1 : 1) * (160 + rng() * 200);
    return {
      d: `M ${W + 160} ${startY.toFixed(1)} C ${(1040 + rng() * 160).toFixed(1)} ${(startY + sway).toFixed(1)}, ${(STAR.x + 620).toFixed(1)} ${(STAR.y + (rng() - 0.5) * 60).toFixed(1)}, ${(STAR.x + 40).toFixed(1)} ${STAR.y}`,
      stroke: i === 1 ? 'url(#sf-cool)' : 'url(#sf-warm)',
    };
  });
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
 * A four-point star with deep concave flanks, from a centre and two radii.
 *
 * `waist` is the fraction of each radius at which a flank passes closest to the centre.
 * Small values pinch the shape to needle points; at 0.13 it bulges into a dented diamond.
 * 0.045 is a star.
 */
function sparkle(cx: number, cy: number, rx: number, ry: number, waist = 0.055): string {
  const wx = rx * waist;
  const wy = ry * waist;
  return [
    `M ${cx} ${cy - ry}`,
    `C ${cx + wx} ${cy - wy * 2.6}, ${cx + rx * 0.26} ${cy - wy}, ${cx + rx} ${cy}`,
    `C ${cx + rx * 0.26} ${cy + wy}, ${cx + wx} ${cy + wy * 2.6}, ${cx} ${cy + ry}`,
    `C ${cx - wx} ${cy + wy * 2.6}, ${cx - rx * 0.26} ${cy + wy}, ${cx - rx} ${cy}`,
    `C ${cx - rx * 0.26} ${cy - wy}, ${cx - wx} ${cy - wy * 2.6}, ${cx} ${cy - ry}`,
    'Z',
  ].join(' ');
}

const STAR_PATH = sparkle(STAR.x, STAR.y, STAR_RX, STAR_RY);

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
        {/* Coral in, violet out, along the direction of travel — a trail changes hue as it
            approaches and arrives the colour of the side of the star it meets. */}
        <linearGradient id="sf-warm" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#f05d49" stopOpacity="0" />
          <stop offset="30%" stopColor="#f05d49" stopOpacity="0.85" />
          <stop offset="80%" stopColor="#ec5138" stopOpacity="1" />
          <stop offset="100%" stopColor="#7b5cd6" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="sf-cool" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#7161d8" stopOpacity="0" />
          <stop offset="36%" stopColor="#6f5bd0" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#5b47c4" stopOpacity="1" />
        </linearGradient>

        {/*
           The star's own ramp, left to right across its extents.

           `userSpaceOnUse` with the star's real coordinates, so the ramp is anchored to the
           shape rather than to whatever bounding box each layer happens to have — the glow
           copy is larger, and object-space coordinates would slide the colours across it
           and leave the halo a different colour from the star inside it.
        */}
        <linearGradient
          id="sf-star"
          gradientUnits="userSpaceOnUse"
          x1={STAR.x - STAR_RX}
          y1={STAR.y}
          x2={STAR.x + STAR_RX}
          y2={STAR.y}
        >
          {/* Coral holds a little over half. Balanced at 50/50 the vertical arms both fell
              on the transition and the whole body read violet, with coral surviving only in
              the leftmost point — the reference gives coral the larger share and keeps the
              violet concentrated to the right of the core. */}
          <stop offset="0%" stopColor="#ee4726" />
          <stop offset="30%" stopColor="#f35c3c" />
          <stop offset="48%" stopColor="#f07a63" />
          <stop offset="60%" stopColor="#a87ade" />
          <stop offset="78%" stopColor="#6a4cd8" />
          <stop offset="100%" stopColor="#4b33c0" />
        </linearGradient>

        {/* The horizontal light the star sits in: the arms reaching along the axis the
            trails travel, as glow rather than as geometry. */}
        <radialGradient id="sf-wash">
          <stop offset="0%" stopColor="#f8836d" stopOpacity="0.4" />
          <stop offset="42%" stopColor="#c9a9ec" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sf-halo">
          <stop offset="0%" stopColor="#8e6ce6" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>

        {/* `userSpaceOnUse` with an explicit region: the default -10%/120% filter box clips
            a blur this wide and leaves a visible square edge around the glow. */}
        <filter id="sf-bloom" filterUnits="userSpaceOnUse" x="20" y="100" width="620" height="680">
          <feGaussianBlur stdDeviation="22" />
        </filter>
        <filter id="sf-sharp" filterUnits="userSpaceOnUse" x="100" y="160" width="440" height="560">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <filter id="sf-ribbon" filterUnits="userSpaceOnUse" x="0" y="0" width={W + 200} height={H}>
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      {/* Light first, so everything else sits inside it. */}
      <ellipse cx={STAR.x + 30} cy={STAR.y} rx="520" ry="120" fill="url(#sf-wash)" />
      <ellipse cx={STAR.x + 96} cy={STAR.y} rx="250" ry="190" fill="url(#sf-halo)" />

      <g fill="none" strokeLinecap="round" filter="url(#sf-ribbon)" opacity="0.55">
        {RIBBONS.map((r, i) => (
          <path key={`r${i}`} d={r.d} stroke={r.stroke} strokeWidth="34" strokeOpacity="0.24" />
        ))}
      </g>

      <g fill="none" strokeLinecap="round">
        {STRANDS.map((s, i) => (
          <path key={i} d={s.d} stroke={s.stroke} strokeWidth={s.width} strokeOpacity={s.opacity} />
        ))}
      </g>

      {/* A few nodes, placed ON their curve. Punctuation, not annotation. */}
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
              r={3}
              fill={warm ? '#f05d49' : '#6a54d4'}
              fillOpacity={0.75}
            />
          );
        })}
      </g>

      {/*
         The star: three passes of one path.

         A wide blurred copy is the glow, a barely-blurred copy is the body, and a small
         bright core sits on top. One shape trying to be all three is either soft or hard,
         never lit.
      */}
      <g filter="url(#sf-bloom)" opacity="0.62">
        <path d={sparkle(STAR.x, STAR.y, STAR_RX * 1.1, STAR_RY * 1.06)} fill="url(#sf-star)" />
      </g>
      <g filter="url(#sf-sharp)">
        <path d={STAR_PATH} fill="url(#sf-star)" />
      </g>
      <path
        d={sparkle(STAR.x, STAR.y, STAR_RX * 0.3, STAR_RY * 0.3, 0.07)}
        fill="#ffffff"
        fillOpacity="0.95"
      />
    </svg>
  );
}
