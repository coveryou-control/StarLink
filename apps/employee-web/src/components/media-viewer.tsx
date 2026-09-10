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
 *
 * ## It shows the CONVERSATION's media, not one file
 *
 * The first version took a single file, because that is what the bubble that opened it
 * knew about. Opening a photograph then showed exactly that photograph: no next, no
 * previous, and no sign the thread held eleven more. `MediaGalleryProvider` assembles the
 * ordered list where the messages are, and this pages through it — arrow keys, the
 * chevrons, or the strip along the bottom.
 *
 * ## Who sent it, and when
 *
 * The bar led with the filename, which is the least useful fact about a photograph:
 * `Screenshot (7).png` says nothing, and the thing a person actually wants when they open
 * an image out of context is whose it is and when it arrived. The name moves to a title
 * attribute, where it is available and not in the way.
 *
 * ## Grants
 *
 * §28.4 audits every grant. This never issues one for a file it is not showing: the
 * current item asks when it becomes current, and a thumbnail asks when it scrolls into the
 * strip. Both are true statements at the moment they are made. The bubble's own grant is
 * reused rather than duplicated — see `media-gallery.tsx`.
 *
 * ## Download stays
 *
 * A person who wants the file on their machine still can, and that control is now an
 * explicit choice rather than the unavoidable consequence of clicking. It navigates, which
 * is exactly the case the `attachment` disposition is for.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { formatBytes } from './attachment-picker';
import { AvatarImage } from './avatar-image';
import { initialsFor } from './conversation-naming';
import { identityStyleFrom, distinctIdentityHues } from '../lib/identity-colour';
import type { GalleryItem } from './media-gallery';

/** When the picture was sent, in the form a person reads rather than an ISO string. */
function sentLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today at ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} at ${time}`;
}

export function MediaViewer({
  items,
  index,
  onIndex,
  urlFor,
  request,
  onClose,
}: {
  readonly items: readonly GalleryItem[];
  readonly index: number;
  readonly onIndex: (next: number) => void;
  readonly urlFor: (attachmentId: string) => string | undefined;
  readonly request: (attachmentId: string) => Promise<string | undefined>;
  readonly onClose: () => void;
}): ReactNode {
  const current = items[index];
  const url = current === undefined ? undefined : urlFor(current.attachmentId);
  const stripRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (delta: number): void => {
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      onIndex(next);
    },
    [index, items.length, onIndex],
  );

  /* The current item's grant, asked for when it becomes current and not before. */
  useEffect(() => {
    if (current === undefined) return;
    if (urlFor(current.attachmentId) !== undefined) return;
    void request(current.attachmentId);
  }, [current, urlFor, request]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      /*
         Arrows page, unless the caret is in something. A video's own controls take the
         arrows for seeking once it has focus, and stealing them back would make the
         player unusable inside the viewer.
      */
      const target = event.target as HTMLElement | null;
      if (target !== null && /INPUT|TEXTAREA|VIDEO/.test(target.tagName)) return;
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
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
  }, [onClose, go]);

  /* The strip follows the selection, so paging past the visible end does not lose it. */
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const active = strip.querySelector('[aria-current="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [index]);

  if (current === undefined) return null;

  const hues = distinctIdentityHues(
    items.map((item) => item.senderPrincipalId ?? '').filter((id) => id !== ''),
  );

  return createPortal(
    <div
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`${current.filename} — ${current.senderDisplayName}`}
      onClick={onClose}
    >
      <header className="media-viewer-bar" onClick={(event) => event.stopPropagation()}>
        {/*
          Whose it is and when, not what it is called.

          A filename is the least useful thing about a photograph — `Screenshot (7).png`
          identifies nothing — and it is the first thing this bar used to say. The person
          and the moment are what somebody needs when they are looking at an image away
          from the message it arrived in. The name is still here, on the title, for the
          times it matters.
        */}
        <span
          className="media-viewer-who"
          title={`${current.filename} · ${formatBytes(current.declaredBytes)}`}
        >
          {/*
             Initials underneath, the photograph over them.

             `AvatarImage` renders NOTHING when the person has no picture, so it is a layer
             rather than a choice - the same arrangement the message row, the list row and
             the chat header all use. The circle clips it; see `.media-viewer-avatar`.
          */}
          <span
            className="media-viewer-avatar"
            style={identityStyleFrom(hues, current.senderPrincipalId)}
            aria-hidden="true"
          >
            {initialsFor(current.senderDisplayName)}
            <AvatarImage principalId={current.senderPrincipalId} alt="" />
          </span>
          <span className="media-viewer-who-text">
            <strong>{current.mine ? 'You' : current.senderDisplayName}</strong>
            <span>{sentLabel(current.sentAt)}</span>
          </span>
        </span>

        {/* Position, when there is more than one. It is the only thing that says the
            conversation has more media than the one you opened. */}
        {items.length > 1 ? (
          <span className="media-viewer-count">
            {index + 1} of {items.length}
          </span>
        ) : null}

        {/*
          Download is a LINK, not a button calling `window.open`.

          It navigates, which is the one case `Content-Disposition: attachment` exists for,
          and `download` asks the browser to keep the real filename rather than the object
          id in the URL. The grant is single-use in principle; if it has been spent the
          browser reports a plain failure, which is the honest outcome and better than this
          component pre-emptively issuing a second audited grant nobody asked for.
        */}
        {url !== undefined ? (
          <a
            className="media-viewer-action"
            href={url}
            download={current.filename}
            aria-label="Download"
            title="Download"
            onClick={(event) => event.stopPropagation()}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
              <path
                d="M12 4v11m0 0 4.2-4.2M12 15l-4.2-4.2M4.5 18.5h15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        ) : null}
        <button
          type="button"
          className="media-viewer-action media-viewer-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
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
        {index > 0 ? (
          <button
            type="button"
            className="media-viewer-step is-back"
            onClick={() => go(-1)}
            aria-label="Previous"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}

        {url === undefined ? (
          /* The grant is in flight. Not a spinner in an empty frame — the strip and the
             bar are already correct, so the only thing missing is the picture. */
          <p className="media-viewer-waiting">Opening…</p>
        ) : current.kind === 'image' ? (
          <img src={url} alt={current.filename} />
        ) : (
          /* `autoPlay` on a video the person just clicked: they clicked a video. Muted is
             not set, because they clicked it deliberately and a silent play would look
             broken — the browser may refuse the autoplay, and controls are right there.
             Keyed on the id so paging from one clip to the next reloads the element
             rather than leaving the previous frame under the new source. */
          <video key={current.attachmentId} src={url} controls autoPlay playsInline />
        )}

        {index < items.length - 1 ? (
          <button
            type="button"
            className="media-viewer-step is-next"
            onClick={() => go(1)}
            aria-label="Next"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* One thread, one strip. Below two items it says nothing the chevrons do not. */}
      {items.length > 1 ? (
        <div
          className="media-viewer-strip"
          ref={stripRef}
          onClick={(event) => event.stopPropagation()}
          role="tablist"
          aria-label="Media in this conversation"
        >
          {items.map((item, at) => (
            <Thumb
              key={item.attachmentId}
              item={item}
              active={at === index}
              url={urlFor(item.attachmentId)}
              request={request}
              onPick={() => onIndex(at)}
            />
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * One frame in the strip, which asks for its grant only once it is on screen.
 *
 * Eleven thumbnails eagerly fetched would write eleven "this was shown to them" entries
 * for a person who opened one picture. An observer is the difference between an audit
 * ledger that records what happened and one that records what was rendered off-screen.
 */
function Thumb({
  item,
  active,
  url,
  request,
  onPick,
}: {
  readonly item: GalleryItem;
  readonly active: boolean;
  readonly url: string | undefined;
  readonly request: (attachmentId: string) => Promise<string | undefined>;
  readonly onPick: () => void;
}): ReactNode {
  const holder = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = holder.current;
    if (element === null || url !== undefined) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void request(item.attachmentId);
      },
      { root: element.parentElement, rootMargin: '128px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.attachmentId, url, request]);

  return (
    <button
      type="button"
      ref={holder}
      className={`media-viewer-thumb${active ? ' is-active' : ''}`}
      aria-current={active}
      aria-label={`${item.kind === 'video' ? 'Video' : 'Picture'} from ${item.mine ? 'you' : item.senderDisplayName}`}
      onClick={onPick}
    >
      {url === undefined ? (
        <span className="media-viewer-thumb-blank" aria-hidden="true" />
      ) : item.kind === 'image' ? (
        <img src={url} alt="" />
      ) : (
        /* A video frame, not a player: `preload="metadata"` is enough to paint the poster
           and does not pull the whole clip for a thumbnail. */
        <video src={url} preload="metadata" muted playsInline />
      )}
      {item.kind === 'video' ? (
        <span className="media-viewer-thumb-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path d="M8.5 6.2 17 12l-8.5 5.8V6.2Z" fill="currentColor" />
          </svg>
        </span>
      ) : null}
    </button>
  );
}
