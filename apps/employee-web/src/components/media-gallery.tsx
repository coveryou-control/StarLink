'use client';

/**
 * Every picture and video in one thread, as one thing you can page through.
 *
 * ## Why this exists rather than a viewer per bubble
 *
 * Each `AttachmentMedia` used to own a `MediaViewer` of its own, so opening a photograph
 * showed exactly that photograph and nothing else — no next, no previous, no sense that
 * the conversation contained eleven more. Every messenger lets you walk the media of a
 * chat once you are inside one of them, and you cannot build that from a component that
 * knows about one file.
 *
 * The list is assembled where the messages are (`MessageList`), which is the only place
 * that knows their ORDER — the viewer must page in conversation order, not in the order
 * the bubbles happened to fetch their grants.
 *
 * ## Grants, and the ledger
 *
 * §28.4 audits every download grant, and the audit entry is read as "this file was shown
 * to this person". Two rules follow, and they are the whole design of the cache below:
 *
 *   1. **A grant is fetched once.** The bubble in the thread and the full-size view are
 *      the same file being looked at once, so they share one entry. The bubble publishes
 *      its URL here as soon as it has one; the viewer reuses it.
 *   2. **A grant is fetched only when the file is actually shown.** Opening the viewer
 *      does NOT pre-fetch the whole conversation's media so the filmstrip can be complete
 *      — that would write an entry saying somebody looked at eleven files when they looked
 *      at one. A thumbnail asks when it scrolls into the strip, which is the same rule the
 *      thread already follows, and it is true at the moment it asks.
 *
 * The cache is per-mount, so it dies with the thread. Grants are short-lived (§28.4) and
 * a cache that outlived the conversation would hand out expired URLs.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError } from '../lib/api-client';
import { MediaViewer } from './media-viewer';

export interface GalleryItem {
  readonly attachmentId: string;
  readonly kind: 'image' | 'video';
  readonly filename: string;
  readonly declaredBytes: number;
  readonly senderDisplayName: string;
  readonly senderPrincipalId: string | undefined;
  readonly sentAt: string;
  readonly mine: boolean;
}

interface Gallery {
  /** Opens the full-size view at this attachment. */
  readonly open: (attachmentId: string) => void;
  /** Hands a grant the thread already holds to the cache, so it is not fetched twice. */
  readonly publish: (attachmentId: string, url: string) => void;
  /** A URL if one is already held, `undefined` otherwise. Never fetches. */
  readonly urlFor: (attachmentId: string) => string | undefined;
  /** Fetches a grant, once, for a file about to be shown. */
  readonly request: (attachmentId: string) => Promise<string | undefined>;
}

const GalleryContext = createContext<Gallery | undefined>(undefined);

/**
 * `undefined` outside a provider, and that is deliberate rather than a thrown error.
 *
 * `AttachmentMedia` also renders in the forward dialog and in message info, where there is
 * no thread and no gallery to page through. Those get the single-file behaviour by falling
 * back, rather than every one of them needing a provider wrapped around it.
 */
export function useGallery(): Gallery | undefined {
  return useContext(GalleryContext);
}

export function MediaGalleryProvider({
  items,
  children,
}: {
  readonly items: readonly GalleryItem[];
  readonly children: ReactNode;
}): ReactNode {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  /**
   * The grants, and a `useState` beside the ref because both are needed.
   *
   * The ref is what `request` reads to decide whether to fetch — it must see writes from
   * the same tick, which state does not. The state is what makes a thumbnail re-render
   * when its URL lands. Keeping only one of the two gives either duplicate grants or a
   * strip that never fills in.
   */
  const cache = useRef(new Map<string, string>());
  const [, setVersion] = useState(0);
  /** In-flight requests, so two thumbnails asking at once make one audited grant. */
  const pending = useRef(new Map<string, Promise<string | undefined>>());

  const publish = useCallback((attachmentId: string, url: string): void => {
    if (cache.current.get(attachmentId) === url) return;
    cache.current.set(attachmentId, url);
    setVersion((n) => n + 1);
  }, []);

  const urlFor = useCallback((attachmentId: string): string | undefined => {
    return cache.current.get(attachmentId);
  }, []);

  const request = useCallback(async (attachmentId: string): Promise<string | undefined> => {
    const held = cache.current.get(attachmentId);
    if (held !== undefined) return held;
    const inFlight = pending.current.get(attachmentId);
    if (inFlight !== undefined) return inFlight;

    const task = (async (): Promise<string | undefined> => {
      try {
        const grant = await api.downloadAttachment(attachmentId);
        cache.current.set(attachmentId, grant.url);
        setVersion((n) => n + 1);
        return grant.url;
      } catch (cause) {
        /* A refusal is not a retryable state and must not be cached as one either: the
           file may become viewable again (a scan finishing, a participation restored),
           and a permanent `undefined` here would outlast the reason. */
        if (cause instanceof ApiError && cause.isUnauthenticated) return undefined;
        return undefined;
      } finally {
        pending.current.delete(attachmentId);
      }
    })();
    pending.current.set(attachmentId, task);
    return task;
  }, []);

  const value = useMemo<Gallery>(
    () => ({ open: setOpenId, publish, urlFor, request }),
    [publish, urlFor, request],
  );

  const index = items.findIndex((item) => item.attachmentId === openId);

  return (
    <GalleryContext.Provider value={value}>
      {children}
      {openId !== undefined && index >= 0 ? (
        <MediaViewer
          items={items}
          index={index}
          onIndex={(next) => {
            const item = items[next];
            if (item !== undefined) setOpenId(item.attachmentId);
          }}
          urlFor={urlFor}
          request={request}
          onClose={() => setOpenId(undefined)}
        />
      ) : null}
    </GalleryContext.Provider>
  );
}
