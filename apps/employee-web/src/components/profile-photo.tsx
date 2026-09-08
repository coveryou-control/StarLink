'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { AVATAR_CONTENT_TYPES, MAX_AVATAR_BYTES } from '@starlink/shared-contracts';

/**
 * Your profile picture, and the four things you can do to it.
 *
 * ## Why this exists beside `AvatarPicker` rather than replacing it
 *
 * `AvatarPicker` is still what a GROUP picture uses, and it is the right control there: a
 * group photo is set rarely, by whoever happens to be organising, and a centred cover-crop
 * of the file they picked is what they wanted. Your own face is not that. People re-take
 * it, they care where it sits in the circle, and they want to look at the one they have
 * before deciding to replace it — so this adds a menu, a crop and a viewer, and leaves the
 * simpler control where it was rather than making groups pay for a crop nobody asked for.
 *
 * ## The canvas round trip is still the security boundary
 *
 * Everything `avatar-picker.tsx` says about re-encoding holds here and for the same
 * reasons — the bytes that leave this machine are pixels the browser decoded and wrote
 * back out, so an SVG's script never runs, a polyglot's trailing payload is discarded, and
 * the EXIF GPS tag on a phone photograph does not get published as somebody's avatar. The
 * crop does not weaken that: it changes which source rectangle is drawn, not whether the
 * drawing happens.
 *
 * The server re-checks size, content type and the bytes' own signature regardless
 * (`avatar.controller.ts`, `looksLikeImage`). This is the good path; that is the boundary.
 */

/** The stored square. Every avatar on screen is a 30–96px circle, so 256 covers 2×. */
const OUTPUT = 256;

/** The crop square the person actually drags in, in CSS pixels. */
const VIEWPORT = 264;

/**
 * The largest file worth decoding.
 *
 * Not a storage limit — what gets stored is always a 256² PNG of about 40KB, whatever came
 * in. It is a limit on what this will pull into memory and hand to the decoder, because a
 * 60-megapixel photograph will hang the tab before it ever reaches the canvas. Five
 * megabytes comfortably covers anything a phone or a camera produces as a JPEG.
 */
const MAX_SOURCE_BYTES = 5_242_880;

const ACCEPT = AVATAR_CONTENT_TYPES.join(',');

type Stage =
  | { readonly kind: 'closed' }
  | { readonly kind: 'menu' }
  | { readonly kind: 'view' }
  | { readonly kind: 'upload' }
  | { readonly kind: 'crop'; readonly image: ImageBitmap | HTMLImageElement };

export function ProfilePhoto({
  initials,
  photoUrl,
  displayName,
  subtitle,
  onSave,
  onRemove,
}: {
  readonly initials: string;
  /** The current picture, or `undefined` when there is none and initials are shown. */
  readonly photoUrl: string | undefined;
  readonly displayName: string;
  /**
   * The line under the name — which directory the record came from.
   *
   * Passed in rather than written here because INTEGRATION_CONTRACTS §1 rule 4 requires an
   * interim identity source to be unmistakable for a canonical one, and the caller is what
   * knows the authority. A photo control that quietly dropped that marker while
   * rearranging the tile around it would remove a required disclosure by accident.
   */
  readonly subtitle: string;
  /** Re-encoded PNG bytes, base64, ready for the body. */
  readonly onSave: (base64: string) => Promise<void>;
  readonly onRemove: () => Promise<void>;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'closed' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setStage({ kind: 'closed' }), []);

  /* The confirmation is a sentence that stops being true, so it clears itself rather than
     sitting under the avatar until the next navigation. */
  useEffect(() => {
    if (done === undefined) return;
    const timer = setTimeout(() => setDone(undefined), 4000);
    return () => clearTimeout(timer);
  }, [done]);

  /* Escape and an outside click both dismiss the MENU. The dialogs handle their own, since
     a click inside a dialog must not fall through to this. */
  useEffect(() => {
    if (stage.kind !== 'menu') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
        buttonRef.current?.focus();
      }
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (buttonRef.current?.contains(target) === true) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [stage.kind, close]);

  const accept = async (file: File): Promise<void> => {
    setProblem(undefined);
    if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setProblem('That has to be a JPG, PNG or WEBP.');
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setProblem('That file is larger than 5MB. Try a smaller one.');
      return;
    }
    try {
      const image = await loadImage(file);
      setStage({ kind: 'crop', image });
    } catch {
      setProblem('That file could not be read as an image.');
    }
  };

  const save = async (base64: string): Promise<void> => {
    setProblem(undefined);
    setBusy(true);
    try {
      /* Checked before the request as well as on the server: at 256² a PNG is ~40KB, so
         exceeding this means something went wrong rather than that the picture was large,
         and saying so before the upload is better than after. */
      if (base64.length * 0.75 > MAX_AVATAR_BYTES) {
        setProblem('That image is too detailed to store. Try a simpler one.');
        return;
      }
      await onSave(base64);
      close();
      setDone('Profile photo updated.');
    } catch {
      setProblem('That picture could not be saved. Nothing has changed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setProblem(undefined);
    setBusy(true);
    try {
      await onRemove();
      close();
      setDone('Profile photo removed. Your initials are shown again.');
    } catch {
      setProblem('That picture could not be removed. Nothing has changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-photo">
      <div className="profile-photo-figure">
        {/*
          The avatar IS the control.

          A separate "edit" button beside it would be easier to build and would leave the
          picture itself inert, which is not how anybody expects a profile photo to behave.
          The camera badge is the affordance; the whole circle is the hit area.
        */}
        <button
          ref={buttonRef}
          type="button"
          className="profile-photo-button"
          aria-haspopup="menu"
          aria-expanded={stage.kind === 'menu'}
          aria-label={
            photoUrl === undefined ? 'Add a profile photo' : 'Change or remove your profile photo'
          }
          onClick={() => setStage(stage.kind === 'menu' ? { kind: 'closed' } : { kind: 'menu' })}
        >
          <span className="row-avatar" aria-hidden="true">
            {initials}
            {photoUrl !== undefined ? (
              <img className="avatar-photo" src={photoUrl} alt="" crossOrigin="use-credentials" />
            ) : null}
          </span>
          <span className="profile-photo-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="13" height="13" focusable="false">
              <path
                d="M4 8h3l1.5-2h7L17 8h3v11H4z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
        </button>

        {stage.kind === 'menu' ? (
          <div className="profile-photo-menu" role="menu" ref={menuRef} aria-label="Profile photo">
            {/* Offered only when there is something to look at. A "View photo" that opens an
                empty frame is a menu item that lies. */}
            {photoUrl !== undefined ? (
              <button type="button" role="menuitem" onClick={() => setStage({ kind: 'view' })}>
                <PhotoIcon />
                View photo
              </button>
            ) : null}
            <button type="button" role="menuitem" onClick={() => setStage({ kind: 'upload' })}>
              <PencilIcon />
              {photoUrl === undefined ? 'Add photo' : 'Change photo'}
            </button>
            {photoUrl !== undefined ? (
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                <BinIcon />
                Remove photo
              </button>
            ) : null}
          </div>
        ) : null}

        <span className="settings-identity-text">
          <strong>{displayName}</strong>
          <span className="muted">{subtitle}</span>
        </span>
      </div>

      <p className="settings-note">
        Stored as a 256px square. Location data and anything else hidden in the file is
        discarded when it is resized.
      </p>

      {problem !== undefined ? (
        <p className="settings-note" role="alert">
          {problem}
        </p>
      ) : null}
      {done !== undefined ? (
        <p className="profile-photo-done" role="status">
          <CheckIcon />
          {done}
        </p>
      ) : null}

      {stage.kind === 'view' && photoUrl !== undefined ? (
        <ViewDialog url={photoUrl} displayName={displayName} onClose={close} />
      ) : null}

      {stage.kind === 'upload' ? (
        <UploadDialog problem={problem} onChoose={(file) => void accept(file)} onCancel={close} />
      ) : null}

      {stage.kind === 'crop' ? (
        <CropDialog
          image={stage.image}
          busy={busy}
          onCancel={() => setStage({ kind: 'upload' })}
          onSave={(base64) => void save(base64)}
        />
      ) : null}
    </div>
  );
}

/** The picture at the size it is stored, for somebody deciding whether to replace it. */
function ViewDialog({
  url,
  displayName,
  onClose,
}: {
  readonly url: string;
  readonly displayName: string;
  readonly onClose: () => void;
}): ReactNode {
  useEscape(onClose);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="photo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Profile photo"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="photo-dialog-head">
          <h2>Profile photo</h2>
          <CloseButton onClick={onClose} />
        </header>
        <img
          className="photo-dialog-full"
          src={url}
          alt={`Profile photo of ${displayName}`}
          crossOrigin="use-credentials"
        />
      </section>
    </div>,
    document.body,
  );
}

/** Drag a file onto it, or click it. Nothing is uploaded from here — the crop comes next. */
function UploadDialog({
  problem,
  onChoose,
  onCancel,
}: {
  readonly problem: string | undefined;
  readonly onChoose: (file: File) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  useEscape(onCancel);

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        className="photo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Update profile photo"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="photo-dialog-head">
          <h2>Update profile photo</h2>
          <CloseButton onClick={onCancel} />
        </header>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose a profile photo"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) onChoose(file);
            /* Cleared so choosing the SAME file again fires a change event — without it,
               picking a file, cancelling the crop and picking it again does nothing. */
            event.target.value = '';
          }}
        />

        {/*
          A button, not a div with a click handler.

          The drop zone has to be reachable from the keyboard, and the cheapest way to get
          Enter, Space, focus and a role that says "activatable" is to use the element that
          already has them.
        */}
        <button
          type="button"
          className={`photo-drop${over ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            const file = event.dataTransfer.files[0];
            if (file !== undefined) onChoose(file);
          }}
        >
          <span className="photo-drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
              <path
                d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <strong>Drag and drop a photo here</strong>
          <span className="muted">or click to browse</span>
          <span className="photo-drop-limits">JPG, PNG or WEBP. Max size 5MB.</span>
        </button>

        {problem !== undefined ? (
          <p className="settings-note" role="alert">
            {problem}
          </p>
        ) : null}

        <footer className="photo-dialog-foot">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/**
 * Choosing WHICH square.
 *
 * ## Why the preview is a canvas rather than a positioned `<img>`
 *
 * A CSS-transformed image under a mask is less code, and it is a different renderer from
 * the one that produces the saved file — so the two agree only as long as nobody changes
 * the maths on one side. Drawing the preview with the same `drawImage` call that writes
 * the output makes the preview a rehearsal of the save rather than an illustration of it:
 * what is inside the circle is exactly what gets stored, by construction.
 */
function CropDialog({
  image,
  busy,
  onCancel,
  onSave,
}: {
  readonly image: ImageBitmap | HTMLImageElement;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (base64: string) => void;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number } | undefined>();
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);
  useEscape(onCancel);

  const iw = image.width;
  const ih = image.height;
  /* "Cover": at zoom 1 the shorter side exactly fills the square, so there is never a gap
     inside the crop however it is dragged. */
  const baseScale = Math.max(VIEWPORT / iw, VIEWPORT / ih);
  const scale = baseScale * zoom;
  const dw = iw * scale;
  const dh = ih * scale;

  /* The image must always cover the viewport, so the offset is bounded rather than free.
     Applied on every read and not only on drag, because raising the zoom and lowering it
     again can leave a previously legal offset out of range. */
  const clamp = useCallback(
    (o: { x: number; y: number }) => ({
      x: Math.min(0, Math.max(VIEWPORT - dw, o.x)),
      y: Math.min(0, Math.max(VIEWPORT - dh, o.y)),
    }),
    [dw, dh],
  );

  /*
     Zooming keeps the centre of the crop where it was.

     Anchoring at the top-left instead — which is what leaving the offset alone does — makes
     the picture appear to slide out from under the circle as the slider moves, and the
     person chases it back. `undefined` is the first render, where there is nothing to
     preserve and the answer is simply centred.
  */
  const at = offset === undefined ? { x: (VIEWPORT - dw) / 2, y: (VIEWPORT - dh) / 2 } : clamp(offset);

  const rescale = (next: number): void => {
    const nextScale = baseScale * next;
    const focusX = (VIEWPORT / 2 - at.x) / scale;
    const focusY = (VIEWPORT / 2 - at.y) / scale;
    setZoom(next);
    setOffset({ x: VIEWPORT / 2 - focusX * nextScale, y: VIEWPORT / 2 - focusY * nextScale });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio, 3);
    canvas.width = VIEWPORT * dpr;
    canvas.height = VIEWPORT * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);

    ctx.drawImage(image, at.x, at.y, dw, dh);

    /* Everything outside the circle is dimmed rather than hidden, so the person can see
       what they are cutting off while they drag — which is the whole reason to crop by
       hand instead of accepting the centre. */
    const radius = VIEWPORT / 2 - 2;
    ctx.fillStyle = 'rgb(23 22 31 / 55%)';
    ctx.beginPath();
    ctx.rect(0, 0, VIEWPORT, VIEWPORT);
    ctx.arc(VIEWPORT / 2, VIEWPORT / 2, radius, 0, Math.PI * 2);
    ctx.fill('evenodd');

    ctx.strokeStyle = 'rgb(255 255 255 / 85%)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(VIEWPORT / 2, VIEWPORT / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
  }, [image, at.x, at.y, dw, dh]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: at.x, oy: at.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const from = drag.current;
    if (from === undefined) return;
    setOffset(
      clamp({ x: from.ox + (event.clientX - from.x), y: from.oy + (event.clientY - from.y) }),
    );
  };
  const endDrag = (): void => {
    drag.current = undefined;
  };

  /* Arrow keys move the crop, so this is not a mouse-only control. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    const step = event.shiftKey ? 20 : 4;
    const by: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const move = by[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setOffset(clamp({ x: at.x + move.x, y: at.y + move.y }));
  };

  const save = (): void => {
    const out = document.createElement('canvas');
    out.width = OUTPUT;
    out.height = OUTPUT;
    const ctx = out.getContext('2d');
    if (ctx === null) return;
    ctx.imageSmoothingQuality = 'high';
    /* The viewport square, mapped back into source pixels. The same rectangle the preview
       drew, so what was framed is what is written. */
    ctx.drawImage(
      image,
      -at.x / scale,
      -at.y / scale,
      VIEWPORT / scale,
      VIEWPORT / scale,
      0,
      0,
      OUTPUT,
      OUTPUT,
    );

    /* PNG rather than JPEG: an avatar is often a logo or flat colour rather than a
       photograph, and JPEG's ringing around hard edges is very visible at 30px. */
    const dataUrl = out.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return;
    onSave(dataUrl.slice(comma + 1));
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        className="photo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Crop your photo"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="photo-dialog-head">
          <h2>Crop your photo</h2>
          <CloseButton onClick={onCancel} />
        </header>

        <canvas
          ref={canvasRef}
          className="photo-crop"
          style={{ width: VIEWPORT, height: VIEWPORT }}
          tabIndex={0}
          role="img"
          aria-label="Drag to reposition your photo, or use the arrow keys"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />

        <div className="photo-zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => rescale(Math.max(1, Math.round((zoom - 0.1) * 100) / 100))}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M6 12h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            aria-label="Zoom"
            onChange={(event) => rescale(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => rescale(Math.min(3, Math.round((zoom + 0.1) * 100) / 100))}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M6 12h12M12 6v12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <footer className="photo-dialog-foot">
          <button type="button" className="confirm-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);
}

function CloseButton({ onClick }: { readonly onClick: () => void }): ReactNode {
  return (
    <button type="button" className="photo-dialog-close" onClick={onClick} aria-label="Close">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
        <path
          d="M6 6l12 12M18 6L6 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

const PhotoIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
    <path d="M4 17l5-4 4 3 3-2 4 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const PencilIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <path
      d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);

const BinIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <path
      d="M5 7h14M10 7V5h4v2M6.5 7l1 12h9l1-12M10 11v5M14 11v5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CheckIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M8 12.5l2.6 2.5L16 9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * File → decoded image, without ever putting the file's own bytes on the page.
 *
 * `createImageBitmap` where it exists, which decodes off the main thread and needs no
 * object URL; an `<img>` and a blob URL where it does not, which is Safari before 17.
 */
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
