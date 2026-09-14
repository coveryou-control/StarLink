'use client';

/**
 * Cropping, turning and colouring a picture, between choosing it and sending it.
 *
 * ## Why this is a step rather than a mode
 *
 * The preview panel answers "is this the right picture". This answers "is this the right
 * part of it", which is a different question and only sometimes asked — a photograph of a
 * damaged bumper usually goes as it is, and a photograph of one page of a four-page form
 * usually does not. So the editor opens from the preview, on request, and returns to it.
 *
 * ## The upload is already in flight, and is thrown away
 *
 * `attach()` starts uploading the moment a file is chosen, which is what makes the ordinary
 * case fast. Editing invalidates those bytes, so applying an edit removes the staged
 * original and uploads the result — the discarded upload is the price of not making
 * everybody who does NOT edit wait for a decision they were never going to make.
 *
 * ## The pointer handling is deliberately plain
 *
 * Pointer events, captured on the element being dragged, with the geometry in
 * `image-edit.ts` where it can be tested without a DOM. No drag library: the whole
 * interaction is one rectangle with five grab targets, and the part that is actually easy
 * to get wrong is the coordinate conversion, which is not what a library would be doing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyAspect,
  clampCrop,
  filterById,
  renderEdited,
  ASPECTS,
  FILTERS,
  WHOLE,
  type CropRect,
  type Rotation,
} from '../lib/image-edit';

/** Which part of the rectangle a drag is moving. */
type Grab = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface Drag {
  readonly grab: Grab;
  /** Where the pointer went down, in fractions. */
  readonly fromX: number;
  readonly fromY: number;
  /** The rectangle as it was when the drag began. */
  readonly start: CropRect;
}

export function ImageEditor({
  url,
  filename,
  type,
  onApply,
  onCancel,
}: {
  readonly url: string;
  readonly filename: string;
  readonly type: string;
  /** The edited picture. The caller replaces the staged upload with it. */
  readonly onApply: (file: File) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<CropRect>(WHOLE);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [filter, setFilter] = useState('none');
  const [aspect, setAspect] = useState('free');
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /**
   * The picture's own proportions, once the browser has decoded it.
   *
   * Needed before any aspect preset can mean anything — see `applyAspect`. Until it
   * arrives the presets are disabled rather than wrong, because a square computed against
   * an assumed 1:1 would be silently oblong.
   */
  const [imageAspect, setImageAspect] = useState<number | undefined>(undefined);

  /* Escape leaves the editor, not the whole panel: the person is one level in and expects
     to come back out, not to lose the picture. Mid-apply it does nothing, for the same
     reason the preview's own Escape does. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  /**
   * Pointer position as a fraction of the displayed picture.
   *
   * Measured against the IMAGE's rectangle rather than the frame's: the image is letterboxed
   * inside the frame by `object-fit: contain`, so a fraction of the frame is a fraction of
   * the wrong box and the crop drifts by however much letterboxing there is — worse on a
   * panorama, invisible on a square, which is exactly the kind of bug that ships.
   */
  const fractionAt = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const image = imageRef.current;
    if (image === null) return { x: 0, y: 0 };
    const box = image.getBoundingClientRect();
    return {
      x: box.width === 0 ? 0 : (clientX - box.left) / box.width,
      y: box.height === 0 ? 0 : (clientY - box.top) / box.height,
    };
  }, []);

  const onPointerDown = (grab: Grab) => (event: React.PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    const at = fractionAt(event.clientX, event.clientY);
    setDrag({ grab, fromX: at.x, fromY: at.y, start: crop });
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    if (drag === undefined) return;
    const at = fractionAt(event.clientX, event.clientY);
    const dx = at.x - drag.fromX;
    const dy = at.y - drag.fromY;
    const s = drag.start;

    if (drag.grab === 'move') {
      setCrop(clampCrop({ ...s, x: s.x + dx, y: s.y + dy }));
      return;
    }

    /* Each corner moves two edges. Written out rather than derived from the letters,
       because the derived version reads as cleverness and this reads as the four cases it
       actually is. */
    const next =
      drag.grab === 'nw'
        ? { x: s.x + dx, y: s.y + dy, width: s.width - dx, height: s.height - dy }
        : drag.grab === 'ne'
          ? { x: s.x, y: s.y + dy, width: s.width + dx, height: s.height - dy }
          : drag.grab === 'sw'
            ? { x: s.x + dx, y: s.y, width: s.width - dx, height: s.height + dy }
            : { x: s.x, y: s.y, width: s.width + dx, height: s.height + dy };

    const chosen = ASPECTS.find((option) => option.id === aspect)?.value;
    /* A locked aspect is re-applied after the drag rather than constraining it, so the
       rectangle follows the pointer and then snaps to shape. Constraining during the drag
       makes the corner lag behind the cursor, which reads as the control being broken. */
    setCrop(
      chosen === undefined || imageAspect === undefined
        ? clampCrop(next)
        : applyAspect(clampCrop(next), chosen, imageAspect),
    );
  };

  const endDrag = (): void => setDrag(undefined);

  const chooseAspect = (id: string): void => {
    setAspect(id);
    const value = ASPECTS.find((option) => option.id === id)?.value;
    if (value !== undefined && imageAspect !== undefined) {
      setCrop(applyAspect(crop, value, imageAspect));
    }
  };

  const turn = (): void => {
    setRotation(((rotation + 90) % 360) as Rotation);
  };

  const reset = (): void => {
    setCrop(WHOLE);
    setRotation(0);
    setFilter('none');
    setAspect('free');
  };

  const apply = async (): Promise<void> => {
    const image = imageRef.current;
    if (image === null) return;
    setBusy(true);
    setProblem(undefined);
    try {
      onApply(
        await renderEdited(image, {
          crop,
          rotation,
          filter: filterById(filter),
          filename,
          type,
        }),
      );
    } catch {
      /* The original is still staged and still sendable, which is what this says. An editor
         that fails silently leaves somebody pressing a button that does nothing. */
      setProblem('The edit could not be applied. The picture can still be sent as it is.');
      setBusy(false);
    }
  };

  const edited = crop.width < 1 || crop.height < 1 || rotation !== 0 || filter !== 'none';

  return (
    <div className="image-editor">
      <header className="image-editor-head">
        <button type="button" onClick={onCancel} disabled={busy} className="image-editor-back">
          Back
        </button>
        <strong>Edit picture</strong>
        <button
          type="button"
          onClick={reset}
          disabled={busy || !edited}
          className="image-editor-reset"
        >
          Reset
        </button>
      </header>

      {/*
        The crop surface.

        The picture is drawn once, at its own proportions, and the rectangle is an overlay
        on top of it. The area OUTSIDE the rectangle is dimmed by four panels rather than by
        a single element with a hole in it: `clip-path` would do it in one, and would also
        capture the pointer over the hole, which is where the dragging happens.
      */}
      <div
        className="image-editor-frame"
        ref={frameRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img
          ref={imageRef}
          src={url}
          alt={filename}
          draggable={false}
          style={{
            filter: filterById(filter).css,
            transform: `rotate(${rotation}deg)`,
          }}
          onLoad={(event) => {
            const element = event.currentTarget;
            setImageAspect(
              element.naturalHeight === 0 ? 1 : element.naturalWidth / element.naturalHeight,
            );
          }}
        />

        <div
          className="image-editor-crop"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.width * 100}%`,
            height: `${crop.height * 100}%`,
          }}
          onPointerDown={onPointerDown('move')}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              className={`image-editor-handle is-${corner}`}
              onPointerDown={onPointerDown(corner)}
            />
          ))}
        </div>
      </div>

      <div className="image-editor-tools">
        <div className="image-editor-row" role="group" aria-label="Crop shape">
          {ASPECTS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`image-editor-chip${aspect === option.id ? ' is-on' : ''}`}
              aria-pressed={aspect === option.id}
              disabled={busy || (option.value !== undefined && imageAspect === undefined)}
              onClick={() => chooseAspect(option.id)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className="image-editor-chip"
            onClick={turn}
            disabled={busy}
            aria-label="Rotate a quarter turn"
            title="Rotate"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path
                d="M20 11a8 8 0 1 1-2.4-5.7M20 4v4h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="image-editor-row" role="group" aria-label="Filter">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`image-editor-chip${filter === option.id ? ' is-on' : ''}`}
              aria-pressed={filter === option.id}
              disabled={busy}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {problem !== undefined ? (
        <p className="image-editor-problem" role="alert">
          {problem}
        </p>
      ) : null}

      <footer className="image-editor-foot">
        <button type="button" onClick={onCancel} disabled={busy} className="image-editor-cancel">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy}
          className="image-editor-apply"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </footer>
    </div>
  );
}
