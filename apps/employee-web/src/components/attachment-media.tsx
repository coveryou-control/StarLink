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

  useEffect(() => {
    const element = holder.current;
    if (element === null || url !== undefined) return;

    let live = true;
    const fetchGrant = async (): Promise<void> => {
      try {
        const grant = await api.downloadAttachment(file.attachmentId);
        if (live) setUrl(grant.url);
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
  }, [file.attachmentId, url]);

  if (problem !== undefined) {
    return (
      <div className="attachment-media attachment-media-problem" role="alert">
        {problem}
      </div>
    );
  }

  return (
    <div className="attachment-media" ref={holder} data-kind={kind}>
      {url === undefined ? (
        /* A box of the right shape while the grant is in flight, so the thread does not
           jump when the picture lands. */
        <div className="attachment-media-pending" aria-label={`Loading ${file.filename}`} />
      ) : kind === 'image' ? (
        /*
           A click opens the full size in a new tab — the same act the file card performs,
           and the grant is already in hand so it costs no second audit entry.
        */
        <a href={url} target="_blank" rel="noopener noreferrer" title={file.filename}>
          <img src={url} alt={file.filename} loading="lazy" />
        </a>
      ) : (
        /* `preload="metadata"` so the poster frame and duration are there without pulling
           the whole file down for a video nobody plays. */
        <video src={url} controls preload="metadata" playsInline title={file.filename} />
      )}
    </div>
  );
}
