/**
 * The sign-in canvas: the StarLink star on the left, with light trails flowing away to the
 * right.
 *
 * Drawn to match a supplied reference image as closely as SVG allows. Three things in it
 * are easy to get wrong, and all three were wrong at some point:
 *
 * ## 1. The gradient runs DIAGONALLY, not left to right
 *
 * This is what makes the reference star look lit rather than merely two-toned. Coral enters
 * at the upper left, violet leaves at the lower right — so the TOP point is coral, the
 * BOTTOM point is violet, and the horizontal points take the ends of the same ramp. With a
 * purely horizontal gradient both vertical points land on the middle of the ramp and come
 * out the same muddy lilac, which is exactly what the previous version did.
 *
 * ## 2. The proportion is near-square, about 1:1.28
 *
 * Measured off the reference: the sharp body spans roughly 167 x 193 either side of centre.
 * One earlier version drew it 3.5:1 WIDE (a lens flare, not a star); the correction
 * over-shot to 1:1.6 tall (a needle). It wants to be only slightly taller than wide.
 *
 * ## 3. The flanks are gently concave, and the points are long
 *
 * A deep waist gives needles with no body; a shallow one gives a dented diamond. The
 * reference has a substantial core with points that taper a long way out of it.
 *
 * Everything else — the flare streaks through the centre, the faint orbital rings, the
 * hollow nodes among the filled ones — is detail from the reference that reads as absence
 * when it is missing, even though no one would list it.
 *
 * ## Why the geometry is computed
 *
 * `mulberry32` seeded with a constant gives variation without randomness: the same picture
 * on the server and on the client, every render. `Math.random()` here would be a hydration
 * mismatch and a different page on every reload.
 */
import type { ReactNode } from 'react';

const W = 1440;
const H = 900;

/** The star's centre, measured off the reference and scaled into this viewBox. */
const STAR = { x: 202, y: 432 };

/**
 * Half-width and half-height of the sharp body.
 *
 * `STAR_RY / STAR_RX` is 1.28 — only slightly taller than wide. Below 1 it stops being a
 * star; much above 1.4 it becomes a needle.
 */
const STAR_RX = 96;
const STAR_RY = 123;

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
  nodes: { t: number; r: number; hollow: boolean; warm: boolean }[];
}

/**
 * One light trail, leaving the star and running off the right edge.
 *
 * The control point nearest the star sits far to its RIGHT, so the first stretch is long and
 * nearly horizontal: the trails leave along the star's own axis and only then curve away.
 * Pinned close, they radiate like spokes and the figure reads as an explosion.
 */
function strand(endY: number, sway: number, rng: () => number): Strand {
  const c1x = STAR.x + 300 + rng() * 260;
  const c1y = STAR.y + (rng() - 0.5) * 26;
  const c2x = 980 + rng() * 260;
  const c2y = endY - sway * 0.55;

  const warm = rng() > 0.5;
  /*
     Every trail begins at the star's right POINT — the same coordinate, no jitter.

     It was `STAR_RX * 0.9` plus up to 40 units of randomness, which put some strands inside
     the body and others clear of the tip with a gap between. The bundle then read as a
     separate object floating beside the star rather than as light leaving it, and the join
     was the first thing the eye went to.

     Nothing is lost by pinning them: they diverge immediately afterwards because their
     control points still vary, so the fan is as varied as before and only the origin is
     shared. A shape and the lines leaving it have to actually touch.
  */
  // A shade INSIDE the point, not exactly on it. The flank is concave, so the last few
  // units of the point are a hairline — ending the trails precisely at `STAR_RX` left a
  // visible gap where the star had already tapered to nothing but the lines had not yet
  // begun. Overlapping by seven per cent puts the convergence under solid colour.
  const startX = STAR.x + STAR_RX * 0.93;
  const startY = STAR.y;

  // The reference carries about fifteen nodes across the field; at one-in-three strands
  // there were six, and the right half read as empty line-work.
  const count = rng() > 0.22 ? (rng() > 0.45 ? 2 : 1) : 0;
  const nodes = Array.from({ length: count }, () => ({
    t: 0.18 + rng() * 0.7,
    r: 2.4 + rng() * 2.6,
    // Hollow rings among the filled dots. The reference has both, and a field of only
    // filled dots reads flatter than it should.
    hollow: rng() > 0.62,
    warm: rng() > 0.45,
  }));

  return {
    d: `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${(W + 150).toFixed(1)} ${endY.toFixed(1)}`,
    width: 0.9 + rng() * 1.0,
    opacity: 0.3 + rng() * 0.38,
    stroke: warm ? 'url(#sf-warm)' : 'url(#sf-cool)',
    nodes,
  };
}

const STRANDS: Strand[] = (() => {
  const rng = mulberry32(20260907);
  const out: Strand[] = [];
  for (let i = 0; i < 13; i += 1) {
    const t = i / 12;
    const endY = -180 + t * (H + 380);
    const sway = (i % 2 === 0 ? 1 : -1) * (120 + Math.abs(t - 0.5) * 420) * (0.5 + rng() * 0.8);
    out.push(strand(endY, sway, rng));
  }
  return out;
})();

/** The wide pale ribbons behind the trails. Depth, not detail. */
const RIBBONS: { d: string; stroke: string }[] = (() => {
  const rng = mulberry32(4412);
  return [0.3, 0.46, 0.62, 0.8].map((t, i) => {
    const endY = t * H;
    const sway = (i % 2 === 0 ? 1 : -1) * (140 + rng() * 220);
    return {
      d: `M ${(STAR.x + STAR_RX * 0.93).toFixed(1)} ${STAR.y} C ${(STAR.x + 420).toFixed(1)} ${(STAR.y + (rng() - 0.5) * 50).toFixed(1)}, ${(1000 + rng() * 200).toFixed(1)} ${(endY - sway).toFixed(1)}, ${(W + 170).toFixed(1)} ${endY.toFixed(1)}`,
      stroke: i % 2 === 0 ? 'url(#sf-warm)' : 'url(#sf-cool)',
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
 * A four-point star with concave flanks.
 *
 * `waist` is how far the flank pulls in toward the centre, as a fraction of each radius, and
 * `shoulder` is how far along each point the flank stays wide before tapering. Together they
 * decide whether the shape has a body: a small waist with a small shoulder gives four
 * needles meeting at nothing.
 */
function sparkle(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  waist = 0.085,
  shoulder = 0.3,
): string {
  const wx = rx * waist;
  const wy = ry * waist;
  return [
    `M ${cx} ${cy - ry}`,
    `C ${cx + wx} ${cy - wy * 2.2}, ${cx + rx * shoulder} ${cy - wy}, ${cx + rx} ${cy}`,
    `C ${cx + rx * shoulder} ${cy + wy}, ${cx + wx} ${cy + wy * 2.2}, ${cx} ${cy + ry}`,
    `C ${cx - wx} ${cy + wy * 2.2}, ${cx - rx * shoulder} ${cy + wy}, ${cx - rx} ${cy}`,
    `C ${cx - rx * shoulder} ${cy - wy}, ${cx - wx} ${cy - wy * 2.2}, ${cx} ${cy - ry}`,
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
        <linearGradient id="sf-warm" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ef5a3a" stopOpacity="1" />
          <stop offset="45%" stopColor="#f2664a" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#f2917c" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="sf-cool" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#5a3fd4" stopOpacity="1" />
          <stop offset="45%" stopColor="#6f56dd" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#a396ec" stopOpacity="0.15" />
        </linearGradient>

        {/*
           The star's ramp, running DIAGONALLY from upper-left to lower-right.

           This is the single most consequential line in the file. Horizontal, both vertical
           points sit at the middle of the ramp and come out the same lilac; diagonal, the
           top point is coral, the bottom is violet, and the star reads as lit from one side
           rather than as two colours stuck together.

           `userSpaceOnUse` with the star's real coordinates so the ramp is anchored to the
           shape rather than to each layer's own bounding box — the glow copy is larger, and
           object-space units would slide the colours across it.
        */}
        <linearGradient
          id="sf-star"
          gradientUnits="userSpaceOnUse"
          x1={STAR.x - STAR_RX * 0.72}
          y1={STAR.y - STAR_RY * 0.72}
          x2={STAR.x + STAR_RX * 0.72}
          y2={STAR.y + STAR_RY * 0.72}
        >
          <stop offset="0%" stopColor="#f4693f" />
          <stop offset="20%" stopColor="#f23c11" />
          <stop offset="40%" stopColor="#f24d22" />
          <stop offset="53%" stopColor="#dd4e86" />
          <stop offset="66%" stopColor="#8331e2" />
          <stop offset="84%" stopColor="#4d1fd6" />
          <stop offset="100%" stopColor="#3c12c2" />
        </linearGradient>

        {/* The bloom the star sits in. */}
        <radialGradient id="sf-bloom-c">
          <stop offset="0%" stopColor="#ff8f76" stopOpacity="0.34" />
          <stop offset="45%" stopColor="#d2a2e8" stopOpacity="0.13" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sf-bloom-v">
          <stop offset="0%" stopColor="#7b57e4" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* The core's own halo — pink at the centre, as the reference has it. */}
        <radialGradient id="sf-core">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="45%" stopColor="#ffd9d0" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ffb9c8" stopOpacity="0" />
        </radialGradient>

        {/* The lens streaks through the centre: a long horizontal one and a shorter
            vertical, both nearly white. They are what make the core read as a light source
            rather than as a white shape. */}
        <linearGradient id="sf-streak-h" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff9d8a" stopOpacity="0" />
          <stop offset="40%" stopColor="#ffc9bd" stopOpacity="0.3" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#c9b6f5" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#a99bee" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sf-streak-v" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffb9a6" stopOpacity="0" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#a99bee" stopOpacity="0" />
        </linearGradient>

        {/*
           `userSpaceOnUse` with an explicit region: the default -10%/120% filter box clips a
           blur this wide and leaves a visible square edge around the glow.

           The regions are DERIVED from the star rather than written as literals. They were
           literals, positioned around where the star happened to sit — so moving or resizing
           it silently cropped the glow against an invisible box, which is a bug that looks
           like a design decision. `PAD` is generous because a blur needs roughly three
           standard deviations of room.
        */}
        <filter
          id="sf-bloom"
          filterUnits="userSpaceOnUse"
          x={STAR.x - STAR_RX - 160}
          y={STAR.y - STAR_RY - 160}
          width={STAR_RX * 2 + 320}
          height={STAR_RY * 2 + 320}
        >
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <filter
          id="sf-soft"
          filterUnits="userSpaceOnUse"
          x={STAR.x - STAR_RX - 40}
          y={STAR.y - STAR_RY - 40}
          width={STAR_RX * 2 + 80}
          height={STAR_RY * 2 + 80}
        >
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
        <filter
          id="sf-crisp"
          filterUnits="userSpaceOnUse"
          x={STAR.x - STAR_RX - 16}
          y={STAR.y - STAR_RY - 16}
          width={STAR_RX * 2 + 32}
          height={STAR_RY * 2 + 32}
        >
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
        <filter id="sf-ribbon" filterUnits="userSpaceOnUse" x="0" y="-100" width={W + 220} height={H + 200}>
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter
          id="sf-streak"
          filterUnits="userSpaceOnUse"
          x={STAR.x - 520}
          y={STAR.y - 300}
          width="1100"
          height="600"
        >
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
      </defs>

      {/* Light first, so everything else sits inside it. */}
      <ellipse cx={STAR.x - 10} cy={STAR.y} rx={STAR_RX * 2.3} ry={STAR_RY * 1.45} fill="url(#sf-bloom-c)" />
      <ellipse cx={STAR.x + STAR_RX * 0.82} cy={STAR.y + 40} rx={STAR_RX * 1.85} ry={STAR_RY * 1.25} fill="url(#sf-bloom-v)" />

      {/*
         Faint orbital rings.

         Barely visible, and absent from every earlier version — which is why those read as
         flat. They give the star somewhere to be.
      */}
      <g fill="none" stroke="#8f7bd8" strokeOpacity="0.09">
        <circle cx={STAR.x + 40} cy={STAR.y} r={STAR_RY * 1.19} />
        <circle cx={STAR.x + 40} cy={STAR.y} r={STAR_RY * 0.91} strokeOpacity="0.06" />
      </g>

      <g fill="none" strokeLinecap="round" filter="url(#sf-ribbon)" opacity="0.5">
        {RIBBONS.map((r, i) => (
          <path key={`r${i}`} d={r.d} stroke={r.stroke} strokeWidth="30" strokeOpacity="0.2" />
        ))}
      </g>

      <g fill="none" strokeLinecap="round">
        {STRANDS.map((s, i) => (
          <path key={i} d={s.d} stroke={s.stroke} strokeWidth={s.width} strokeOpacity={s.opacity} />
        ))}
      </g>

      {/* Nodes, placed ON their curve — filled and hollow, as the reference has them. */}
      <g>
        {STRANDS.flatMap((s, i) =>
          s.nodes.map((n, j) => {
            const p = pointAt(s.d, n.t);
            const colour = n.warm ? '#f0532f' : '#5f45d6';
            return n.hollow ? (
              <circle
                key={`n${i}-${j}`}
                cx={p.x}
                cy={p.y}
                r={n.r + 1.2}
                fill="none"
                stroke={colour}
                strokeWidth="1.5"
                strokeOpacity="0.7"
              />
            ) : (
              <circle key={`n${i}-${j}`} cx={p.x} cy={p.y} r={n.r} fill={colour} fillOpacity="0.8" />
            );
          }),
        )}
      </g>

      {/*
         The star: bloom, soft body, crisp body, then the light at the centre.

         One shape trying to be all of those is either soft or hard, never lit.
      */}
      <g filter="url(#sf-bloom)" opacity="0.55">
        <path d={sparkle(STAR.x, STAR.y, STAR_RX * 1.08, STAR_RY * 1.06)} fill="url(#sf-star)" />
      </g>
      <g filter="url(#sf-soft)" opacity="0.9">
        <path d={STAR_PATH} fill="url(#sf-star)" />
      </g>
      <g filter="url(#sf-crisp)">
        <path d={STAR_PATH} fill="url(#sf-star)" />
      </g>

      {/* The flare through the core. */}
      <g filter="url(#sf-streak)">
        <rect x={STAR.x - 380} y={STAR.y - 1.8} width="760" height="3.6" fill="url(#sf-streak-h)" />
        <rect x={STAR.x - 2} y={STAR.y - 230} width="4" height="460" fill="url(#sf-streak-v)" />
      </g>

      {/* The core itself. */}
      <ellipse cx={STAR.x} cy={STAR.y} rx={STAR_RX * 0.3} ry={STAR_RX * 0.3} fill="url(#sf-core)" opacity="0.8" />
      <path
        d={sparkle(STAR.x, STAR.y, STAR_RX * 0.2, STAR_RY * 0.17, 0.1, 0.34)}
        fill="#ffffff"
        fillOpacity="0.97"
      />
    </svg>
  );
}
