'use client';

/**
 * Being told that something arrived — a sound, and a system notification.
 *
 * ## There is no panel any more
 *
 * This drove a badge and a list in a Notifications destination. Both are gone: the list was
 * a record of things that had already happened somewhere you could go and look, and the
 * badge duplicated the unread counts already on the conversation rows. What is left is the
 * part that tells you at the moment it happens.
 *
 * Which means the LIST poll below is now load-bearing rather than incidental. It used to
 * run only when somebody opened the panel; with no panel to open, arrival detection would
 * simply never have run, and the sound this hook exists for would never have played. It is
 * on the same timer as the count.
 *
 * ## Live, with a poll underneath
 *
 * §20.7's Notification-created event (N-27) updates the count immediately. The poll stays
 * because §20.7 gives that row "Transport required: No" with "notification list on load"
 * as the documented fallback: a badge that only ever updated on a socket would quietly
 * stop being true after a dropped connection, and nothing would say so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { principalChannel } from '@starlink/shared-contracts/realtime';

import { api, ApiError, type NotificationView } from './api-client';
import { useRoom } from './use-room';
import {
  ensureNotificationWorker,
  playNotificationTone,
  raiseDeviceNotification,
  readDeviceNotifications,
  shouldNotify,
} from './device-notifications';

const POLL_MS = 30_000;

export interface NotificationsState {
  readonly unread: number;
  readonly items: readonly NotificationView[];
  readonly loading: boolean;
  /** Set only while the last attempt failed; cleared by the next success. */
  readonly error: string | undefined;
  readonly load: () => Promise<void>;
  readonly markRead: (notificationId: string) => Promise<void>;
  readonly markAllRead: () => Promise<void>;
}

export function useNotifications(
  principalId: string,
  onUnauthenticated?: () => void,
  /**
   * Conversations this person has quietened, and until when.
   *
   * ## Why mute is applied HERE and not on the server
   *
   * §29.6 makes the in-app unread count a fact rather than a preference, and the
   * notification rows ARE that mechanism. Filtering them server-side would take the
   * conversation out of the unread count, which is precisely what mute must not do — you
   * are meant to see everything you missed, just not be pulled away from your work to see
   * it as it happens.
   *
   * So the record is untouched and only the INTERRUPTION is suppressed: no tone, no
   * system notification. The row still arrives, the badge still counts it, the list still
   * bolds it.
   *
   * Passed in rather than fetched, because the shell already holds the conversation list
   * that carries `mutedUntil` and a second request for the same facts could disagree with
   * the first.
   */
  mutedUntil?: ReadonlyMap<string, string>,
): NotificationsState {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<readonly NotificationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refreshCount = useCallback(async () => {
    try {
      const { unread: n } = await api.notificationCount();
      setUnread(n);
      setError(undefined);
    } catch (cause) {
      /**
       * A failed poll must not blank the badge: the last known count is better information
       * than zero, which reads as "nothing needs you".
       *
       * A 401 is not a notification failure and must not be reported as one — the session
       * has gone, and the honest destination is sign-in. This used to `return` without
       * telling anybody, so an expired session left the bell polling into the void behind
       * a workspace the person could no longer use.
       */
      if (cause instanceof ApiError && cause.isUnauthenticated) {
        onUnauthenticated?.();
        return;
      }
      setError('Notifications are temporarily unavailable.');
    }
  }, [onUnauthenticated]);

  /*
     Registered once, on the first mount of a signed-in shell.

     Here rather than in the root layout because it exists for exactly one purpose: raising
     a notification on a phone, where `new Notification(...)` is not allowed. A signed-out
     visitor has nothing to be notified about.
  */
  useEffect(() => {
    void ensureNotificationWorker();
  }, []);

  useEffect(() => {
    const tick = (): void => {
      void refreshCount();
      void loadRef.current?.();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  /*
     §20.7's Notification-created event, which is what makes the sound arrive with the
     message rather than up to POLL_MS later. The poll underneath it is the documented
     fallback for a dropped socket, not the primary path.
  */
  useRoom(principalChannel(principalId as never), () => {
    void refreshCount();
    void loadRef.current?.();
  });

  /**
   * The device layer: a desktop notification and a tone, when this browser has been asked
   * for them — Settings screen 07.
   *
   * Driven off the notification LIST rather than the count, because the count says how many
   * and this needs to know what: "notify for direct messages" and "only mentions in groups"
   * are two different switches and one number cannot tell them apart.
   *
   * `seen` starts empty and is filled by the first load, so opening the application does not
   * announce everything that arrived while it was shut. Nothing here can raise anything the
   * settings have not turned on, and all of them are off until somebody does — see
   * `device-notifications.ts` for why.
   */
  const seen = useRef<Set<string> | undefined>(undefined);

  /*
     `load` is declared below this point and the poll above needs it. A ref rather than
     reordering the file: `load` closes over setState only, so a stale one is harmless, and
     putting it in the effect's dependency array would restart the interval on every render.
  */
  const loadRef = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    const known = seen.current;
    seen.current = new Set(items.map((item) => item.notificationId));
    if (known === undefined) return;

    const arrived = items.filter((item) => !item.read && !known.has(item.notificationId));
    if (arrived.length === 0) return;

    const settings = readDeviceNotifications();
    /* A mention is the group case the design's second switch describes; everything else
       from a conversation is treated as a direct message. An unrecognised event raises
       nothing — rule 4's shape, applied to an interruption. */
    const wanted = arrived.filter((item) =>
      shouldNotify(settings, item.event === 'MENTIONED' ? 'GROUP_MENTION' : 'DIRECT'),
    );
    if (wanted.length === 0) return;

    const hidden = typeof document === 'undefined' || document.visibilityState !== 'visible';

    /*
       The sound plays whether or not the window is in front.

       It used to be suppressed along with the notification whenever the page was visible,
       on the reasoning that you can already see the message. You cannot: "visible" means
       the tab is on screen, not that you are reading the thread the message landed in, and
       on a laptop with the workspace open in the background that rule made StarLink the one
       messenger that stayed silent. The one exception is the thread you are actually
       looking at — a tone for a message whose bubble is animating in front of you is noise.
    */
    const openConversation =
      typeof window === 'undefined'
        ? undefined
        : /\/conversations\/([0-9a-f-]{36})/.exec(window.location.pathname)?.[1];
    /*
       A muted conversation makes no noise and raises nothing.

       Evaluated against the clock at the moment the notification arrives, not at the
       moment the list was fetched: a fifteen-minute mute set from this tab is over
       fifteen minutes later whether or not anything has re-read the list since, and a
       stale `mutedUntil` must expire on its own rather than keep quietening things.
    */
    const audible = wanted.filter((item) => {
      if (item.targetRef === undefined) return true;
      const until = mutedUntil?.get(item.targetRef);
      return until === undefined || Date.parse(until) <= Date.now();
    });
    if (audible.length === 0) return;

    const elsewhere = audible.filter(
      (item) => hidden || item.targetRef === undefined || item.targetRef !== openConversation,
    );
    if (elsewhere.length > 0) playNotificationTone();

    /*
       The system notification is for when the application is NOT what you are looking at —
       which on a phone means the app is in the background, and the notification then lands
       on the lock screen the way every other app's does.
    */
    if (!hidden) return;
    for (const item of audible) raiseDeviceNotification(item.subject, item.targetRef);
  }, [items, mutedUntil]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { notifications } = await api.notifications();
      setItems(notifications);
      /**
       * Cleared on success, in the same place it is set.
       *
       * It used to be set here and cleared only by the count poll, so a single failed
       * fetch left "Notifications are temporarily unavailable." on screen for up to thirty
       * seconds after notifications had come back — and permanently if the poll was the
       * thing that had failed.
       */
      setError(undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) {
        onUnauthenticated?.();
        return;
      }
      setError('Notifications are temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [onUnauthenticated]);

  /* Handed to the poll above, which runs before this declaration in source order. */
  loadRef.current = load;

  const markRead = useCallback(
    async (notificationId: string) => {
      // Optimistic: the badge should move the instant the person acts on it. A failure
      // re-reads the truth rather than leaving the optimistic value in place.
      setItems((was) =>
        was.map((i) => (i.notificationId === notificationId ? { ...i, read: true } : i)),
      );
      try {
        await api.markNotificationRead(notificationId);
      } finally {
        void refreshCount();
      }
    },
    [refreshCount],
  );

  const markAllRead = useCallback(async () => {
    setItems((was) => was.map((i) => ({ ...i, read: true })));
    try {
      await api.markAllNotificationsRead();
    } finally {
      void refreshCount();
    }
  }, [refreshCount]);

  return { unread, items, loading, error, load, markRead, markAllRead };
}
