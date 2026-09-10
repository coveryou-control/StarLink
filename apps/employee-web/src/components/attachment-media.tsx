'use client';


/**
 * An attachment that is a picture or a video, shown in the thread.
 *
 * ## Why the grant is fetched lazily, and only once seen
 *
 * §28.4 issues a short-lived, single-object download grant after the full authorization
 * ladder, and the issuance is AUDITED. `AttachmentLink` therefore deliberately waits for a
 * click: a rendered `href` would be a grant nobody asked for and an audit entry for a file
 * nobody opened.
 *
 * A picture cannot wait for a click — it has to be fetched to be seen at all. So the rule
 * is kept honestly rather than abandoned: the grant is requested when the element actually
 * scrolls into view, so an audit entry means "this was shown to them", which is true. A
 * thread of fifty images that nobody scrolls to issues no grants.
 *
 * ## Why the decision is made on the SNIFFED type
 *
 * `contentType` is what the scanner read out of the bytes. Deciding from the uploader's
 * declared type — or worse, from the filename — would let a caller choose how their file is
 * interpreted in every recipient's browser. A file named `.png` that is not one renders as
 * a file card, which is the safe answer.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type AttachmentView } from '../lib/api-client';
import { useGallery } from './media-gallery';
import { localMediaFor } from '../lib/local-media';

/** What may be drawn rather than listed. Narrow on purpose — anything else is a file. */
export function mediaKindOf(file: AttachmentView): 'image' | 'video' | undefined {
  /* Only BOUND is downloadable (§28.1). An unscanned attachment has no trustworthy type
     yet, so it stays a card until it does. */
  if (file.state !== 'BOUND') return undefined;
  const type = file.contentType;
  if (type === undefined) return undefined;
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(type)) return 'video';
  /* SVG is deliberately absent. It is a document that can carry script, and rendering one
     inline from a colleague is the one image format that is an execution decision. */
  return undefined;
}

export function AttachmentMedia({
  file,
  kind,
}: {
  readonly file: AttachmentView;
  readonly kind: 'image' | 'video';
}): ReactNode {
  const [url, setUrl] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const holder = useRef<HTMLDivElement>(null);
  /**
   * The thread's gallery, when there is one.
   *
   * Pressing a picture opens the conversation's media at this file rather than opening
   * this file alone — see `media-gallery.tsx`. It is `undefined` outside a thread (the
   * forward dialog, message info), and there the thumbnail is simply not a button, which
   * is honest: there is nothing to page through in those places.
   */
  const gallery = useGallery();

  /*
     Your own file, drawn from the copy this browser still holds.

     No grant, no round trip and no audit entry for being shown a picture you sent thirty
     seconds ago. Absent for everything else — including your own files after a reload,
     which is right: by then the attachment is a real BOUND object with a sniffed type and
     the ordinary path is the correct one.
  */
  const local = localMediaFor(file.attachmentId);

  useEffect(() => {
    if (local !== undefined) return;
    const element = holder.current;
    if (element === null || url !== undefined) return;

    let live = true;
    const fetchGrant = async (): Promise<void> => {
      try {
        /* Through the gallery when there is one: it de-duplicates, so a picture the viewer
           has already opened does not spend a second audited grant to draw its thumbnail,
           and vice versa. `request` returns the cached URL when it holds one. */
        const granted =
          gallery !== undefined
            ? await gallery.request(file.attachmentId)
            : (await api.downloadAttachment(file.attachmentId)).url;
        /* The gallery swallows the cause and answers `undefined`, so the shape of the
           refusal is lost by the time it gets here. 403 is the honest stand-in: it lands
           on the "not available to you" branch below, which is what an absent grant means
           to the person looking at the picture. */
        if (granted === undefined) throw new ApiError(403, 'no_grant', 'no download grant');
        if (live) setUrl(granted);
      } catch (cause) {
        /* §34.4: an explicit "temporarily unavailable", never a broken image — a person
           reads a broken image as "the file is gone". */
        if (live) {
          setProblem(
            cause instanceof ApiError && cause.status === 503
              ? 'Storage is temporarily unavailable. The file is safe — try again shortly.'
              : 'That file is not available to you.',
          );
        }
      }
    };

    /* Without `IntersectionObserver` the honest fallback is to fetch it — the alternative
       is a picture that never appears — and the audit entry is then slightly eager rather
       than wrong. */
    if (typeof IntersectionObserver !== 'function') {
      void fetchGrant();
      return;
    }

    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          watcher.disconnect();
          void fetchGrant();
        }
      },
      /* A little early, so the picture is there by the time it is scrolled to rather than
         appearing under the reader's eye. */
      { rootMargin: '200px' },
    );
    watcher.observe(element);
    return () => {
      live = false;
      watcher.disconnect();
    };
  }, [file.attachmentId, url, gallery, local]);

  if (problem !== undefined) {
    return (
      <div className="attachment-media attachment-media-problem" role="alert">
        {problem}
      </div>
    );
  }

  /* The local copy wins where there is one; otherwise the granted URL. */
  const shown = local ?? url;

  return (
    <div className="attachment-media" ref={holder} data-kind={kind}>
      {shown === undefined ? (
        /* A box of the right shape while the grant is in flight, so the thread does not
           jump when the picture lands. */
        <div className="attachment-media-pending" aria-label={`Loading ${file.filename}`} />
      ) : kind === 'image' ? (
        /*
           A click opens the picture IN THE APPLICATION, not in a new tab.

           The tab was the bug. Navigating to the grant URL hands the browser bytes served
           as `application/octet-stream` with `Content-Disposition: attachment` — see
           `dev-upload.controller.ts` for why that header is deliberate and must stay — so
           the browser saved the photograph instead of showing it. A disposition only
           governs navigation; the `<img>` right here renders the same bytes without
           complaint, which is what `MediaViewer` uses.

           A button rather than an anchor, because it no longer goes anywhere. It opens the
           thread's whole gallery AT this picture, so next and previous work — outside a
           thread there is no gallery and the button is inert rather than opening a viewer
           with one item and two dead chevrons.
        */
        <button
          type="button"
          className="attachment-media-open"
          onClick={() => gallery?.open(file.attachmentId)}
          disabled={gallery === undefined}
          title={file.filename}
          aria-label={`Open ${file.filename}`}
        >
          <img src={shown} alt={file.filename} loading="lazy" />
        </button>
      ) : (
        /* `preload="metadata"` so the poster frame and duration are there without pulling
           the whole file down for a video nobody plays.

           The inline player keeps its controls — a video in a thread is often watched where
           it sits. `Expand` is for the other case, and opens the same viewer a picture uses
           rather than navigating, for the same reason. */
        <>
          <video src={shown} controls preload="metadata" playsInline title={file.filename} />
          {gallery !== undefined ? (
            <button
              type="button"
              className="attachment-media-expand"
              onClick={() => gallery.open(file.attachmentId)}
            >
              Expand
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
