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

/**
 * Fired by whatever just changed a picture, to pull the poll forward.
 *
 * Two minutes is the right cadence for discovering that a COLLEAGUE changed theirs, and far
 * too slow for the person who just pressed Save: they set a photo, and their own face in
 * the rail stayed as initials for up to two minutes. The page that made the change knows
 * the moment it lands, so it says so, and the one poll everybody already shares runs again.
 *
 * A window event rather than shared state because the emitter and the listener are on
 * opposite sides of the tree with no common owner below the shell — and this carries no
 * data, so there is nothing for the two to disagree about. It is a nudge; the answer still
 * comes from the server.
 */
export const AVATAR_CHANGED_EVENT = 'starlink:avatar-changed';

/** Call after an avatar is set or removed, so every avatar on screen re-reads at once. */
export function announceAvatarChange(): void {
  window.dispatchEvent(new Event(AVATAR_CHANGED_EVENT));
}

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
    window.addEventListener(AVATAR_CHANGED_EVENT, poll);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(AVATAR_CHANGED_EVENT, poll);
    };
  }, [key]);

  return stamps;
}
