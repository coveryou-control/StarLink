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
 * The StarLink arrival sound: a blade drawn, and a star.
 *
 * ## Synthesised, not fetched — and that is the older decision, kept
 *
 * There is no audio file. One would be a network request, a cache entry, a service-worker
 * precache question and a 404 the first time somebody moved the public directory — for a
 * sound that has to be ready the instant a message lands. It is also what makes this asset
 * unambiguously ours: every sample below is computed here from oscillators and noise, so
 * there is nothing licensed, nothing sampled, and nothing to attribute.
 *
 * ## What it is made of
 *
 * Three layers, about 1.2 seconds end to end:
 *
 *   1. **The draw.** Bandpass-filtered white noise whose centre frequency sweeps upward
 *      fast — that sweep IS the shing. A blade leaving a scabbard is broadband friction
 *      rising in pitch as the contact point runs along the edge, and a filter sweep over
 *      noise is that, exactly.
 *   2. **The steel.** Three partials at INHARMONIC ratios (1 : 1.47 : 2.11). Harmonic
 *      ratios sound like a bell or a chime and would read as cheerful; metal's partials
 *      are not whole-number multiples, and that is the whole difference between a blade
 *      and a triangle. They glide up about six per cent over the draw, which is the
 *      movement.
 *   3. **The star.** Four very quiet high sines, staggered a little under a tenth of a
 *      second apart, each shorter than the one before. Staggered rather than stacked so
 *      they read as a sparkle rather than a chord, and quiet enough to be a signature
 *      rather than a second event.
 *
 * ## What it is deliberately not
 *
 * No impact, no transient click, no reverb tail. An impact is a hit and this is a
 * movement; a tail is what makes a sound cinematic, and this plays dozens of times a day
 * beside somebody trying to work. The master lowpass at 9kHz is there for the same reason:
 * unshaped filtered noise is bright to the point of harsh on laptop speakers, and harsh is
 * the fastest way to make a person switch a sound off.
 *
 * Peak gain is 0.085, a little under a tenth of full scale. It is meant to be noticed in a
 * quiet room and inaudible under a conversation, which is the right behaviour for
 * something this frequent.
 */

/**
 * One context, reused.
 *
 * A context per notification was the previous shape, and it closed each one afterwards —
 * correct, but browsers cap concurrent contexts (six, commonly) and three messages
 * arriving together could open three before any closed. A single suspended context costs
 * nothing and cannot reach that ceiling.
 */
let shared: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (shared !== undefined && shared.state !== 'closed') return shared;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return undefined;
  shared = new Ctor();
  return shared;
}

/** White noise, built once and replayed. It is the friction of the draw. */
let noise: AudioBuffer | undefined;

function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  if (noise !== undefined && noise.sampleRate === context.sampleRate) return noise;
  const frames = Math.floor(context.sampleRate * 0.7);
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;
  noise = buffer;
  return buffer;
}

/** How long the sound runs, end to end. */
export const NOTIFICATION_TONE_MS = 1_200;

/**
 * Builds the sound onto any context, at any time.
 *
 * Separate from {@link playNotificationTone} so it can be rendered into an
 * `OfflineAudioContext` — or a recording stand-in — and CHECKED. A notification sound is
 * the one piece of interface nobody reviews: it is written once, it is plausible on the
 * machine it was written on, and a gain typed as 0.85 instead of 0.085 ships and is a
 * physical unpleasantness for everybody. `notification-tone.test.ts` asserts the peak, the
 * attack, the sweep direction and the length against the design this file describes.
 */
export function buildNotificationTone(
  context: BaseAudioContext,
  destination: AudioNode,
  t: number,
): void {

    /* The master chain: a lowpass to take the edge off, then one gain for the whole sound,
       so every layer below is mixed against a single level. */
    const out = context.createGain();
    out.gain.setValueAtTime(1, t);
    const tame = context.createBiquadFilter();
    tame.type = 'lowpass';
    tame.frequency.setValueAtTime(9000, t);
    tame.Q.setValueAtTime(0.7, t);
    out.connect(tame);
    tame.connect(destination);

    // 1. The draw: noise through a fast upward filter sweep.
    const source = context.createBufferSource();
    source.buffer = noiseBuffer(context);

    const sweep = context.createBiquadFilter();
    sweep.type = 'bandpass';
    /* Q sets how narrow the sweep reads. Low is a wash; very high whistles. Six is the
       band where it sounds like an edge rather than either. */
    sweep.Q.setValueAtTime(6, t);
    sweep.frequency.setValueAtTime(1200, t);
    sweep.frequency.exponentialRampToValueAtTime(5200, t + 0.24);
    /* And down a little. A sweep that stops at the top sounds cut off; easing down is the
       blade clearing and the friction ending. */
    sweep.frequency.exponentialRampToValueAtTime(3800, t + 0.5);

    /* Below 700Hz is rumble that costs headroom and adds nothing. */
    const body = context.createBiquadFilter();
    body.type = 'highpass';
    body.frequency.setValueAtTime(700, t);

    const drawGain = context.createGain();
    drawGain.gain.setValueAtTime(0.0001, t);
    /* 18ms, not instant: an instant attack is a click, and a click is an impact. */
    drawGain.gain.exponentialRampToValueAtTime(0.085, t + 0.018);
    drawGain.gain.exponentialRampToValueAtTime(0.03, t + 0.2);
    drawGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);

    source.connect(sweep);
    sweep.connect(body);
    body.connect(drawGain);
    drawGain.connect(out);
    source.start(t);
    source.stop(t + 0.6);

    // 2. The steel: three inharmonic partials, gliding up.
    const BASE = 1860;
    const partials: readonly {
      readonly ratio: number;
      readonly gain: number;
      readonly until: number;
    }[] = [
      { ratio: 1, gain: 0.022, until: 0.46 },
      { ratio: 1.47, gain: 0.014, until: 0.38 },
      { ratio: 2.11, gain: 0.009, until: 0.3 },
    ];
    for (const partial of partials) {
      const osc = context.createOscillator();
      osc.type = 'triangle';
      const from = BASE * partial.ratio;
      osc.frequency.setValueAtTime(from, t);
      /* The movement. Six per cent is small on purpose — more is a slide whistle. */
      osc.frequency.exponentialRampToValueAtTime(from * 1.06, t + 0.3);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(partial.gain, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + partial.until);

      osc.connect(gain);
      gain.connect(out);
      osc.start(t);
      osc.stop(t + partial.until + 0.05);
    }

    // 3. The star: four quiet sparks, after the blade has cleared.
    const STARS: readonly {
      readonly at: number;
      readonly hz: number;
      readonly life: number;
    }[] = [
      { at: 0.5, hz: 4200, life: 0.16 },
      { at: 0.6, hz: 5600, life: 0.14 },
      { at: 0.71, hz: 3500, life: 0.13 },
      { at: 0.83, hz: 6800, life: 0.11 },
    ];
    for (const star of STARS) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(star.hz, t + star.at);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, t + star.at);
      gain.gain.exponentialRampToValueAtTime(0.02, t + star.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + star.at + star.life);

      osc.connect(gain);
      gain.connect(out);
      osc.start(t + star.at);
      osc.stop(t + star.at + star.life + 0.02);
    }

}

export function playNotificationTone(): void {
  try {
    const context = audio();
    if (context === undefined) return;

    /* A context created before any gesture starts suspended. Resuming is a no-op when it is
       already running, and the failure — a browser that refuses without a gesture — is
       exactly the case that should stay silent rather than throw. */
    if (context.state === 'suspended') void context.resume().catch(() => undefined);

    buildNotificationTone(context, context.destination, context.currentTime);

    /* The context is NOT closed. It is reused — see `audio()` — and closing it after every
       notification is what would make three arrivals in a second open three contexts. */
  } catch {
    // Autoplay policy, a missing device, a browser without WebAudio. None is worth an error.
  }
}
