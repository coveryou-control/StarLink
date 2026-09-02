'use client';

/**
 * What this browser is allowed to do when something arrives — Settings screen 07.
 *
 * ## Why "this device", and why that is not §29.6's business
 *
 * §29.6 makes the IN-APP notification the unread mechanism and explicitly not a preference:
 * the bell's count, the list behind it and the unread badges on conversations are facts, and
 * nothing here can turn them off. What these settings govern is the layer above that — a
 * desktop notification and a tone, both of which belong to the browser you are sitting at.
 * The design says so on the page itself ("Applies to this device. Mobile has its own
 * settings"), and it is why these live in `localStorage` and not on the server.
 *
 * ## Quiet hours are a personal default, not a business value
 *
 * Rule 10 forbids inventing SLA targets, working hours, categories and capacity — company
 * facts that need sign-off. A window during which THIS person's laptop should not make a
 * noise is none of those: it is a device preference with a sensible starting value, editable
 * on the page, and off until somebody turns it on. Nothing in the product reads it except
 * this file.
 */

const KEY = 'starlink.device-notifications';

export interface DeviceNotifications {
  /** Notify for every direct message. */
  readonly direct: boolean;
  /** In a group, notify only when you are mentioned or replied to. */
  readonly groups: boolean;
  /** Play a short tone as well as showing the notification. */
  readonly sound: boolean;
  /** Suppress both, between `quietFrom` and `quietTo`. */
  readonly quietHours: boolean;
  /** 24-hour "HH:MM". Crossing midnight is the normal case and is handled. */
  readonly quietFrom: string;
  readonly quietTo: string;
}

/**
 * On, for the three that say a message arrived.
 *
 * They were all off, on the reasoning that a product which starts making noises before
 * anybody asked is a product people turn off entirely. That reasoning is right for a
 * marketing app and wrong for a messenger: being told is the job. StarLink had removed
 * per-conversation mute for exactly this reason — "getting notifications is important for
 * everyone" — and then shipped with every notification switch off by default, which is the
 * same silence arrived at by a different route.
 *
 * Nothing here can interrupt anybody on its own. The system notification additionally
 * requires the BROWSER's permission, which is asked for on the settings screen at the
 * moment somebody turns a switch on, never on arrival. Quiet hours stay off because a
 * window during which the product goes silent is a business decision, not a default.
 */
export const DEVICE_NOTIFICATION_DEFAULTS: DeviceNotifications = {
  direct: true,
  groups: true,
  sound: true,
  quietHours: false,
  quietFrom: '20:00',
  quietTo: '09:00',
};

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function readDeviceNotifications(): DeviceNotifications {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEVICE_NOTIFICATION_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<DeviceNotifications>;
    /*
       Field by field, and a bad value falls back rather than throwing. This is a string a
       person could have edited, and one malformed key must not cost the other five.
    */
    /*
       Absent means DEFAULT, not false.

       `parsed.x === true` collapsed both "the person turned it off" and "this key was
       written before the field existed" to off — so every browser holding a settings blob
       from an earlier version would have stayed silent through the change of defaults
       above, which is precisely the population that would never think to look.
    */
    const flag = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback;

    return {
      direct: flag(parsed.direct, DEVICE_NOTIFICATION_DEFAULTS.direct),
      groups: flag(parsed.groups, DEVICE_NOTIFICATION_DEFAULTS.groups),
      sound: flag(parsed.sound, DEVICE_NOTIFICATION_DEFAULTS.sound),
      quietHours: flag(parsed.quietHours, DEVICE_NOTIFICATION_DEFAULTS.quietHours),
      quietFrom: isTime(parsed.quietFrom) ? parsed.quietFrom : DEVICE_NOTIFICATION_DEFAULTS.quietFrom,
      quietTo: isTime(parsed.quietTo) ? parsed.quietTo : DEVICE_NOTIFICATION_DEFAULTS.quietTo,
    };
  } catch {
    // A browser with site data blocked is not an error state; the defaults are correct.
    return DEVICE_NOTIFICATION_DEFAULTS;
  }
}

export function writeDeviceNotifications(value: DeviceNotifications): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // The choice still applies to this tab; it simply will not survive a reload.
  }
}

/**
 * Is `now` inside the quiet window?
 *
 * Written to handle the crossing case first, because it is the normal one: 20:00 to 09:00 is
 * what most people mean by "evening", and a naive `from <= now && now < to` is false for
 * every minute of it.
 */
export function inQuietHours(settings: DeviceNotifications, now: Date = new Date()): boolean {
  if (!settings.quietHours) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [fromH = 0, fromM = 0] = settings.quietFrom.split(':').map(Number);
  const [toH = 0, toM = 0] = settings.quietTo.split(':').map(Number);
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Whether this event should reach the desktop, and with a sound.
 *
 * `kind` is what the notification is: a direct message, or something in a group. A mention
 * always counts as a group event worth raising — that is what "only mentions and replies"
 * means, and it is why the group switch is not simply "notify for groups".
 */
export function shouldNotify(
  settings: DeviceNotifications,
  kind: 'DIRECT' | 'GROUP_MENTION' | 'OTHER',
  now: Date = new Date(),
): boolean {
  if (inQuietHours(settings, now)) return false;
  if (kind === 'DIRECT') return settings.direct;
  if (kind === 'GROUP_MENTION') return settings.groups;
  return false;
}

/**
 * Registers the notification service worker.
 *
 * Idempotent and safe to call on every mount — `register` on an already-registered scope
 * resolves to the existing registration. Failure is silent by design: a browser with
 * service workers disabled still gets the tone and the in-app unread counts, and an error
 * banner about a worker is not something the person can act on.
 */
export async function ensureNotificationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return undefined;
  }
}

/**
 * Raises a system notification, if the browser has been given permission.
 *
 * Never ASKS for permission here. A permission prompt that appears because a message
 * arrived is the prompt everybody denies; it is requested from the settings page, at the
 * moment somebody turns the switch on, which is the one time the request makes sense.
 *
 * Body-free, like the notification it mirrors (§29.2): it says something arrived and where,
 * never what was said. A system notification is rendered on a locked screen in an open-plan
 * office, which is the last place a message body should appear.
 *
 * ## Through the service worker where there is one
 *
 * `new Notification(...)` THROWS on Android Chrome — "Illegal constructor" — and the only
 * supported path there is `ServiceWorkerRegistration.showNotification`. So the phone, which
 * is the device where this matters most, was the one device it could never work on. The
 * worker path is tried first and the constructor is the desktop fallback.
 */
export function raiseDeviceNotification(title: string, target?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const options: NotificationOptions = {
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // One per conversation: five messages in a thread is one thing to look at.
    ...(target !== undefined ? { tag: `starlink:${target}` } : {}),
    ...(target !== undefined ? { data: { url: `/conversations/${target}` } } : {}),
  };

  void (async () => {
    try {
      const registration =
        typeof navigator !== 'undefined' && 'serviceWorker' in navigator
          ? await navigator.serviceWorker.getRegistration('/')
          : undefined;
      if (registration !== undefined) {
        await registration.showNotification(title, options);
        return;
      }
    } catch {
      // Fall through to the constructor below.
    }

    try {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        if (target !== undefined) window.location.assign(`/conversations/${target}`);
        notification.close();
      };
    } catch {
      // A browser that refuses to construct one is a browser that will not show one.
    }
  })();
}

/**
 * A short tone, synthesised rather than fetched.
 *
 * No audio file: one would be a network request, a cache entry and a 404 the first time
 * somebody moved the public directory. Two notes on an oscillator is the same amount of
 * "something happened" and cannot fail to load.
 */
export function playNotificationTone(): void {
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    const context = new Ctor();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
    gain.connect(context.destination);

    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(880, context.currentTime);
    tone.frequency.setValueAtTime(1174, context.currentTime + 0.09);
    tone.connect(gain);
    tone.start();
    tone.stop(context.currentTime + 0.3);
    tone.onended = () => void context.close().catch(() => undefined);
  } catch {
    // Autoplay policy, a missing device, a browser without WebAudio. None is worth an error.
  }
}
