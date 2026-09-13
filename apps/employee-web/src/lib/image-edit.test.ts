import { describe, expect, it } from 'vitest';

import {
  applyAspect,
  clampCrop,
  exportSize,
  filterById,
  renamed,
  FILTERS,
  WHOLE,
} from './image-edit';

/**
 * The maths a crop tool gets wrong quietly.
 *
 * A cropping bug does not throw. It produces a plausible picture of the wrong part of the
 * photograph, or a square that is not square, and the person sending it has already looked
 * at the preview and pressed send. So the cases here are the ones where a wrong answer still
 * looks like an answer.
 */
describe('a rectangle stays inside the picture', () => {
  it('leaves a valid rectangle alone', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
    expect(clampCrop(rect)).toEqual(rect);
  });

  it('pushes a rectangle back when it runs off an edge', () => {
    expect(clampCrop({ x: 0.8, y: 0.9, width: 0.5, height: 0.4 })).toEqual({
      x: 0.5,
      y: 0.6,
      width: 0.5,
      height: 0.4,
    });
  });

  it('refuses a negative origin', () => {
    expect(clampCrop({ x: -0.3, y: -0.1, width: 0.4, height: 0.4 })).toEqual({
      x: 0,
      y: 0,
      width: 0.4,
      height: 0.4,
    });
  });

  it('shrinks before it moves, so an oversized rectangle has somewhere to go', () => {
    // A rectangle wider than the image has no position that fits; clamping position first
    // would leave it overhanging.
    const result = clampCrop({ x: 0.4, y: 0.4, width: 2, height: 3 });
    expect(result).toEqual(WHOLE);
  });

  it('keeps a rectangle usable rather than letting it collapse', () => {
    const result = clampCrop({ x: 0.5, y: 0.5, width: 0, height: -1 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('never produces a rectangle that leaves the picture', () => {
    for (const rect of [
      { x: 0.9, y: 0.9, width: 0.9, height: 0.9 },
      { x: -1, y: 0.5, width: 0.3, height: 1.4 },
      { x: 0.33, y: 0, width: 0.7, height: 0.2 },
    ]) {
      const result = clampCrop(rect);
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.x + result.width).toBeLessThanOrEqual(1.0000001);
      expect(result.y + result.height).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe('an aspect preset produces that shape ON SCREEN', () => {
  it('makes a square crop of a landscape photograph', () => {
    /**
     * The bug this exists for. A 2:1 photograph cropped to `width === height` in fractional
     * coordinates is a rectangle twice as wide as it is tall in pixels — square on the
     * maths, oblong in the message. The image's own proportions are what convert between
     * the two.
     */
    const imageAspect = 2; // 1000 x 500
    const crop = applyAspect(WHOLE, 1, imageAspect);
    const pixels = exportSize({ width: 1000, height: 500 }, crop, 0);
    expect(pixels.width).toBe(pixels.height);
  });

  it('makes a square crop of a portrait photograph', () => {
    const imageAspect = 0.5; // 500 x 1000
    const crop = applyAspect(WHOLE, 1, imageAspect);
    const pixels = exportSize({ width: 500, height: 1000 }, crop, 0);
    expect(pixels.width).toBe(pixels.height);
  });

  it('makes 16:9 of a square photograph', () => {
    const crop = applyAspect(WHOLE, 16 / 9, 1);
    const pixels = exportSize({ width: 800, height: 800 }, crop, 0);
    expect(pixels.width / pixels.height).toBeCloseTo(16 / 9, 2);
  });

  it('keeps the centre, so pressing a preset reshapes rather than jumps', () => {
    const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const result = applyAspect(start, 1, 1);
    expect(result.x + result.width / 2).toBeCloseTo(0.4, 5);
    expect(result.y + result.height / 2).toBeCloseTo(0.4, 5);
  });

  it('stays inside the picture even when the shape does not fit where it was', () => {
    const cornered = { x: 0.85, y: 0.85, width: 0.15, height: 0.15 };
    const result = applyAspect(cornered, 16 / 9, 1);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(1.0000001);
    expect(result.y + result.height).toBeLessThanOrEqual(1.0000001);
  });
});

describe('the exported size', () => {
  it('is the cropped part of the ORIGINAL, not of whatever was on screen', () => {
    // The whole reason crops are fractions. A half-width crop of a 4000px photograph is
    // 2000px, regardless of the panel having drawn it 500px wide.
    expect(exportSize({ width: 4000, height: 3000 }, { x: 0, y: 0, width: 0.5, height: 0.5 }, 0)).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it('swaps the sides on a quarter turn', () => {
    expect(exportSize({ width: 1000, height: 500 }, WHOLE, 90)).toEqual({
      width: 500,
      height: 1000,
    });
    expect(exportSize({ width: 1000, height: 500 }, WHOLE, 270)).toEqual({
      width: 500,
      height: 1000,
    });
  });

  it('does not swap the sides on a half turn', () => {
    expect(exportSize({ width: 1000, height: 500 }, WHOLE, 180)).toEqual({
      width: 1000,
      height: 500,
    });
  });

  it('never produces a zero-sized canvas', () => {
    // `canvas.width = 0` throws on export, and a tiny crop of a small image rounds to zero.
    const result = exportSize({ width: 10, height: 10 }, { x: 0, y: 0, width: 0.01, height: 0.01 }, 0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });
});

describe('the file that comes back', () => {
  it('renames to match the bytes, because §28.2 sniffs them', () => {
    /**
     * An iPhone photograph is HEIC, the canvas cannot encode HEIC, so the export is JPEG.
     * Leaving the name as `.heic` would be refused at the boundary for a type mismatch —
     * correctly, and with a message that would be baffling to somebody who had just
     * cropped a picture.
     */
    expect(renamed('IMG_4821.heic', 'image/jpeg')).toBe('IMG_4821.jpg');
    expect(renamed('screenshot.png', 'image/png')).toBe('screenshot.png');
    expect(renamed('photo.JPEG', 'image/jpeg')).toBe('photo.jpg');
  });

  it('gives a name with no extension one', () => {
    expect(renamed('scan', 'image/jpeg')).toBe('scan.jpg');
  });

  it('keeps a dotted stem intact', () => {
    expect(renamed('claim.2026.09.13.heic', 'image/jpeg')).toBe('claim.2026.09.13.jpg');
  });
});

describe('the filters', () => {
  it('offers Original first, so the default is no change', () => {
    expect(FILTERS[0]?.id).toBe('none');
    expect(FILTERS[0]?.css).toBe('none');
  });

  it('falls back to Original for an id nobody has', () => {
    // A remembered choice from a build with a different list must not produce `undefined`
    // as a CSS filter value.
    expect(filterById('invented').id).toBe('none');
  });

  it('gives every filter a distinct id and a label', () => {
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(FILTERS.length);
    for (const filter of FILTERS) expect(filter.label.length).toBeGreaterThan(0);
  });
});
