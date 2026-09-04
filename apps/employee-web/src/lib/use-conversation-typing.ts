'use client';

/**
 * Who is typing, in conversations you are NOT currently looking at.
 *
 * ## Why this needs its own subscription
 *
 * The gateway broadcasts a typing signal to the CONVERSATION's channel, and a socket
 * receives it only if it has joined that channel. The open thread joins the one it is
 * showing, which is why "Rahul is typing" appears inside a conversation and nowhere else —
 * the list has no subscription and therefore no signal.
 *
 * So the shell joins the channels of the conversations it has loaded. That is the whole of
 * the change: the same broadcast, received by a socket that had not asked for it.
 *
 * ## The cost, and why it is bounded
 *
 * A join per conversation, re-sent on every reconnect. Capped at the most recent
 * `MAX_CHANNELS`, which is the same ceiling the presence query and the status read use —
 * somebody in two hundred conversations subscribes to the fifty they are actually using,
 * and the ones further down the list simply do not animate. That is the right failure: a
 * typing indicator is a courtesy, and the alternative is two hundred joins on every
 * reconnect to decorate rows nobody is looking at.
 *
 * The signals themselves are already bounded server-side — the gateway throttles to one
 * per socket per second and the presence entry has a five-second TTL — so this adds
 * subscriptions, not traffic per subscription.
 *
 * ## Expiry is local, and has to be
 *
 * The gateway sends a signal when somebody types and nothing when they stop. The frame is
 * therefore a statement about a moment, and the reader forgets it after
 * `TYPING_FORGET_MS`. Without that, one keystroke would leave a conversation "typing"
 * forever — which is the shape of bug that makes people stop believing the indicator.
 */
import { useEffect, useRef, useState } from 'react';
import {
  SOCKET_EVENTS,
  conversationChannel,
  type TypingFrame,
} from '@starlink/shared-contracts/realtime';

import { acquireSharedSocket, releaseSharedSocket } from './shared-socket';

/** Matches the presence query's cap and the status read's. */
const MAX_CHANNELS = 50;

/**
 * Slightly longer than the gateway's five-second presence TTL.
 *
 * Shorter and the row would flicker between "typing" and the preview while somebody is
 * still writing, because the next signal is up to a second away and the throttle can push
 * it further. Longer and a row keeps claiming somebody is typing after they have stopped.
 */
const TYPING_FORGET_MS = 6_000;

export function useConversationTyping(
  conversationIds: readonly string[],
): ReadonlyMap<string, string> {
  /** conversationId → the principal typing in it. */
  const [typing, setTyping] = useState<ReadonlyMap<string, string>>(new Map());

  const key = [...conversationIds].slice(0, MAX_CHANNELS).sort().join(',');

  /* Timers keyed by conversation, so a second signal for the same conversation extends the
     window rather than stacking a second expiry behind the first. */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (key === '') {
      setTyping(new Map());
      return;
    }

    const socket = acquireSharedSocket();
    const ids = key.split(',');

    const subscribe = (): void => {
      for (const id of ids) {
        socket.emit(SOCKET_EVENTS.subscribe, conversationChannel(id as never));
      }
    };

    const onTyping = (frame: TypingFrame): void => {
      setTyping((current) => {
        const next = new Map(current);
        next.set(frame.conversationId, frame.principalId);
        return next;
      });

      const existing = timers.current.get(frame.conversationId);
      if (existing !== undefined) clearTimeout(existing);
      timers.current.set(
        frame.conversationId,
        setTimeout(() => {
          timers.current.delete(frame.conversationId);
          setTyping((current) => {
            const next = new Map(current);
            next.delete(frame.conversationId);
            return next;
          });
        }, TYPING_FORGET_MS),
      );
    };

    subscribe();
    /* On every connect, not just the first. A reconnect is a NEW socket id with empty
       channel membership on the gateway — without this the list goes quiet after the first
       network blip and stays that way until a reload. */
    socket.on('connect', subscribe);
    socket.on(SOCKET_EVENTS.typingSignal, onTyping);

    const pending = timers.current;
    return () => {
      socket.off('connect', subscribe);
      socket.off(SOCKET_EVENTS.typingSignal, onTyping);
      /* Unsubscribe rather than relying on the disconnect: the socket is shared, so it
         very likely stays open for the presence hook, and leaving the channels joined
         would keep delivering signals nothing is listening for. */
      for (const id of ids) {
        socket.emit(SOCKET_EVENTS.unsubscribe, conversationChannel(id as never));
      }
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      releaseSharedSocket();
    };
  }, [key]);

  return typing;
}
