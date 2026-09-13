'use client';

/**
 * What the colleagues on screen say they are doing.
 *
 * ## Deliberately separate from presence
 *
 * `use-presence.ts` answers one question — does this person hold a realtime lease — and
 * §21.9 forbids reading anything more into it. This answers a different one: what did they
 * SAY. Nothing here is inferred, no idle timer runs, and no keyboard is watched.
 *
 * The two are rendered together and never merged. Somebody can be offline with "in a
 * meeting" set (they closed the laptop and left) and online with it too (they are in a
 * meeting with the laptop open). One indicator covering both would lose the distinction
 * the reader actually wants.
 *
 * ## Why polling and not the socket
 *
 * A declared status changes a few times a day, and the socket exists for messages. Adding
 * a status channel to it would mean a broadcast per change to every tab holding a
 * connection, to move information that is minutes-fresh at best. A poll on a slow cadence
 * costs one request per minute and cannot fall out of sync after a reconnect.
 *
 * ## Fails to silence
 *
 * A failed poll leaves the previous answer in place rather than clearing it: a status that
 * blinks out because one request timed out is worse than one that is a minute stale. On
 * the first load a failure means an empty map, which renders as no badges — the same as
 * everybody being available, which is the safe reading.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, type DeclaredStatusView } from './api-client';

/** Slow: this is a courtesy, and a tighter loop buys nothing a person notices. */
const POLL_MS = 60_000;

/** The server's own cap. Asking for more would be refused rather than truncated. */
const MAX_IDS = 50;

export function useDeclaredStatuses(
  principalIds: readonly string[],
): ReadonlyMap<string, DeclaredStatusView> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, DeclaredStatusView>>(new Map());

  /*
     Keyed on the joined ids so the effect re-runs when WHO is on screen changes, and not
     when the array identity changes — which is every render of the shell.
  */
  const key = useMemo(() => [...principalIds].sort().slice(0, MAX_IDS).join(','), [principalIds]);

  /* Held in a ref so the interval body always sees the current set without the interval
     itself being torn down and rebuilt on every change. */
  const idsRef = useRef(key);
  idsRef.current = key;

  useEffect(() => {
    let live = true;

    const poll = (): void => {
      const ids = idsRef.current;
      if (ids === '') {
        setStatuses(new Map());
        return;
      }
      void api
        .statusesFor(ids.split(','))
        .then((result) => {
          if (!live) return;
          setStatuses(new Map(result.statuses.map((entry) => [entry.principalId, entry])));
        })
        .catch(() => {
          /* Keep what we had. A badge that blinks out because one request timed out is
             worse than one that is a minute stale. */
        });
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key]);

  return statuses;
}
