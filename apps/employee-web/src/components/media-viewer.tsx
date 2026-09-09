'use client';

/**
 * A picture or a video, full size, without leaving the conversation.
 *
 * ## What this replaces, and why the old behaviour was inevitable
 *
 * Clicking an image opened `grant.url` in a new tab — and the bytes came back as
 * `application/octet-stream` with `Content-Disposition: attachment`, so the browser saved
 * the file instead of showing it. That header is not a mistake: `dev-upload.controller.ts`
 * sets it deliberately, because a dev endpoint that rendered a colleague-supplied HTML file
 * inline **on the API's own origin** would be a stored XSS in the one place a session cookie
 * lives. Relaxing it to make photographs viewable would buy the feature with that.
 *
 * A disposition header only governs NAVIGATION. `<img src>` and `<video src>` were already
 * rendering the same bytes perfectly well inside the thread — the thumbnail in every bubble
 * is proof. So the fix is not to change what the server sends; it is to stop navigating.
 * This shows the picture in the application, at the size of the window, using the grant the
 * bubble already holds.
 *
 * ## The grant is not re-issued
 *
 * §28.4 AUDITS every download grant. The viewer is handed the URL the bubble already
 * fetched, so opening a photograph and closing it again leaves one entry in the ledger
 * rather than two — and the entry says what actually happened, which is that somebody looked
 * at the file once.
 *
 * ## Download stays
 *
 * A person who wants the file on their machine still can, and that control is now an
 * explicit choice rather than the unavoidable consequence of clicking. It navigates, which
 * is exactly the case the `attachment` disposition is for.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { formatBytes } from './attachment-picker';

export interface ViewableMedia {
  readonly kind: 'image' | 'video';
  /** The already-granted object URL. Never re-fetched here — see the note above. */
  readonly url: string;
  readonly filename: string;
  readonly declaredBytes: number;
}

export function MediaViewer({
  media,
  onClose,
}: {
  readonly media: ViewableMedia;
  readonly onClose: () => void;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    /*
       The page behind must not scroll while this is up. A wheel over a full-screen image
       otherwise moves the thread underneath it, and closing the viewer leaves the reader
       somewhere they did not go.
    */
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={media.filename}
      onClick={onClose}
    >
      <header className="media-viewer-bar" onClick={(event) => event.stopPropagation()}>
        <span className="media-viewer-name" title={media.filename}>
          {media.filename}
        </span>
        <span className="media-viewer-size">{formatBytes(media.declaredBytes)}</span>
        {/*
          Download is a LINK, not a button calling `window.open`.

          It navigates, which is the one case `Content-Disposition: attachment` exists for,
          and `download` asks the browser to keep the real filename rather than the object
          id in the URL. The grant is single-use in principle; if it has been spent the
          browser reports a plain failure, which is the honest outcome and better than this
          component pre-emptively issuing a second audited grant nobody asked for.
        */}
        <a
          className="media-viewer-action"
          href={media.url}
          download={media.filename}
          onClick={(event) => event.stopPropagation()}
        >
          Download
        </a>
        <button
          type="button"
          className="media-viewer-action media-viewer-close"
          onClick={onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              d="m6.5 6.5 11 11m0-11-11 11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {/*
        The media itself stops the click, so pressing the picture does not close the viewer
        the way pressing the space around it does. Every gallery behaves this way and people
        rely on it without being able to say so.
      */}
      <div className="media-viewer-stage" onClick={(event) => event.stopPropagation()}>
        {media.kind === 'image' ? (
          <img src={media.url} alt={media.filename} />
        ) : (
          /* `autoPlay` on a video the person just clicked: they clicked a video. Muted is
             not set, because they clicked it deliberately and a silent play would look
             broken — the browser may refuse the autoplay, and controls are right there. */
          <video src={media.url} controls autoPlay playsInline />
        )}
      </div>
    </div>,
    document.body,
  );
}
