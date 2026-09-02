'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  conversationChannel,
  SOCKET_EVENTS,
  toConversationEvent,
  type ConversationEvent,
  type RealtimeFrame,
  type ReadFrame,
  type TypingFrame,
} from '@starlink/shared-contracts/realtime';

import { SequenceTracker } from './sequence';

import { runtimeOrigins } from './runtime-origins';


/**
 * The gateway publishes a NOTIFICATION, never content (doc §20.4). The body is fetched
 * over the authorised REST path, so a mis-routed frame cannot leak a message body to a
 * socket that should not see it.
 *
 * Every name and shape below comes from `@starlink/shared-contracts/realtime`. It used to
 * come from string literals here, and they were the WRONG literals: this file emitted
 * `conversation.subscribe` and listened for `conversation.event` while the gateway spoke
 * `subscribe` and `event`, and it expected `{ conversationId, seq, kind }` from a frame
 * that carries `{ eventId, name, seq, occurredAt, payload }`. The employee surface had
 * therefore never received a realtime event, and nothing failed — a socket name that
 * nobody is listening for produces silence, not an error.
 */
export type { ConversationEvent };

export type RealtimeStatus = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'OFFLINE';

interface UseRealtimeOptions {
  readonly conversationId: string | undefined;
  /**
   * Called when the client must re-read from the authoritative API: a gap was detected,
   * or the socket reconnected after missing an unknown number of events.
   */
  readonly onRefetch: () => void;
  /** Called for an in-order event that can be applied directly. */
  readonly onEvent: (event: ConversationEvent) => void;
  readonly onSessionRevoked: () => void;
  /**
   * SL-010. Someone else is composing in this conversation.
   *
   * `undefined` means nobody is. The gateway broadcasts these and **nothing consumed
   * them** until 2026-08-29, so the indicator the tracker asks for did not exist while
   * the server dutifully sent it to nobody.
   */
  readonly onTyping?: (typing: TypingFrame | undefined) => void;
  /**
   * Somebody else has read up to a position — the second tick, live.
   *
   * The frame carries one integer and no message ids (§20.4), and it is purely additive:
   * the same number arrives on the page read, so dropping every frame costs immediacy and
   * nothing else (rule 9).
   */
  readonly onRead?: (frame: ReadFrame) => void;
}

export function useRealtime({
  conversationId,
  onRefetch,
  onEvent,
  onSessionRevoked,
  onTyping,
  onRead,
}: UseRealtimeOptions): {
  status: RealtimeStatus;
  tracker: SequenceTracker;
  /** SL-010. Tells the gateway this person is composing; throttled server-side. */
  notifyTyping: (visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE') => void;
  notifyRead: (lastReadSeq: number) => void;
} {
  const [status, setStatus] = useState<RealtimeStatus>('CONNECTING');
  const trackerRef = useRef(new SequenceTracker());
  const socketRef = useRef<Socket | null>(null);

  /**
   * The room this socket is supposed to be in, readable from the `connect` handler.
   *
   * Room membership is per-CONNECTION and the gateway keeps it in a map keyed by socket
   * id. A reconnect produces a new socket id and empty membership, so the join has to be
   * re-sent every time the socket connects — not once when the thread opens.
   */
  const joinedRef = useRef<string | undefined>(undefined);

  // Hold the callbacks in refs so a re-render does not tear down and rebuild the
  // socket — reconnect storms are something we are explicitly trying to avoid.
  const handlers = useRef({ onRefetch, onEvent, onSessionRevoked, onTyping, onRead });
  handlers.current = { onRefetch, onEvent, onSessionRevoked, onTyping, onRead };

  useEffect(() => {
    const socket = io(runtimeOrigins().realtime, {
      withCredentials: true,
      transports: ['websocket'],
      // Socket.IO's own backoff, configured for full-ish jitter. `reconnectDelayMs` in
      // sequence.ts documents why: 500 employees reconnecting in lockstep will kill the
      // instance that replaced the one that just died.
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 1.0,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('LIVE');

      /**
       * Re-join the room, on EVERY connect.
       *
       * This is the fix for a silent failure: the subscribe used to be emitted from an
       * effect keyed on `[conversationId]`. Socket.IO reuses the same `Socket` object
       * across reconnects, so that effect never re-ran — while the reconnected socket
       * had a new id and empty room membership on the gateway. After any blip the thread
       * received NO further events and went on displaying LIVE, because `connect` had
       * fired and the status is set from the transport rather than from the join.
       *
       * The conversation page is also the one surface with no polling fallback — the
       * queue, the bell and the load panel all poll — so nothing else recovered it. An
       * agent's next customer message simply never appeared.
       *
       * `use-room.ts` had always done this correctly, inside its own connect handler.
       */
      const joined = joinedRef.current;
      if (joined !== undefined) {
        socket.emit(SOCKET_EVENTS.subscribe, conversationChannel(joined as never));
      }

      // A fresh connection has missed an unknown number of events. Realtime is
      // additive (FR-RT-1), so the correct move on every connect is to re-read rather
      // than assume the stream picks up where it left off. After the re-join, so an event
      // arriving during the fetch is delivered rather than dropped.
      handlers.current.onRefetch();
    });

    socket.io.on('reconnect_attempt', () => setStatus('RECONNECTING'));
    /**
     * Revocation arrives as a SERVER-INITIATED DISCONNECT, not as a message.
     *
     * §27.13 and rule 3: a revoked session does not merely fail the next join, the socket
     * goes — `revokePrincipal` closes it. There is no `session.revoked` event and there
     * never was; this file listened for one for months, which meant a revoked employee's
     * tab sat showing a stale thread instead of returning to sign-in.
     *
     * Socket.IO reports a server-side close as `io server disconnect`, and it deliberately
     * does NOT auto-reconnect from it. That is the signal.
     */
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        setStatus('OFFLINE');
        handlers.current.onSessionRevoked();
        return;
      }
      setStatus('RECONNECTING');
    });
    socket.on('connect_error', () => setStatus('RECONNECTING'));

    socket.on(SOCKET_EVENTS.event, (frame: RealtimeFrame) => {
      /**
       * Interpreted by the SHARED mapper, so the gateway's integration test asserts on
       * exactly the interpretation this hook applies. A frame the client cannot read —
       * an unknown event name, a missing sequence — is ignored rather than applied at a
       * guessed position; the next re-fetch reconciles it (invariant 9).
       */
      const event = toConversationEvent(frame);
      if (event === undefined) return;

      const verdict = trackerRef.current.classify(event.conversationId, event.seq);
      switch (verdict.kind) {
        case 'APPLY':
          handlers.current.onEvent(event);
          trackerRef.current.commit(event.conversationId, event.seq);
          return;
        case 'DISCARD':
          return;
        case 'REFETCH':
          // Do not render a thread with a hole in it. The API is the truth.
          handlers.current.onRefetch();
          return;
      }
    });

    /**
     * SL-010. §20's model is that a typing signal is EPHEMERAL — "loss degrades UX only"
     * — so it is never persisted and never re-fetched. The TTL is relative because the two
     * ends have different clocks (ADR-025), and the timer clears the indicator locally
     * rather than waiting for a "stopped typing" message that may never arrive.
     */
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    socket.on(SOCKET_EVENTS.typingSignal, (frame: TypingFrame) => {
      handlers.current.onTyping?.(frame);
      if (typingTimer !== undefined) clearTimeout(typingTimer);
      typingTimer = setTimeout(
        () => handlers.current.onTyping?.(undefined),
        Math.max(1, frame.expiresInSeconds) * 1000,
      );
    });

    /**
     * A colleague's read position.
     *
     * No timer, unlike typing: a read watermark is a fact that stays true, where "is
     * typing" is a claim that expires. It is also monotonic, so the receiver keeps the
     * higher of what it holds and what arrives — an out-of-order frame is then harmless
     * rather than a tick that flickers backwards.
     */
    socket.on(SOCKET_EVENTS.readSignal, (frame: ReadFrame) => {
      handlers.current.onRead?.(frame);
    });

    /**
     * Come back immediately when the device does, instead of waiting out the backoff.
     *
     * The backoff above is deliberately long and jittered — up to 30 seconds, so five
     * hundred employees returning at once do not arrive in lockstep on the instance that
     * replaced the one that just died. That is right for a SERVER outage, where the delay
     * is protecting something.
     *
     * It is wrong for the ordinary case: one person walks out of a lift, or their laptop
     * wakes, and their own connectivity is back. Nothing is being protected by making them
     * wait, and the cost is severe — the thread sits showing RECONNECTING for up to half a
     * minute after the network returns, and a message sent to them in that window does not
     * appear until it elapses. The browser knows the moment connectivity is restored and
     * says so; this listens.
     *
     * `visibilitychange` covers the other half: a phone that was backgrounded has usually
     * had its socket closed by the OS, and the person is looking at the thread NOW.
     *
     * Both call `connect()`, which is a no-op on a connected socket and cancels the
     * pending backoff timer on one that is waiting. Neither bypasses the backoff for a
     * server that is genuinely down: the reconnect attempt this triggers fails like any
     * other and the backoff resumes.
     */
    const reconnectNow = (): void => {
      if (!socket.connected) socket.connect();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (typingTimer !== undefined) clearTimeout(typingTimer);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /**
   * Room membership follows the open thread. The gateway authorises the join; a refused
   * subscribe simply never delivers events (doc §20.10).
   *
   * This effect now records WHICH room is wanted and joins it if the socket is already
   * connected. When it is not, the `connect` handler above does the join — which is also
   * what re-joins after a reconnect. Emitting here unconditionally would work for the
   * first connect (Socket.IO buffers an emit made while disconnected and flushes it on
   * connect) and is exactly what hid the defect: it made the join look like it belonged
   * to the thread's lifetime rather than to the connection's.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null || conversationId === undefined) return;

    joinedRef.current = conversationId;

    // The gateway parses a RealtimeChannel — the `kind` is required, and omitting it was
    // the second half of why this never worked.
    const channel = conversationChannel(conversationId as never);
    if (socket.connected) socket.emit(SOCKET_EVENTS.subscribe, channel);

    return () => {
      joinedRef.current = undefined;
      // Only meaningful while connected; after a drop the gateway has already forgotten
      // this socket's membership, and the room is re-derived from `joinedRef` on connect.
      if (socket.connected) socket.emit(SOCKET_EVENTS.unsubscribe, channel);
      trackerRef.current.forget(conversationId);
    };
  }, [conversationId]);

  /**
   * Announces that this person is composing.
   *
   * Deliberately unthrottled here: the gateway already floors the rate per socket, and
   * §20.10 treats this as "the ONLY message a client can send that causes a broadcast to
   * other people" — so the authoritative limit belongs there, where it cannot be removed
   * by a client that wants to be chatty. Called per keystroke is fine; it is not sent per
   * keystroke.
   */
  const notifyTyping = (visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE'): void => {
    const socket = socketRef.current;
    if (socket === null || conversationId === undefined) return;
    socket.emit(SOCKET_EVENTS.typing, { conversationId, visibility });
  };

  /**
   * Report this reader's position to the room.
   *
   * Called only AFTER `POST /conversations/:id/read` has committed, and with the sequence
   * the SERVER returned — which `GREATEST` has already clamped. That ordering is what makes
   * the frame a report of durable state rather than a claim: if the write fails, nothing is
   * broadcast, and the tick simply arrives on somebody's next re-fetch instead.
   */
  const notifyRead = (lastReadSeq: number): void => {
    const socket = socketRef.current;
    if (socket === null || conversationId === undefined) return;
    if (!Number.isSafeInteger(lastReadSeq) || lastReadSeq <= 0) return;
    socket.emit(SOCKET_EVENTS.read, { conversationId, lastReadSeq });
  };

  return { status, tracker: trackerRef.current, notifyTyping, notifyRead };
}
