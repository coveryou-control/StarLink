'use client';

/**
 * Which of the people on screen have a picture, and when each last changed.
 *
 * Stamps rather than images. The list draws thirty avatars and the only thing it needs to
 * decide is whether to point an `<img>` at the bytes or draw initials — fetching the
 * pictures to answer that would move megabytes to render text.
 *
 * The stamp doubles as the cache key: it goes on the URL as `?v=`, which makes a changed
 * picture a different URL and lets the response be cached for a year. One string solves
 * both "has one" and "is it the one I already have".
 *
 * Polled slowly, for the same reason presence is: a picture changes a few times a year.
 * The interval exists so somebody who uploads one sees it appear elsewhere in the product
 * without a reload, not because the data is volatile.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api-client';

const POLL_MS = 120_000;
const MAX_IDS = 50;

export function useAvatarStamps(principalIds: readonly string[]): ReadonlyMap<string, string> {
  const [stamps, setStamps] = useState<ReadonlyMap<string, string>>(new Map());

  const key = useMemo(() => [...principalIds].sort().slice(0, MAX_IDS).join(','), [principalIds]);
  const idsRef = useRef(key);
  idsRef.current = key;

  useEffect(() => {
    let live = true;

    const poll = (): void => {
      const ids = idsRef.current;
      if (ids === '') {
        setStamps(new Map());
        return;
      }
      void api
        .avatarStamps(ids.split(','))
        .then((result) => {
          if (!live) return;
          setStamps(new Map(result.avatars.map((entry) => [entry.id, entry.updatedAt])));
        })
        .catch(() => {
          /* Keep what we had. A face that reverts to initials because one poll timed out
             looks like the picture was deleted. */
        });
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key]);

  return stamps;
}
