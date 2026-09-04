'use client';

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AVATAR_CONTENT_TYPES, MAX_AVATAR_BYTES } from '@starlink/shared-contracts';

/**
 * Choosing a picture, and re-encoding it before it leaves the machine.
 *
 * ## The canvas round trip is the point
 *
 * This does not upload the file somebody chose. It decodes it into an `<img>`, draws it
 * into a canvas at 256×256, and reads the canvas back out as PNG. What arrives at the
 * server is therefore PIXELS, re-serialised by the browser — and the things that make a
 * user-supplied image dangerous are not pixels:
 *
 *   - an SVG's `<script>` never runs, because an SVG drawn into a canvas is rasterised;
 *   - a polyglot's trailing payload is discarded, because only the decoded image is read;
 *   - EXIF is dropped, which matters because phone photographs carry GPS coordinates and
 *     an avatar is the last place somebody expects to publish their home address.
 *
 * That is why the server needs no virus scanner for this route, and it is a stronger
 * property than scanning would give: a scanner looks for known-bad, and this discards
 * everything that is not the one thing wanted.
 *
 * The server does not take it on trust. It re-checks the size, the content type, and the
 * bytes' own signature — see `avatar.controller.ts`. This is the good path; that is the
 * boundary.
 *
 * ## Why 256 square
 *
 * Every place an avatar appears is a circle of 30 to 96 pixels, so 256 covers a 2× display
 * at the largest of them with room to spare. Cropping to a square here rather than with
 * CSS means the thing stored is the thing shown — an oblong squeezed by `object-fit` looks
 * different in a list from how it looked in the picker, which reads as the upload having
 * gone wrong.
 */
const SIDE = 256;

/** The file types worth offering. The server accepts three; this asks for those three. */
const ACCEPT = AVATAR_CONTENT_TYPES.join(',');

export function AvatarPicker({
  label,
  hasPicture,
  onChosen,
  onRemove,
}: {
  readonly label: string;
  readonly hasPicture: boolean;
  /** Called with re-encoded PNG bytes, base64, ready for the body. */
  readonly onChosen: (base64: string) => Promise<void>;
  readonly onRemove?: (() => Promise<void>) | undefined;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const handle = async (file: File): Promise<void> => {
    setProblem(undefined);
    setBusy(true);
    try {
      const base64 = await reencode(file);
      /* Checked here as well as on the server: at 256² a PNG is ~40 KB, so exceeding this
         means something went wrong rather than that the picture was large — and saying so
         before the upload is better than after. */
      if (base64.length * 0.75 > MAX_AVATAR_BYTES) {
        setProblem('That image is too detailed to store. Try a simpler one.');
        return;
      }
      await onChosen(base64);
    } catch {
      setProblem('That file could not be read as an image.');
    } finally {
      setBusy(false);
      /* Cleared so choosing the SAME file again fires a change event. Without this,
         picking a file, removing the picture and picking it again does nothing. */
      if (inputRef.current !== null) inputRef.current.value = '';
    }
  };

  return (
    <div className="avatar-picker">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void handle(file);
        }}
      />

      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Working…' : hasPicture ? 'Change picture' : 'Upload a picture'}
      </button>

      {hasPicture && onRemove !== undefined ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setProblem(undefined);
            setBusy(true);
            void onRemove().finally(() => setBusy(false));
          }}
        >
          Remove
        </button>
      ) : null}

      <p className="settings-note">
        Stored as a 256px square. Location data and anything else hidden in the file is
        discarded when it is resized.
      </p>

      {problem !== undefined ? (
        <p className="settings-note" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * File → square PNG → base64, entirely in the browser.
 *
 * `createImageBitmap` where it exists, which decodes off the main thread and does not need
 * an object URL; an `<img>` and a blob URL where it does not, which is Safari before 17.
 * Both paths end at the same canvas.
 *
 * The crop is centred and covers: the shorter side fills the square and the longer one is
 * trimmed equally at both ends. That is what somebody expects from "use this as my
 * picture" — a face centred in a landscape photograph stays centred.
 */
async function reencode(file: File): Promise<string> {
  const bitmap = await loadImage(file);

  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');

  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, SIDE, SIDE);

  /* PNG rather than JPEG: an avatar is often a logo or a flat-colour initial rather than a
     photograph, and JPEG's ringing around hard edges is very visible at 30px. The size
     difference at 256² is tens of kilobytes either way. */
  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('unreadable canvas output');
  return dataUrl.slice(comma + 1);
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('not an image'));
      image.src = url;
    });
  } finally {
    /* Revoked whichever way it ended. An object URL kept alive holds the whole file in
       memory for the life of the document. */
    URL.revokeObjectURL(url);
  }
}
