'use client';

/**
 * The notification badge and the notification list, from one source.
 *
 * ## Why a hook rather than a component
 *
 * The count is shown on the navigation rail and the list is shown in a panel, and those
 * are two different places on the screen. Held inside a component they would be two
 * independent pollers with two independent ideas of the unread count, and the badge would
 * disagree with the list it opens — which is the specific way a notification indicator
 * loses people's trust.
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

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  useRoom(principalChannel(principalId as never), () => void refreshCount());

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

    /* Not while the person is looking at the application. A desktop notification for a
       message already on screen is the interruption people mean when they say they turned
       notifications off. */
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;

    for (const item of wanted) raiseDeviceNotification(item.subject, item.targetRef);
    if (settings.sound) playNotificationTone();
  }, [items]);

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
