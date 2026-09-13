'use client';

/**
 * One realtime connection for everything the SHELL needs, refcounted at module scope.
 *
 * ## Why this was extracted
 *
 * `use-presence.ts` owned this and was right to: the first version opened a connection
 * inside the hook, the hook has two callers, and the browser suite's wall clock went from
 * about three minutes to eleven and a half. A socket is not a component-scoped resource.
 *
 * The same argument then applied a second time. The shell now wants two long-lived things
 * from the realtime layer — who is online, and who is typing in conversations you are not
 * currently looking at — and giving the second one its own connection would repeat exactly
 * the mistake the first one documented.
 *
 * So the connection lives here and both hooks acquire it. The open thread keeps its OWN
 * socket (`use-realtime.ts`): it is scoped to one conversation, it carries the message
 * stream, and its lifetime is the page rather than the tab.
 *
 * ## The last holder closes it
 *
 * A remount inside the same tab reuses the connection that is already open. Only when
 * nothing is holding it does it disconnect — which matters because React's strict mode
 * mounts, unmounts and remounts every effect in development, and a socket torn down on
 * that cycle reconnects on every navigation.
 */
import { io, type Socket } from 'socket.io-client';

import { runtimeOrigins } from './runtime-origins';

let shared: Socket | undefined;
let refs = 0;

export function acquireSharedSocket(): Socket {
  refs += 1;
  if (shared === undefined) {
    shared = io(runtimeOrigins().realtime, {
      withCredentials: true,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      /*
         Full jitter. Every tab in the building reconnects when the gateway restarts, and
         a fixed backoff means they all arrive together — twice, because the second wave
         is the ones the first wave knocked over.
      */
      randomizationFactor: 1.0,
    });
  }
  return shared;
}

export function releaseSharedSocket(): void {
  refs = Math.max(0, refs - 1);
  if (refs === 0 && shared !== undefined) {
    shared.removeAllListeners();
    shared.disconnect();
    shared = undefined;
  }
}
