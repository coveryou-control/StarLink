/**
 * The business calendar (§23.1) and the clock that reads it (§23.5).
 *
 * Two of these are named exit criteria for Phase 6 — pause/resume across a close, and a
 * holiday added RETROSPECTIVELY re-deriving history. Both are properties of computing
 * the clock rather than storing it, so both would pass trivially against a countdown
 * that happened to be right today and fail the first time anyone corrected a calendar.
 *
 * Everything here uses `Asia/Kolkata` (UTC+5:30, no DST) for the ordinary cases and
 * `America/New_York` for the DST ones, because a half-hour offset and a shifting offset
 * break different assumptions and the arithmetic has to survive both.
 */
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@starlink/shared-contracts';

import { isOpenAt, openStateOf, type BusinessCalendar, type Weekday } from './calendar.js';
import { elapsedWorkingSeconds, instantAtLocal, nextOpening, versionAt } from './clock.js';

const at = (iso: string): Timestamp => iso as Timestamp;

/**
 * A weekday-only 10:00–19:00 desk in IST.
 *
 * These numbers are a TEST FIXTURE, not a proposal. §23.1 refuses to default hours and
 * D-20/D-21 have not answered; the arithmetic has to be exercised against something, and
 * that something must never leak into a seed or a default.
 */
const istDesk = (over: Partial<BusinessCalendar> = {}): BusinessCalendar => ({
  calendarId: 'cal-ist',
  teamId: 'support',
  timezone: 'Asia/Kolkata',
  version: 1,
  effectiveFrom: at('2020-01-01T00:00:00.000Z'),
  workingWindows: ([1, 2, 3, 4, 5] as Weekday[]).map((weekday) => ({
    weekday,
    openMinute: 10 * 60,
    closeMinute: 19 * 60,
  })),
  holidays: [],
  exceptions: [],
  provisional: false,
  ...over,
});

describe('isOpenAt — §23.1', () => {
  it('is open inside the window, in the calendar’s timezone', () => {
    // 12:00 IST is 06:30 UTC. A server reading its own clock would say 06:30 and answer
    // "closed", which is the mistake §23.1 forbids by making the zone explicit.
    expect(isOpenAt(istDesk(), new Date('2026-08-26T06:30:00.000Z'))).toBe(true);
  });

  it('is closed before opening and at the closing minute exactly', () => {
    // 09:59 IST
    expect(isOpenAt(istDesk(), new Date('2026-08-26T04:29:00.000Z'))).toBe(false);
    // 19:00 IST exactly — the window is half-open, so closing time is closed. Otherwise
    // a case arriving at the closing second gets a full working day of clock.
    expect(isOpenAt(istDesk(), new Date('2026-08-26T13:30:00.000Z'))).toBe(false);
    // 18:59 IST
    expect(isOpenAt(istDesk(), new Date('2026-08-26T13:29:00.000Z'))).toBe(true);
  });

  it('is closed on a non-working day', () => {
    // Sunday 2026-08-30, 12:00 IST.
    expect(isOpenAt(istDesk(), new Date('2026-08-30T06:30:00.000Z'))).toBe(false);
  });

  it('is closed on a holiday that falls on a working day', () => {
    const calendar = istDesk({ holidays: ['2026-08-26'] });
    expect(isOpenAt(calendar, new Date('2026-08-26T06:30:00.000Z'))).toBe(false);
  });

  it('lets an exception REPLACE the day rather than add to it', () => {
    /**
     * "Open 14:00–18:00 this Saturday only" must not also imply the usual hours. An
     * exception that merged with the weekly pattern would quietly extend a normal day
     * whenever anyone recorded a one-off — the opposite of what §23.1 means by
     * "one-off closures or extended hours".
     */
    const calendar = istDesk({
      exceptions: [{ date: '2026-08-26', windows: [{ openMinute: 14 * 60, closeMinute: 18 * 60 }] }],
    });

    // 11:00 IST — inside the NORMAL window, outside the exception.
    expect(isOpenAt(calendar, new Date('2026-08-26T05:30:00.000Z'))).toBe(false);
    // 15:00 IST — inside the exception.
    expect(isOpenAt(calendar, new Date('2026-08-26T09:30:00.000Z'))).toBe(true);
  });

  it('lets an exception open a day the weekly pattern closes', () => {
    // Sunday, opened specially. Expressible because exceptions outrank the pattern.
    const calendar = istDesk({
      exceptions: [{ date: '2026-08-30', windows: [{ openMinute: 10 * 60, closeMinute: 14 * 60 }] }],
    });
    expect(isOpenAt(calendar, new Date('2026-08-30T06:30:00.000Z'))).toBe(true);
  });

  it('lets an exception outrank a holiday', () => {
    const calendar = istDesk({
      holidays: ['2026-08-26'],
      exceptions: [{ date: '2026-08-26', windows: [{ openMinute: 10 * 60, closeMinute: 12 * 60 }] }],
    });
    expect(isOpenAt(calendar, new Date('2026-08-26T05:30:00.000Z'))).toBe(true);
  });

  it('handles a shift that runs past midnight', () => {
    // A 22:00–02:00 desk is open at 00:30, and that openness belongs to the day the
    // shift STARTED. Reading it against the new date alone would report closed.
    const nightDesk = istDesk({
      workingWindows: [{ weekday: 3, openMinute: 22 * 60, closeMinute: 26 * 60 }],
    });
    // Wednesday 2026-08-26 23:00 IST = 17:30 UTC
    expect(isOpenAt(nightDesk, new Date('2026-08-26T17:30:00.000Z'))).toBe(true);
    // Thursday 2026-08-27 01:00 IST = 19:30 UTC on the 26th
    expect(isOpenAt(nightDesk, new Date('2026-08-26T19:30:00.000Z'))).toBe(true);
    // Thursday 02:00 IST exactly — shift over.
    expect(isOpenAt(nightDesk, new Date('2026-08-26T20:30:00.000Z'))).toBe(false);
  });
});

describe('openStateOf — a missing calendar is not a closed one', () => {
  it('reports UNKNOWN rather than guessing', () => {
    /**
     * The distinction that keeps rule 10 intact. "Nobody is rostered right now" and
     * "nobody has told us the hours" are different facts, and collapsing them means the
     * product cannot say which is true. The caller decides what to DO about UNKNOWN;
     * this refuses to decide it here.
     */
    expect(openStateOf(undefined, new Date('2026-08-26T06:30:00.000Z'))).toBe('UNKNOWN');
    expect(openStateOf(istDesk(), new Date('2026-08-26T06:30:00.000Z'))).toBe('OPEN');
    expect(openStateOf(istDesk(), new Date('2026-08-26T20:30:00.000Z'))).toBe('CLOSED');
  });
});

describe('elapsedWorkingSeconds — §23.5', () => {
  const HOUR = 3600;

  it('counts only time inside the window', () => {
    // 09:00 → 11:00 IST: one working hour, because the desk opens at 10:00.
    const elapsed = elapsedWorkingSeconds(
      [istDesk()],
      at('2026-08-26T03:30:00.000Z'),
      at('2026-08-26T05:30:00.000Z'),
    );
    expect(elapsed).toBe(HOUR);
  });

  it('PAUSES overnight — §23.5 case A', () => {
    /**
     * The document's own worked example. Message at 18:55, close at 19:00, reply at
     * 10:20 the next morning: five minutes before the close and twenty after the open,
     * total 25 — not the fifteen and a half hours a wall clock would report.
     *
     * "The 15 overnight hours are not counted, because nobody was rostered. Counting
     * them would breach every evening enquiry."
     */
    const elapsed = elapsedWorkingSeconds(
      [istDesk()],
      at('2026-08-26T13:25:00.000Z'), // 18:55 IST Wednesday
      at('2026-08-27T04:50:00.000Z'), // 10:20 IST Thursday
    );
    expect(elapsed).toBe(25 * 60);
  });

  it('skips a weekend entirely', () => {
    // Friday 18:30 → Monday 10:30 IST: 30 minutes Friday + 30 Monday.
    const elapsed = elapsedWorkingSeconds(
      [istDesk()],
      at('2026-08-28T13:00:00.000Z'),
      at('2026-08-31T05:00:00.000Z'),
    );
    expect(elapsed).toBe(60 * 60);
  });

  it('re-derives when a holiday is added RETROSPECTIVELY', () => {
    /**
     * A named Phase 6 exit criterion, and the property that justifies computing the
     * clock instead of storing it.
     *
     * Nothing is recalculated, migrated or backfilled here — the same query is asked of
     * a corrected calendar and gives a different, correct answer. A stored countdown
     * would still hold the number it was ticked to on the day, and no amount of
     * correcting the calendar would move it.
     */
    const from = at('2026-08-25T04:30:00.000Z'); // Tue 10:00 IST
    const to = at('2026-08-27T04:30:00.000Z'); // Thu 10:00 IST

    const before = elapsedWorkingSeconds([istDesk()], from, to);
    expect(before).toBe(2 * 9 * HOUR); // two full nine-hour days

    // Someone declares the Wednesday a holiday, after the fact.
    const after = elapsedWorkingSeconds([istDesk({ holidays: ['2026-08-26'] })], from, to);
    expect(after).toBe(9 * HOUR);
  });

  it('applies each calendar VERSION to its own effective period', () => {
    /**
     * Hours changed mid-interval. Applying the version in force at the start would use
     * the old hours for the new days — which is exactly the error effective-dating
     * exists to prevent, and which a single-version test can never see.
     */
    const oldHours = istDesk({
      calendarId: 'v1',
      version: 1,
      effectiveFrom: at('2020-01-01T00:00:00.000Z'),
      effectiveTo: at('2026-08-26T00:00:00.000Z'),
    });
    // From the 26th the desk closes at 15:00 instead of 19:00: five hours, not nine.
    const newHours = istDesk({
      calendarId: 'v2',
      version: 2,
      effectiveFrom: at('2026-08-26T00:00:00.000Z'),
      workingWindows: ([1, 2, 3, 4, 5] as Weekday[]).map((weekday) => ({
        weekday,
        openMinute: 10 * 60,
        closeMinute: 15 * 60,
      })),
    });

    const elapsed = elapsedWorkingSeconds(
      [oldHours, newHours],
      at('2026-08-25T04:30:00.000Z'), // Tue 10:00 IST — old hours
      at('2026-08-27T04:30:00.000Z'), // Thu 10:00 IST — new hours
    );

    // Tuesday under v1 (9h) + Wednesday under v2 (5h). Not 18, and not 10.
    expect(elapsed).toBe(9 * HOUR + 5 * HOUR);
  });

  it('counts zero for a period no calendar version covers', () => {
    // No declared hours means nobody was rostered. The same refusal to invent hours
    // that §23.1 makes, expressed as arithmetic.
    const calendar = istDesk({ effectiveFrom: at('2026-09-01T00:00:00.000Z') });
    expect(
      elapsedWorkingSeconds([calendar], at('2026-08-25T04:30:00.000Z'), at('2026-08-27T04:30:00.000Z')),
    ).toBe(0);
  });

  it('is zero for a reversed or empty interval rather than negative', () => {
    expect(
      elapsedWorkingSeconds([istDesk()], at('2026-08-27T04:30:00.000Z'), at('2026-08-25T04:30:00.000Z')),
    ).toBe(0);
    expect(
      elapsedWorkingSeconds([istDesk()], at('2026-08-26T06:00:00.000Z'), at('2026-08-26T06:00:00.000Z')),
    ).toBe(0);
  });

  it('is additive across a split — the property a pause/resume model must have', () => {
    /**
     * elapsed(a→c) must equal elapsed(a→b) + elapsed(b→c) for any b between them,
     * including a b that lands in the middle of the night. A clock that failed this
     * would give a different answer depending on when it happened to be asked, which is
     * the defect "computed, never stored" is meant to make impossible.
     */
    const a = at('2026-08-25T04:30:00.000Z');
    const b = at('2026-08-25T20:00:00.000Z'); // 01:30 IST — closed
    const c = at('2026-08-27T04:30:00.000Z');

    expect(elapsedWorkingSeconds([istDesk()], a, b) + elapsedWorkingSeconds([istDesk()], b, c)).toBe(
      elapsedWorkingSeconds([istDesk()], a, c),
    );
  });
});

describe('nextOpening — §23.3', () => {
  it('returns the current instant when the team is already open', () => {
    const now = at('2026-08-26T06:30:00.000Z'); // 12:00 IST
    expect(nextOpening([istDesk()], now)).toBe(now);
  });

  it('returns tomorrow’s opening for an after-hours arrival', () => {
    // 23:30 IST Wednesday → 10:00 IST Thursday = 04:30 UTC.
    expect(nextOpening([istDesk()], at('2026-08-26T18:00:00.000Z'))).toBe(
      '2026-08-27T04:30:00.000Z',
    );
  });

  it('skips a weekend and a holiday to find the next real opening', () => {
    // Saturday, with the following Monday declared a holiday → opens Tuesday.
    const calendar = istDesk({ holidays: ['2026-08-31'] });
    expect(nextOpening([calendar], at('2026-08-29T06:30:00.000Z'))).toBe(
      '2026-09-01T04:30:00.000Z',
    );
  });

  it('returns undefined rather than inventing a date when nothing opens', () => {
    // A team with no working windows at all. "We do not know when" is a real answer and
    // the acknowledgement wording (D-20) must be able to cope with it.
    expect(nextOpening([istDesk({ workingWindows: [] })], at('2026-08-26T18:00:00.000Z'))).toBeUndefined();
  });
});

describe('daylight saving — the offset is not a constant', () => {
  const nyDesk = (): BusinessCalendar => ({
    calendarId: 'cal-ny',
    teamId: 'ny',
    timezone: 'America/New_York',
    version: 1,
    effectiveFrom: at('2020-01-01T00:00:00.000Z'),
    workingWindows: ([1, 2, 3, 4, 5] as Weekday[]).map((weekday) => ({
      weekday,
      openMinute: 9 * 60,
      closeMinute: 17 * 60,
    })),
    holidays: [],
    exceptions: [],
    provisional: false,
  });

  it('keeps the wall-clock opening fixed across a DST change', () => {
    /**
     * 09:00 local is 14:00 UTC in summer and 13:00 UTC in winter. Hand-rolled offset
     * arithmetic gets one of the two wrong, and the symptom is an SLA that is silently
     * an hour out for half the year — the kind of bug nobody finds by reading code.
     *
     * India has no DST. This exists because "we do not have that problem" is how you
     * acquire it the first time a team is added in a zone that does.
     */
    // Friday 2026-11-06, before the 1 Nov change → EST (UTC-5).
    expect(instantAtLocal('America/New_York', '2026-11-06', 9 * 60).toISOString()).toBe(
      '2026-11-06T14:00:00.000Z',
    );
    // Friday 2026-10-02, during EDT (UTC-4).
    expect(instantAtLocal('America/New_York', '2026-10-02', 9 * 60).toISOString()).toBe(
      '2026-10-02T13:00:00.000Z',
    );
  });

  it('counts a working day as eight hours on both sides of the change', () => {
    const summer = elapsedWorkingSeconds(
      [nyDesk()],
      at('2026-10-02T13:00:00.000Z'),
      at('2026-10-02T21:00:00.000Z'),
    );
    const winter = elapsedWorkingSeconds(
      [nyDesk()],
      at('2026-11-06T14:00:00.000Z'),
      at('2026-11-06T22:00:00.000Z'),
    );
    expect(summer).toBe(8 * 3600);
    expect(winter).toBe(8 * 3600);
  });
});

describe('versionAt', () => {
  it('uses a half-open period so adjoining versions neither gap nor overlap', () => {
    // The same convention as ownership episodes and participation. Two versions meeting
    // at an instant must resolve to exactly one of them.
    const v1 = istDesk({
      calendarId: 'v1',
      effectiveFrom: at('2026-01-01T00:00:00.000Z'),
      effectiveTo: at('2026-08-26T00:00:00.000Z'),
    });
    const v2 = istDesk({ calendarId: 'v2', effectiveFrom: at('2026-08-26T00:00:00.000Z') });

    expect(versionAt([v1, v2], at('2026-08-25T23:59:59.999Z'))?.calendarId).toBe('v1');
    expect(versionAt([v1, v2], at('2026-08-26T00:00:00.000Z'))?.calendarId).toBe('v2');
    expect(versionAt([v1, v2], at('2025-12-31T00:00:00.000Z'))).toBeUndefined();
  });
});
