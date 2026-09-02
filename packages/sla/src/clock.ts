/**
 * Elapsed working time, derived on every read (doc §23.5).
 *
 * The whole model rests on one sentence: *"The clock is computed, never stored as a
 * countdown."* Everything else follows. There is no tick, no scheduler, no `remaining_ms`
 * column — so a night when no job ran cannot leave a case wrong, and a holiday added to
 * last month's calendar makes every case that spanned it correct on the next read rather
 * than needing a backfill nobody will remember to write.
 *
 * ## Versions are clipped, not chosen
 *
 * A calendar is versioned and effective-dated (§23.1, ADR-017) so that a correction fixes
 * history. When an interval spans a version boundary — hours changed on the 1st, and the
 * case opened on the 30th — the arithmetic clips each version to its own effective period
 * and sums. Picking "the version in force at the start" would apply last month's hours to
 * this month's days, which is the precise error effective-dating exists to prevent.
 *
 * ## Cost
 *
 * The walk is per local day, so a case open for a year costs 365 window intersections on
 * read. That is cheap next to the alternative's failure mode, and if it ever stops being
 * cheap the answer is a materialised view that can be rebuilt from these same functions —
 * not a stored countdown.
 */
import type { Timestamp } from '@starlink/shared-contracts';
import { localPartsOf, type BusinessCalendar } from './calendar.js';

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

/**
 * A hard stop on how far the day-walk will go.
 *
 * Not a business rule — a runaway guard. A malformed effective period (`effectiveTo`
 * before `effectiveFrom`, an epoch-zero timestamp) would otherwise walk millions of days
 * inside a request. Ten years is far beyond any case's life and far below a hang.
 */
const MAX_DAYS = 3_660;

const shiftDate = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * The instant at which a given local wall-clock time occurs in a zone.
 *
 * Two passes, because the offset depends on the instant we are trying to find. Guess by
 * treating the wall clock as UTC, measure how wrong the guess is in the target zone,
 * correct, and measure again — the second pass catches a guess that landed on the far
 * side of a DST transition. India has no DST; a team in a zone that does must still get
 * the right answer, and "we do not have that problem today" is how you acquire it later.
 *
 * On the spring-forward hour, a wall-clock time that does not exist resolves to the
 * instant the clock jumps to. On the autumn repeat, it resolves to the first occurrence.
 * Both are conventions rather than truths, which is why they are written down here.
 */
export function instantAtLocal(timezone: string, date: string, minuteOfDay: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(y, m - 1, d) + minuteOfDay * MS_PER_MINUTE;

  let instant = new Date(asIfUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localPartsOf(instant, timezone);
    const localAsIfUtc =
      Date.UTC(local.year, local.month - 1, local.day) + local.minuteOfDay * MS_PER_MINUTE;
    const drift = localAsIfUtc - instant.getTime();
    const corrected = asIfUtc - drift;
    if (corrected === instant.getTime()) break;
    instant = new Date(corrected);
  }
  return instant;
}

/** An open period as real instants. */
export interface OpenInterval {
  readonly from: Date;
  readonly to: Date;
}

const windowsForLocalDate = (
  calendar: BusinessCalendar,
  date: string,
): readonly { openMinute: number; closeMinute: number }[] => {
  const exception = calendar.exceptions.find((e) => e.date === date);
  if (exception !== undefined) return (exception.windows ?? []).map((w) => ({ ...w }));
  if (calendar.holidays.includes(date)) return [];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return calendar.workingWindows
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ openMinute: w.openMinute, closeMinute: w.closeMinute }));
};

/**
 * Every open interval of ONE calendar version that overlaps `[from, to)`.
 *
 * The walk starts a day early so a window that began yesterday and runs past midnight is
 * not missed — a 22:00–02:00 desk is open at 00:30 on behalf of the previous day.
 */
export function openIntervals(
  calendar: BusinessCalendar,
  from: Date,
  to: Date,
): readonly OpenInterval[] {
  if (to.getTime() <= from.getTime()) return [];

  const intervals: OpenInterval[] = [];
  const startDate = shiftDate(localPartsOf(from, calendar.timezone).date, -1);
  const endDate = localPartsOf(to, calendar.timezone).date;

  let date = startDate;
  for (let day = 0; day <= MAX_DAYS; day += 1) {
    for (const w of windowsForLocalDate(calendar, date)) {
      // A window may run past midnight; `instantAtLocal` handles minute-of-day beyond
      // 1440 because the underlying date arithmetic simply rolls over.
      const opensAt = instantAtLocal(calendar.timezone, date, w.openMinute);
      const closesAt = instantAtLocal(calendar.timezone, date, w.closeMinute);
      const overlapFrom = Math.max(opensAt.getTime(), from.getTime());
      const overlapTo = Math.min(closesAt.getTime(), to.getTime());
      if (overlapTo > overlapFrom) {
        intervals.push({ from: new Date(overlapFrom), to: new Date(overlapTo) });
      }
    }
    if (date >= endDate) break;
    date = shiftDate(date, 1);
  }

  intervals.sort((a, b) => a.from.getTime() - b.from.getTime());
  return intervals;
}

/** Clips a version's effective period against a query window. */
const clipToVersion = (
  calendar: BusinessCalendar,
  from: Date,
  to: Date,
): { from: Date; to: Date } | undefined => {
  const versionFrom = Date.parse(calendar.effectiveFrom);
  const versionTo = calendar.effectiveTo === undefined ? Infinity : Date.parse(calendar.effectiveTo);
  const start = Math.max(from.getTime(), versionFrom);
  const end = Math.min(to.getTime(), versionTo);
  return end > start ? { from: new Date(start), to: new Date(end) } : undefined;
};

/**
 * Working seconds between two instants, across every calendar version that applies.
 *
 * `versions` is a team's calendar HISTORY, not just the one in force now. Passing only
 * the current version silently applies today's hours to last month, which is the bug
 * effective-dating exists to prevent and which no test of a single-version calendar can
 * ever catch.
 *
 * A period with no calendar version covering it contributes ZERO working time. That is
 * the honest reading — no calendar means no declared hours means nobody was rostered —
 * and it is the same refusal to invent hours that §23.1 makes.
 */
export function elapsedWorkingSeconds(
  versions: readonly BusinessCalendar[],
  from: Timestamp,
  to: Timestamp,
): number {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (toDate.getTime() <= fromDate.getTime()) return 0;

  let total = 0;
  for (const version of versions) {
    const clipped = clipToVersion(version, fromDate, toDate);
    if (clipped === undefined) continue;
    for (const interval of openIntervals(version, clipped.from, clipped.to)) {
      total += (interval.to.getTime() - interval.from.getTime()) / 1000;
    }
  }
  return Math.round(total);
}

/**
 * The instant at which `seconds` of WORKING time will have elapsed from `from`.
 *
 * The inverse of {@link elapsedWorkingSeconds}, and it exists for one sentence in §23.5:
 * *"Breach is a flag with a timestamp, not a deletion of the target — **Late, and by how
 * much** must stay answerable."* Answering "when did this breach" against a business-hours
 * target means walking the calendar forward until the working seconds run out, because
 * the breach instant is nowhere near `start + target` on a wall clock — a 30-minute target
 * on a message that arrived at 18:55 breaches at 10:25 the next morning, not at 19:25.
 *
 * Returns `undefined` when the target is not reached within the horizon. That is a real
 * answer for a team with no working windows, and better than a fabricated date: the case
 * has not breached, because no working time has passed.
 */
export function instantAfterWorkingSeconds(
  versions: readonly BusinessCalendar[],
  from: Timestamp,
  seconds: number,
  horizonDays = 365,
): Timestamp | undefined {
  const start = new Date(from);
  if (seconds <= 0) return from;

  const horizon = new Date(start.getTime() + horizonDays * MINUTES_PER_DAY * MS_PER_MINUTE);

  // Collected across versions and re-sorted, so a version boundary mid-target is handled
  // the same way elapsed time handles it — each version's own hours, in order.
  const intervals: OpenInterval[] = [];
  for (const version of versions) {
    const clipped = clipToVersion(version, start, horizon);
    if (clipped === undefined) continue;
    intervals.push(...openIntervals(version, clipped.from, clipped.to));
  }
  intervals.sort((a, b) => a.from.getTime() - b.from.getTime());

  let remaining = seconds * 1000;
  for (const interval of intervals) {
    const span = interval.to.getTime() - interval.from.getTime();
    if (span >= remaining) {
      return new Date(interval.from.getTime() + remaining).toISOString() as Timestamp;
    }
    remaining -= span;
  }
  return undefined;
}

/**
 * When the team next opens at or after `at`, or `undefined` within the search horizon.
 *
 * §23.3 needs this and §23.5 case B needs it: an after-hours message starts no clock
 * until the calendar opens, and "when does it open" is the question an acknowledgement
 * must be able to answer WITHOUT promising a reply time. Returning `undefined` — a team
 * with no working windows at all, or a closure longer than the horizon — is a real
 * answer, and better than a date invented to fill the field.
 */
export function nextOpening(
  versions: readonly BusinessCalendar[],
  at: Timestamp,
  horizonDays = 60,
): Timestamp | undefined {
  const atDate = new Date(at);
  const horizon = new Date(atDate.getTime() + horizonDays * MINUTES_PER_DAY * MS_PER_MINUTE);

  let earliest: number | undefined;
  for (const version of versions) {
    const clipped = clipToVersion(version, atDate, horizon);
    if (clipped === undefined) continue;
    const first = openIntervals(version, clipped.from, clipped.to)[0];
    if (first === undefined) continue;
    // `openIntervals` clips to the query window, so an interval already in progress
    // starts exactly at `at` — which is the right answer: it is open now.
    if (earliest === undefined || first.from.getTime() < earliest) earliest = first.from.getTime();
  }

  return earliest === undefined ? undefined : (new Date(earliest).toISOString() as Timestamp);
}

/**
 * The version covering an instant, if any.
 *
 * Half-open `[effectiveFrom, effectiveTo)`, the same convention as ownership episodes and
 * participation — so two versions that meet exactly leave neither a gap nor an overlap.
 */
export function versionAt(
  versions: readonly BusinessCalendar[],
  at: Timestamp,
): BusinessCalendar | undefined {
  const instant = Date.parse(at);
  return versions.find((v) => {
    const start = Date.parse(v.effectiveFrom);
    const end = v.effectiveTo === undefined ? Infinity : Date.parse(v.effectiveTo);
    return start <= instant && instant < end;
  });
}
