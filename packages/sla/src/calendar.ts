/**
 * The business calendar (doc §23.1) and the arithmetic that reads it (§23.5).
 *
 * ## Why this is a pure function over a passed-in calendar
 *
 * §23.5's first rule: **"The clock is computed, never stored as a countdown."** Elapsed
 * working time is derived from the start, the stops and the calendar every time it is
 * asked for — which is what makes the next two rules possible:
 *
 *   * *"Pause and resume are calendar-driven. No job needs to have run for the arithmetic
 *     to be right."* A stored countdown needs a scheduler to tick it, and a scheduler
 *     that missed a night leaves every case wrong with nothing to say so.
 *   * *"A holiday added retrospectively re-derives correctly."* Only true if history is
 *     recomputed rather than remembered. Add Diwali to last month's calendar and every
 *     case that spanned it becomes correct on the next read.
 *
 * So nothing here caches, and nothing here writes.
 *
 * ## Why the timezone is explicit and never the server's
 *
 * §23.1: *"One timezone per calendar. Explicit, never inferred from a server clock."* A
 * process running in UTC and a laptop running in IST must agree on whether Claims was
 * open at 19:05, and the only way they can is if neither consults its own clock's zone.
 * Every wall-clock conversion below goes through `Intl.DateTimeFormat` with the
 * calendar's IANA zone, so DST — which India does not have but a future team might —
 * is handled by the platform rather than by arithmetic here.
 *
 * ## What this module refuses to decide
 *
 * There are **no default hours**. §23.1 is explicit: *"Inventing '10:00–19:00, Monday to
 * Saturday' would be inventing a business fact. The architecture reads whatever the
 * calendar says."* A team with no calendar is not open — see {@link isOpenAt} — and that
 * is a refusal to guess, not a schedule.
 */
import type { Timestamp } from '@starlink/shared-contracts';

/** 0 = Sunday … 6 = Saturday, matching `Date.getUTCDay()` and every JS convention. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * An open period on one day, as LOCAL WALL-CLOCK minutes from midnight.
 *
 * Minutes rather than a `Date` because a working window is a fact about the clock on the
 * wall, not about an instant: "we open at 10:00" stays true across a DST transition that
 * moves 10:00 to a different UTC offset.
 *
 * `closeMinute` may exceed 1440 for a window that runs past midnight (a 22:00–02:00 desk
 * is 1320 → 1560). It may not exceed 2880, because a "window" longer than two days is a
 * data error rather than a long shift.
 */
export interface WorkingWindow {
  readonly weekday: Weekday;
  readonly openMinute: number;
  readonly closeMinute: number;
}

/**
 * A one-off departure from the weekly pattern (§23.1 "Exceptions").
 *
 * `windows` absent means CLOSED all day — the common case, and why holidays and closures
 * are the same shape. `windows` present REPLACES the day's normal pattern rather than
 * adding to it: "open 14:00–18:00 this Saturday only" must not also imply the usual
 * Saturday hours.
 */
export interface CalendarException {
  /** Local date in the calendar's timezone, `YYYY-MM-DD`. Never an instant. */
  readonly date: string;
  readonly windows?: readonly { readonly openMinute: number; readonly closeMinute: number }[];
  readonly reason?: string;
}

export interface BusinessCalendar {
  readonly calendarId: string;
  readonly teamId: string;
  /** IANA zone, e.g. `Asia/Kolkata`. Validated on read — a bad zone must not silently pass. */
  readonly timezone: string;
  readonly version: number;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly workingWindows: readonly WorkingWindow[];
  /** Local `YYYY-MM-DD` dates. A holiday is an exception with no windows. */
  readonly holidays: readonly string[];
  readonly exceptions: readonly CalendarException[];
  /**
   * True while the values are placeholders awaiting sign-off (D-20/D-21).
   *
   * Carried through rather than hidden so a surface can say so. A placeholder calendar
   * that looks identical to a ratified one is how a guess becomes policy.
   */
  readonly provisional: boolean;
}

const MINUTES_PER_DAY = 1440;

/**
 * Local wall-clock parts for an instant, in a given IANA zone.
 *
 * `Intl` rather than manual offset arithmetic: it is the only thing in the platform that
 * knows when a zone's offset changes, and hand-rolled offsets are how a DST bug becomes
 * a silent SLA error twice a year.
 */
interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minuteOfDay: number;
  readonly weekday: Weekday;
  /** `YYYY-MM-DD`, for matching holidays and exceptions. */
  readonly date: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) return cached;
  // Throws `RangeError` on an unknown zone, which is the correct outcome: a calendar
  // with a misspelled timezone must fail loudly rather than silently fall back to UTC
  // and report a team open at the wrong hours.
  const created = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timezone, created);
  return created;
};

const WEEKDAY_INDEX: Readonly<Record<string, Weekday>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export const localPartsOf = (instant: Date, timezone: string): LocalParts => {
  const parts = formatterFor(timezone).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // `en-GB` renders midnight as "24" rather than "00" in some engines; normalise it, or
  // a window starting at 00:00 is never open on the day it starts.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const weekday = WEEKDAY_INDEX[get('weekday')];

  if (weekday === undefined || !Number.isFinite(year)) {
    throw new Error(`could not read local time in timezone "${timezone}"`);
  }

  return {
    year,
    month,
    day,
    minuteOfDay: hour * 60 + minute,
    weekday,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
};

/** The local date `days` after (or before) the given one. Calendar arithmetic, not clock. */
const shiftDate = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  // UTC deliberately: this is date arithmetic on a label, with no instant involved, so
  // a local-time constructor would drag the SERVER's zone into a pure calendar operation.
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
};

const weekdayOf = (date: string): Weekday => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
};

/**
 * The open windows for one LOCAL DATE, as minute-of-day ranges.
 *
 * Precedence, and the order matters:
 *   1. An **exception** for that date replaces the day entirely — closure or extended
 *      hours. §23.1 calls these "one-off closures or extended hours", so an exception
 *      with windows is a substitution, not an addition.
 *   2. A **holiday** closes the day.
 *   3. Otherwise the weekly pattern applies.
 *
 * Exceptions outrank holidays so that "the office IS open on this public holiday" is
 * expressible. A business that needs the reverse states it as an exception with no
 * windows, which is the same thing said the other way round.
 */
const windowsForDate = (
  calendar: BusinessCalendar,
  date: string,
): readonly { openMinute: number; closeMinute: number }[] => {
  const exception = calendar.exceptions.find((e) => e.date === date);
  if (exception !== undefined) {
    return (exception.windows ?? []).map((w) => ({ ...w }));
  }
  if (calendar.holidays.includes(date)) return [];

  const weekday = weekdayOf(date);
  return calendar.workingWindows
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ openMinute: w.openMinute, closeMinute: w.closeMinute }));
};

/**
 * Is the team open at this instant?
 *
 * A window that runs past midnight is checked against the PREVIOUS local date too — a
 * 22:00–02:00 desk is open at 00:30, and that openness belongs to the day the shift
 * started, not the day the clock rolled into.
 */
export function isOpenAt(calendar: BusinessCalendar, instant: Date): boolean {
  const local = localPartsOf(instant, calendar.timezone);

  for (const w of windowsForDate(calendar, local.date)) {
    if (local.minuteOfDay >= w.openMinute && local.minuteOfDay < w.closeMinute) return true;
  }

  // Spill-over from yesterday's late shift.
  const yesterday = shiftDate(local.date, -1);
  for (const w of windowsForDate(calendar, yesterday)) {
    if (w.closeMinute <= MINUTES_PER_DAY) continue;
    const spilled = local.minuteOfDay + MINUTES_PER_DAY;
    if (spilled >= w.openMinute && spilled < w.closeMinute) return true;
  }

  return false;
}

/**
 * Whether a team is open, when the calendar itself may be missing.
 *
 * `UNKNOWN` is a third answer on purpose. A team with no calendar is not a team that is
 * open, and it is not a team that has declared itself shut either — it is a gap in
 * configuration, and the caller deserves to be able to tell those apart. §23.1 refuses
 * to invent hours; this refuses to invent an answer derived from them.
 */
export type OpenState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

export const openStateOf = (
  calendar: BusinessCalendar | undefined,
  instant: Date,
): OpenState => (calendar === undefined ? 'UNKNOWN' : isOpenAt(calendar, instant) ? 'OPEN' : 'CLOSED');
