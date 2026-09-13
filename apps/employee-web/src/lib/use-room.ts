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
 *
 * ## Why it no longer opens its own connection
 *
 * It used to call `io()` directly, which made three sockets per tab — this one, the shell's
 * shared socket, and the open thread's. The gateway refuses a principal's ninth connection
 * (§27.5), so a third tab was refused its realtime and the thread sat on "Reconnecting"
 * for ever. Measured on 2026-09-09: tabs one and two fine, tab three refused with
 * `too_many_connections`.
 *
 * `shared-socket.ts` exists for exactly this and said so in its own docblock while two of
 * the three callers ignored it. Moving here takes a tab from three connections to two, so
 * the ceiling is reached at four tabs rather than two.
 */
import { useEffect, useRef } from 'react';
import { SOCKET_EVENTS, type RealtimeFrame } from '@starlink/shared-contracts/realtime';
import type { RealtimeChannel } from '@starlink/shared-contracts';

import { acquireSharedSocket, releaseSharedSocket } from './shared-socket';

/**
 * Which events actually concern each kind of room.
 *
 * A dedicated socket only ever received frames for the channels it had joined, so "any
 * frame" was a safe reading of "something happened in my room". A SHARED socket also
 * carries the conversation channels the sidebar joins, and the gateway's frame does not
 * say which channel delivered it — so without this the notification list would re-read on
 * every message sent anywhere in the product.
 *
 * An event missing from this map is not lost, it is late: §20.7 gives both rooms
 * "Transport required: No" with a load-time fallback, and both lists poll. That is the
 * designed degradation, and it is the reason this map is allowed to be a short list of
 * what is known rather than an exhaustive one that has to be maintained in step.
 */
const ROOM_EVENTS: Readonly<Record<RealtimeChannel['kind'], readonly string[]>> = {
  PRINCIPAL: ['notification.created.v1'],
  TEAM: ['conversation.queue.arrived.v1'],
  /* `use-realtime` owns the open thread; nothing routes a conversation room through here. */
  CONVERSATION: [],
  CONTROL: [],
};

export function useRoom(channel: RealtimeChannel | undefined, onChanged: () => void): void {
  const handler = useRef(onChanged);
  handler.current = onChanged;

  const kind = channel?.kind;
  const key = channel === undefined ? '' : JSON.stringify(channel);

  useEffect(() => {
    if (channel === undefined || kind === undefined) return;

    const socket = acquireSharedSocket();
    const wanted = new Set(ROOM_EVENTS[kind]);

    const subscribe = (): void => {
      socket.emit(SOCKET_EVENTS.subscribe, channel);
    };

    const onConnect = (): void => {
      subscribe();
      // A fresh connection has missed an unknown number of events, and this room carries
      // no sequence to reconcile from — so the only correct move is to re-read.
      handler.current();
    };

    const onEvent = (frame: RealtimeFrame): void => {
      if (!wanted.has(frame.name)) return;
      handler.current();
    };

    /* The shared socket is very likely already connected — it is opened by the shell
       before this mounts — and `connect` will not fire again for it. */
    if (socket.connected) subscribe();
    socket.on('connect', onConnect);
    socket.on(SOCKET_EVENTS.event, onEvent);

    return () => {
      if (socket.connected) socket.emit(SOCKET_EVENTS.unsubscribe, channel);
      /* `off` with the exact handler, never `removeAllListeners` — the socket belongs to
         presence and the sidebar too, and deafening them would be silent and total. */
      socket.off('connect', onConnect);
      socket.off(SOCKET_EVENTS.event, onEvent);
      releaseSharedSocket();
    };
    /* Keyed on the channel's IDENTITY, not the object: callers build a fresh channel
       literal every render, so depending on `channel` would tear the subscription down and
       rebuild it on each one. `handler` is a ref for the same reason. */
  }, [kind, key]);
}
