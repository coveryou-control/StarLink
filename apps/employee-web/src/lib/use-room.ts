'use client';

/**
 * Subscribes to a §20.7 room and calls back when something arrives (N-27, F2).
 *
 * ## Why this exists separately from `use-realtime`
 *
 * `use-realtime` follows the OPEN THREAD: it joins one conversation and interprets frames
 * into an ordered message stream. The team and personal rooms are not that. §20.7 gives
 * both "Unordered — it is a set, not a sequence" and "Discard known id", so there is no
 * sequence to track and nothing to apply in order — the correct response to any frame is
 * simply "re-read the list".
 *
 * ## Why a re-read and not a payload
 *
 * §20.7 gives both rows **"Transport required: No"** with load-time fallbacks — "queue
 * read on load" and "notification list on load". The event is an immediacy layer over a
 * list that is already correct without it. Applying a payload would make the socket
 * load-bearing; asking the API is what keeps invariant 9 true ("no state exists only in an
 * event; recovery is re-fetch").
 *
 * The publishers landed on 2026-08-29 and nothing subscribed to either room, so both were
 * carried entirely by their polling fallback. This is the other half.
 */
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@starlink/shared-contracts/realtime';
import type { RealtimeChannel } from '@starlink/shared-contracts';

import { runtimeOrigins } from './runtime-origins';


export function useRoom(channel: RealtimeChannel | undefined, onChanged: () => void): void {
  const handler = useRef(onChanged);
  handler.current = onChanged;

  useEffect(() => {
    if (channel === undefined) return;

    const socket: Socket = io(runtimeOrigins().realtime, {
      withCredentials: true,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 1.0,
    });

    socket.on('connect', () => {
      socket.emit(SOCKET_EVENTS.subscribe, channel);
      // A fresh connection has missed an unknown number of events, and this room carries
      // no sequence to reconcile from — so the only correct move is to re-read.
      handler.current();
    });

    // A refused join simply never delivers (§20.10). The list keeps polling, which is the
    // documented fallback, so there is nothing to report to the person.
    socket.on(SOCKET_EVENTS.event, () => handler.current());

    return () => {
      socket.emit(SOCKET_EVENTS.unsubscribe, channel);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [channel?.kind, JSON.stringify(channel)]);
}
