/**
 * Reads a team's business calendar HISTORY (doc §23.1, §23.5).
 *
 * History, not "the current calendar", and the plural is the whole point. §23.5 requires
 * that *"a holiday added retrospectively re-derives correctly"* and that a calendar
 * correction *"fixes history rather than leaving it wrong"*. Both are only true if the
 * arithmetic can see every version that overlaps the period it is asked about — a reader
 * that returned only the row in force today would apply today's hours to last month, and
 * no test of a single-version calendar would ever notice.
 *
 * ## Malformed configuration fails loudly
 *
 * A calendar with a misspelled timezone or a window of `{"open": "10am"}` must not
 * degrade to "closed". Closed is a legitimate business state, so a parse failure that
 * silently produced it would be indistinguishable from a team that is genuinely shut —
 * and every customer would get an after-hours acknowledgement at noon while the desk sat
 * idle. Every row is validated on read and a bad one throws.
 *
 * The absence of a calendar is different, and is NOT an error: it is reported as an empty
 * history, and the caller decides what an unconfigured team means. §23.1 refuses to
 * invent hours; this refuses to invent the answer that would follow from them.
 */
import type pg from 'pg';
import type { Timestamp } from '@starlink/shared-contracts';
import type { BusinessCalendar, CalendarException, Weekday } from '@starlink/sla';

const MAX_MINUTE = 2880;

const isWeekday = (value: unknown): value is Weekday =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;

const isMinute = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MINUTE;

/** `YYYY-MM-DD`, and a real date — `2026-02-31` is a typo, not a holiday. */
const isLocalDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

const fail = (calendarId: string, detail: string): never => {
  throw new Error(
    `business calendar ${calendarId} is malformed: ${detail}. Refusing to read it — a ` +
      'calendar that cannot be parsed must not silently become "closed", which is ' +
      'indistinguishable from a team that is genuinely shut.',
  );
};

const parseWindows = (calendarId: string, raw: unknown): BusinessCalendar['workingWindows'] => {
  if (!Array.isArray(raw)) return fail(calendarId, 'working_windows is not an array');
  return raw.map((entry) => {
    const w = entry as Record<string, unknown>;
    if (!isWeekday(w.weekday)) return fail(calendarId, `weekday ${String(w.weekday)} is not 0–6`);
    if (!isMinute(w.openMinute) || !isMinute(w.closeMinute)) {
      return fail(calendarId, `window minutes must be integers 0–${MAX_MINUTE}`);
    }
    if (w.closeMinute <= w.openMinute) {
      // A zero-length or inverted window is a data error that reads as "never open" —
      // exactly the silent-closure failure this module exists to prevent.
      return fail(calendarId, `window closes (${w.closeMinute}) at or before it opens (${w.openMinute})`);
    }
    return { weekday: w.weekday, openMinute: w.openMinute, closeMinute: w.closeMinute };
  });
};

const parseExceptions = (calendarId: string, raw: unknown): readonly CalendarException[] => {
  if (!Array.isArray(raw)) return fail(calendarId, 'exceptions is not an array');
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (!isLocalDate(e.date)) return fail(calendarId, `exception date "${String(e.date)}" is not a real YYYY-MM-DD`);
    if (e.windows !== undefined && !Array.isArray(e.windows)) {
      return fail(calendarId, `exception ${e.date} has a non-array windows field`);
    }
    const windows = (e.windows as unknown[] | undefined)?.map((w) => {
      const win = w as Record<string, unknown>;
      if (!isMinute(win.openMinute) || !isMinute(win.closeMinute) || win.closeMinute <= win.openMinute) {
        return fail(calendarId, `exception ${e.date} has an invalid window`);
      }
      return { openMinute: win.openMinute, closeMinute: win.closeMinute };
    });
    return {
      date: e.date,
      // An exception with NO windows means closed all day. Distinct from an exception
      // with an empty array, which means the same thing — both are preserved as absent
      // rather than one becoming a zero-length open period.
      ...(windows !== undefined && windows.length > 0 ? { windows } : {}),
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    };
  });
};

/** Throws on an unknown IANA zone. `Intl` is the authority; a regex is not. */
const assertTimezone = (calendarId: string, timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    fail(calendarId, `timezone "${timezone}" is not a zone this platform knows`);
  }
};

export class PgBusinessCalendarReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Every version for a team, oldest first.
   *
   * Unbounded on purpose: a team accumulates a handful of calendar versions over years,
   * not thousands, and paging a history that the clock arithmetic has to see in full
   * would produce an answer that is wrong in a way nothing detects.
   */
  async historyFor(teamId: string): Promise<readonly BusinessCalendar[]> {
    const result = await this.pool.query(
      `SELECT calendar_id, team_id, timezone, version, effective_from, effective_to,
              working_windows, holidays, exceptions, is_seed_placeholder
         FROM conversation.business_calendars
        WHERE team_id = $1
        ORDER BY effective_from ASC`,
      [teamId],
    );

    return result.rows.map((row) => {
      const calendarId = row.calendar_id as string;
      const timezone = row.timezone as string;
      assertTimezone(calendarId, timezone);

      const holidays = row.holidays as unknown;
      if (!Array.isArray(holidays)) fail(calendarId, 'holidays is not an array');
      for (const holiday of holidays as unknown[]) {
        if (!isLocalDate(holiday)) fail(calendarId, `holiday "${String(holiday)}" is not a real YYYY-MM-DD`);
      }

      return {
        calendarId,
        teamId: row.team_id as string,
        timezone,
        version: row.version as number,
        effectiveFrom: (row.effective_from as Date).toISOString() as Timestamp,
        ...(row.effective_to !== null
          ? { effectiveTo: (row.effective_to as Date).toISOString() as Timestamp }
          : {}),
        workingWindows: parseWindows(calendarId, row.working_windows),
        holidays: holidays as readonly string[],
        exceptions: parseExceptions(calendarId, row.exceptions),
        // Carried, never hidden. A placeholder calendar that looks identical to a
        // ratified one is how a guess quietly becomes policy (D-20/D-21).
        provisional: row.is_seed_placeholder as boolean,
      };
    });
  }
}
