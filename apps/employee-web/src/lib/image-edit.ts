'use client';

/**
 * Cropping, straightening and colour, before a picture is sent.
 *
 * ## Why the crop is stored as fractions
 *
 * A crop rectangle in pixels is a rectangle of WHICH pixels — the ones on screen, at the
 * size the panel happened to draw the image, on this window at this zoom. Export it against
 * the file's real dimensions and it lands somewhere else entirely, and it does so silently:
 * the result is a plausible picture of the wrong part of the photograph.
 *
 * So every rectangle here is in fractions of the image, 0 to 1. The editor multiplies by the
 * displayed size to draw it and the exporter multiplies by the natural size to cut it, and
 * neither has to know what the other is working in.
 *
 * ## Why the filters are CSS strings
 *
 * The same string drives the live preview (`style.filter`) and the export
 * (`CanvasRenderingContext2D.filter`). One value, so what somebody approved on screen is
 * what leaves the browser — a preview drawn by one pipeline and an export by another is a
 * feature that works until a filter is added and then quietly stops matching.
 *
 * ## Rotation is quarter turns only
 *
 * Straightening by a degree or two needs a slider, a bigger canvas to avoid clipping the
 * corners, and a decision about what fills them. A photograph taken sideways needs one
 * button pressed once or twice. This does the second thing and does not pretend to do the
 * first.
 */

/** A rectangle in fractions of the image: 0,0 is the top-left corner, 1,1 the bottom-right. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The whole picture — the crop everything starts from and "Reset" returns to. */
export const WHOLE: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** Quarter turns clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Filter {
  readonly id: string;
  readonly label: string;
  /** A CSS filter value, used unchanged for the preview AND the export. */
  readonly css: string;
}

/**
 * Six, and no more.
 *
 * A long strip of filters is a toy; these are the adjustments that make a photograph of a
 * document or a damaged bumper more legible to the person receiving it, which is what
 * pictures are for in a claims conversation. "Document" is the one that earns its place
 * most often — a phone photograph of a printed form is usually grey and low contrast, and
 * this is the difference between a colleague reading it and asking for it again.
 */
export const FILTERS: readonly Filter[] = Object.freeze([
  { id: 'none', label: 'Original', css: 'none' },
  { id: 'document', label: 'Document', css: 'grayscale(1) contrast(1.45) brightness(1.08)' },
  { id: 'bright', label: 'Bright', css: 'brightness(1.16) saturate(1.05)' },
  { id: 'punch', label: 'Punch', css: 'contrast(1.22) saturate(1.28)' },
  { id: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(-12deg) brightness(1.03)' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1)' },
]);

export const filterById = (id: string): Filter =>
  FILTERS.find((filter) => filter.id === id) ?? FILTERS[0]!;

/** The smallest crop the editor will produce, as a fraction. Below this the handles overlap. */
const MIN_SIDE = 0.05;

/**
 * Forces a rectangle back inside the picture.
 *
 * Every drag goes through this rather than each handler clamping its own edges, because
 * "the rectangle stays inside the image" is one rule and six handlers implementing it
 * separately is five chances to get it wrong at one corner.
 *
 * Size is clamped before position: a rectangle wider than the image has no position that
 * fits, and shrinking it first gives the second step something solvable.
 */
export function clampCrop(rect: CropRect): CropRect {
  const width = Math.min(1, Math.max(MIN_SIDE, rect.width));
  const height = Math.min(1, Math.max(MIN_SIDE, rect.height));
  const x = Math.min(1 - width, Math.max(0, rect.x));
  const y = Math.min(1 - height, Math.max(0, rect.y));
  return { x, y, width, height };
}

/**
 * Reshapes a crop to an aspect ratio, keeping its centre.
 *
 * `aspect` is width ÷ height of the FINISHED picture, so it is compared against the image's
 * own proportions rather than used directly — a square crop of a landscape photograph is
 * not a square in fractional coordinates, and treating it as one produces a crop that is
 * square on the maths and oblong on the screen. `imageAspect` is what converts between the
 * two, and forgetting it is the classic version of this bug.
 *
 * Keeping the centre rather than the top-left is what makes pressing "Square" feel like a
 * reshaping rather than a jump.
 */
export function applyAspect(rect: CropRect, aspect: number, imageAspect: number): CropRect {
  /* The target ratio expressed in fractional space: how wide the rectangle must be for
     every unit of its height. */
  const ratio = aspect / imageAspect;

  /* Grow along the axis with room and shrink the other, whichever keeps more of the
     picture — starting from the larger side means the result is never smaller than it
     needs to be. */
  let width = rect.width;
  let height = width / ratio;
  if (height > 1) {
    height = 1;
    width = height * ratio;
  }
  if (width > 1) {
    width = 1;
    height = width / ratio;
  }

  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  return clampCrop({ x: centreX - width / 2, y: centreY - height / 2, width, height });
}

/** The aspect presets the editor offers. `undefined` is a free-form drag. */
export const ASPECTS: readonly { readonly id: string; readonly label: string; readonly value?: number }[] =
  Object.freeze([
    { id: 'free', label: 'Free' },
    { id: 'square', label: '1:1', value: 1 },
    { id: 'portrait', label: '4:5', value: 4 / 5 },
    { id: 'wide', label: '16:9', value: 16 / 9 },
  ]);

/**
 * The pixel rectangle a fractional crop names, after rotation.
 *
 * Separated from the drawing so it can be checked without a canvas. The rotation is applied
 * to the OUTPUT dimensions — a quarter turn swaps width and height — while the source
 * rectangle is read in the image's own orientation, which is the part that is easy to get
 * backwards.
 */
export function exportSize(
  natural: { readonly width: number; readonly height: number },
  crop: CropRect,
  rotation: Rotation,
): { readonly width: number; readonly height: number } {
  const width = Math.max(1, Math.round(natural.width * crop.width));
  const height = Math.max(1, Math.round(natural.height * crop.height));
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * What a JPEG is re-encoded at.
 *
 * High enough that a re-encode is not visible on a photograph of a document, low enough
 * that the cropped result is smaller than the original rather than larger — which is the
 * surprising failure of naive canvas export, and it is surprising twice over because the
 * picture is now smaller on screen.
 */
const JPEG_QUALITY = 0.92;

/**
 * The edited picture, as a file ready to upload.
 *
 * ## PNG stays PNG, everything else becomes JPEG
 *
 * A screenshot re-encoded as JPEG gets visible artefacts around text, which is the one kind
 * of picture where that is obvious and the one people paste most often. Everything else —
 * photographs from phones — is a JPEG already and re-encoding as PNG would multiply its
 * size several times over for no gain.
 *
 * HEIC deserves a mention because it is what an iPhone produces: the canvas cannot encode
 * it, so those become JPEG, which is a conversion rather than a re-encode and is the
 * reason the returned file carries a name with the right extension on it. A file called
 * `.heic` containing JPEG bytes would be refused by §28.2's sniff check, which compares the
 * declared type against the real one — so the name has to follow the bytes.
 */
export async function renderEdited(
  source: HTMLImageElement,
  options: {
    readonly crop: CropRect;
    readonly rotation: Rotation;
    readonly filter: Filter;
    readonly filename: string;
    readonly type: string;
  },
): Promise<File> {
  const natural = { width: source.naturalWidth, height: source.naturalHeight };
  const { width, height } = exportSize(natural, options.crop, options.rotation);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser would not provide a canvas.');

  /* The same CSS string the preview used. A browser that does not support `filter` on a
     context leaves it as the empty string, and the export is then the unfiltered crop —
     a picture that is not quite what was approved, rather than no picture at all. */
  context.filter = options.filter.css;

  /* Rotation is done to the CANVAS, not to the pixels: translate to the middle of the
     output, turn, and draw the source rectangle centred on the origin. Rotating the source
     rectangle instead means four sets of coordinates and four chances to transpose two of
     them. */
  context.translate(width / 2, height / 2);
  context.rotate((options.rotation * Math.PI) / 180);

  /* Back to the un-rotated size for the draw, because a quarter turn swapped them. */
  const drawn =
    options.rotation === 90 || options.rotation === 270
      ? { width: height, height: width }
      : { width, height };

  context.drawImage(
    source,
    options.crop.x * natural.width,
    options.crop.y * natural.height,
    options.crop.width * natural.width,
    options.crop.height * natural.height,
    -drawn.width / 2,
    -drawn.height / 2,
    drawn.width,
    drawn.height,
  );

  const encodeAs = options.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, encodeAs, encodeAs === 'image/jpeg' ? JPEG_QUALITY : undefined);
  });
  if (blob === null) throw new Error('The edited picture could not be encoded.');

  return new File([blob], renamed(options.filename, encodeAs), { type: encodeAs });
}

/**
 * The filename, with an extension that matches the bytes.
 *
 * §28.2 compares the declared type against the sniffed one and rejects a disagreement, so a
 * file still called `.heic` after being encoded as JPEG would be refused at the boundary —
 * correctly, and with a message about the type not matching that would be baffling to
 * somebody who had just cropped a photograph.
 */
export function renamed(filename: string, type: string): string {
  const extension = type === 'image/png' ? 'png' : 'jpg';
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.${extension}`;
}
