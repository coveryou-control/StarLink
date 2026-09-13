import type { ReactNode } from 'react';

/**
 * The StarLink mark and wordmark, as the design draws them.
 *
 * ## What this replaced
 *
 * A four-pointed star inside an orbit, beside `STARLINK` set at a quarter-em of tracking —
 * a recreation of an earlier logo supplied as an image. The imported design uses neither.
 * Every screen in it marks the product with a rounded near-black tile carrying a single
 * orange `S`, and names it `Starlink` in sentence case at the interface's own weight.
 *
 * That is a simpler mark and a deliberate one: at 30px in a rail, a star-and-orbit reads as
 * a smudge, where a letter in a tile reads as a letter in a tile. The old figure is gone
 * rather than kept alongside — two marks for one product is how a brand stops being one.
 *
 * ## Why it is not an image
 *
 * A tile and a letter need no asset, scale to any size from one definition, and re-colour
 * themselves for the dark theme. Everything here is type and a border radius.
 */

export function BrandMark({
  size = 40,
  round = false,
}: {
  readonly size?: number;
  /**
   * A disc rather than the squircle.
   *
   * One caller: the sign-in page, whose whole palette is borrowed from a reference that
   * draws a circular mark. A prop rather than a CSS override because the size and the
   * radius are set INLINE here — proportional radius is the reason — and an inline style
   * beats a class, so a stylesheet trying to round this off silently does nothing. That
   * is exactly what happened first: the tile took the new colour and kept its old shape.
   */
  readonly round?: boolean;
}): ReactNode {
  return (
    <span
      className="brand-mark"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // The kit's radius scale is absolute, so a tile at 30px would carry the same 12px
        // corner as one at 40px and read as a squircle. Proportional keeps the shape.
        borderRadius: round ? '50%' : Math.round(size * 0.3),
        fontSize: Math.round(size * 0.48),
      }}
    >
      S
    </span>
  );
}

/** The name, at the size the design sets it. */
export function BrandWordmark(): ReactNode {
  return <span className="brand-wordmark">Starlink</span>;
}

/** Mark and name together — the sign-in card and the panel masthead both use this. */
export function BrandLockup({ size = 40 }: { readonly size?: number }): ReactNode {
  return (
    <span className="brand-lockup" role="img" aria-label="Starlink">
      <BrandMark size={size} />
      <BrandWordmark />
    </span>
  );
}
