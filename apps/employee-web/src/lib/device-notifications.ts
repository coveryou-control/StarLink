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
 * Off is the default for everything that interrupts.
 *
 * A product that starts making noises before anybody asked it to is a product people turn
 * off entirely. The unread count works from the first second either way, because that is the
 * mechanism §29.6 guarantees and this file cannot reach it.
 */
export const DEVICE_NOTIFICATION_DEFAULTS: DeviceNotifications = {
  direct: false,
  groups: false,
  sound: false,
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
    return {
      direct: parsed.direct === true,
      groups: parsed.groups === true,
      sound: parsed.sound === true,
      quietHours: parsed.quietHours === true,
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
 * Raises a desktop notification, if the browser has been given permission.
 *
 * Never ASKS for permission here. A permission prompt that appears because a message
 * arrived is the prompt everybody denies; it is requested from the settings page, at the
 * moment somebody turns the switch on, which is the one time the request makes sense.
 *
 * Body-free, like the notification it mirrors (§29.2): it says something arrived and where,
 * never what was said. A desktop notification is rendered on a locked screen in an open-plan
 * office, which is the last place a message body should appear.
 */
export function raiseDeviceNotification(title: string, target?: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const notification = new Notification(title, {
      icon: '/icon-192.png',
      // One per conversation: five messages in a thread is one thing to look at.
      ...(target !== undefined ? { tag: `starlink:${target}` } : {}),
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // A browser that refuses to construct one is a browser that will not show one.
  }
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
