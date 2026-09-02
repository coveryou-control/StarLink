'use client';

/**
 * Who is currently connected, for the avatars on screen.
 *
 * ## What this is and is not
 *
 * A hint, and nothing more. §21.9 is explicit that presence is not availability — "a phone
 * entering a lift is not leave" — so this never says "away", never says "busy", and is
 * never the basis for routing or for whether somebody may be given work. It answers one
 * question: does this colleague currently hold a realtime lease.
 *
 * The gateway has written that lease on every connection since Phase 3 and nothing could
 * read it; the socket query this uses is the read path.
 *
 * ## One socket for the whole tab
 *
 * Refcounted at module scope rather than opened per hook. The first version opened a
 * connection inside the hook, and the hook has two callers — the shell, for the people in
 * the conversation list, and the directory, for whoever a search just found. That is two
 * presence sockets per tab on top of the thread's and the notification bell's, and the
 * browser suite's wall clock went from about three minutes to eleven and a half.
 *
 * A socket is not a component-scoped resource. The last hook to unmount closes it; a
 * remount inside the same tab reuses the connection that is already open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type PresenceSnapshot } from '@starlink/shared-contracts/realtime';

import { runtimeOrigins } from './runtime-origins';

/** Slow on purpose: presence is decoration and a tighter loop buys nothing a person notices. */
const POLL_MS = 20_000;
/** Matches the gateway's own cap; asking for more would be silently truncated there. */
const MAX_IDS = 50;

let shared: Socket | undefined;
let refs = 0;

function acquire(): Socket {
  refs += 1;
  if (shared === undefined) {
    shared = io(runtimeOrigins().realtime, {
      withCredentials: true,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 1.0,
    });
  }
  return shared;
}

function release(): void {
  refs = Math.max(0, refs - 1);
  if (refs === 0 && shared !== undefined) {
    shared.removeAllListeners();
    shared.disconnect();
    shared = undefined;
  }
}

export function usePresence(principalIds: readonly string[]): ReadonlySet<string> {
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  const socketRef = useRef<Socket | null>(null);

  /**
   * Sorted and de-duplicated, so the effect below re-runs when the SET changes rather than
   * when the array identity does — the callers build these lists inline on every render.
   */
  const key = useMemo(
    () => [...new Set(principalIds)].filter((id) => id !== '').sort().slice(0, MAX_IDS).join(','),
    [principalIds],
  );

  useEffect(() => {
    socketRef.current = acquire();
    return () => {
      socketRef.current = null;
      release();
    };
  }, []);

  const ask = useCallback(() => {
    const socket = socketRef.current;
    if (socket === null || !socket.connected || key === '') return;
    socket.emit(SOCKET_EVENTS.presenceQuery, { principalIds: key.split(',') }, (answer: unknown) => {
      const snapshot = answer as PresenceSnapshot | undefined;
      // A malformed or absent ack leaves the last known set in place rather than blanking
      // every dot: "we could not ask" is not "everybody is offline".
      if (snapshot === undefined || !Array.isArray(snapshot.online)) return;
      setOnline(new Set(snapshot.online));
    });
  }, [key]);

  useEffect(() => {
    if (key === '') {
      setOnline(new Set());
      return;
    }
    ask();
    const timer = setInterval(ask, POLL_MS);
    const socket = socketRef.current;
    // Also on reconnect: the answer is a property of the socket layer, so a dropped
    // connection is exactly when the previous answer stopped being trustworthy.
    socket?.on('connect', ask);
    return () => {
      clearInterval(timer);
      socket?.off('connect', ask);
    };
  }, [ask, key]);

  return online;
}
