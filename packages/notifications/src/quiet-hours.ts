/**
 * "Do not interrupt me between these hours", evaluated where the decision is made.
 *
 * ## Why this is server-side, and per DEVICE
 *
 * Quiet hours were a browser preference in `localStorage`, applied by the web app before
 * it raised a desktop notification. That works for in-app, and not at all for push: the
 * decision to send happens in the API, the delivery happens in Google's infrastructure,
 * and by the time a service worker could consult a preference the phone has already lit
 * up — which is the entire thing being suppressed. A service worker cannot read
 * `localStorage` either.
 *
 * So the window travels with the DEVICE TOKEN and the transport decides. Per device
 * rather than per person, deliberately: a laptop that sits on a desk all night and a
 * phone on a bedside table want different answers, and the person holding both is the
 * only one who knows which is which.
 *
 * ## Why a timezone, and not an offset
 *
 * An offset captured at registration is wrong twice a year, silently, for everybody in a
 * country that observes daylight saving — and it fails in the direction that wakes
 * people. An IANA zone stays correct because the rules travel with the name.
 *
 * ## What it does NOT do
 *
 * It suppresses the interruption and nothing else. §29.6 makes in-app the unread
 * mechanism rather than a preference, so the row is still written, the badge still
 * counts it, and the conversation is still bold in the morning. This decides whether a
 * device buzzes, not whether somebody is told.
 */

export interface QuietWindow {
  /** Local start, `HH:MM` on a 24-hour clock. */
  readonly from: string;
  /** Local end, `HH:MM`. Earlier than `from` means the window crosses midnight. */
  readonly to: string;
  /** IANA name, e.g. `Asia/Kolkata`. */
  readonly timeZone: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` into minutes since local midnight, or `undefined` if it is not a time. */
function minutesOf(value: string): number | undefined {
  const match = TIME.exec(value);
  if (match === null) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * What time it is on that device, right now.
 *
 * `Intl` rather than arithmetic on an offset: it is the only thing in the platform that
 * knows when a zone's rules change, and getting this wrong means notifications resume an
 * hour early on a Sunday morning in spring.
 *
 * Returns `undefined` for a zone name the runtime does not recognise, which is treated
 * below as "not quiet" — see `inQuietWindow` for why that direction.
 */
function localMinutes(timeZone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    if (hour === undefined || minute === undefined) return undefined;
    /* `hour12: false` yields 24 rather than 00 for midnight in some runtimes. */
    return (Number(hour) % 24) * 60 + Number(minute);
  } catch {
    return undefined;
  }
}

/**
 * Is this device inside its quiet window?
 *
 * **Unparseable input answers `false`.** A malformed time, an unknown zone or a window
 * of zero length means the window cannot be evaluated, and the safe reading of "I cannot
 * tell" is to DELIVER. The alternative fails silently and in the worst direction: a
 * person stops receiving notifications entirely and has no way to discover why, which is
 * indistinguishable from the feature being broken. A notification that should have been
 * held is an annoyance; one that is dropped for ever is a missed escalation.
 */
export function inQuietWindow(window: QuietWindow | undefined, at: Date): boolean {
  if (window === undefined) return false;

  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  if (from === undefined || to === undefined) return false;
  /* Equal ends describe no window at all, not a 24-hour one. Reading it as "always
     quiet" would mute a device for ever on what is almost certainly a filled-in form
     nobody finished. */
  if (from === to) return false;

  const now = localMinutes(window.timeZone, at);
  if (now === undefined) return false;

  /* The crossing case first, because it is the normal one: 20:00 to 09:00 is what most
     people mean by "evening", and a plain `from <= now && now < to` is false for every
     minute of it. */
  return from < to ? now >= from && now < to : now >= from || now < to;
}
