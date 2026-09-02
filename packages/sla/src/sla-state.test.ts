/**
 * PHASE 6 EXIT CRITERION: SLA arithmetic, including pause/resume and retroactive
 * holiday re-derivation (doc §23.5, §23.6).
 *
 * The two named properties are the ones that only hold because the clock is COMPUTED:
 *
 *   * **pause/resume** — a business-hours clock must not count the night, and a
 *     resolution clock must not count time we spent waiting on the customer.
 *   * **retroactive re-derivation** — declaring a holiday after the fact must change what
 *     a past case's clock says, with no backfill.
 *
 * §23.5's own worked examples (diagram 17, cases A and B) are transcribed as tests, so
 * the arithmetic is checked against the document's numbers rather than mine.
 */
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@starlink/shared-contracts';

import type { BusinessCalendar, Weekday } from './calendar.js';
import { selectTarget, slaState, type SlaTarget } from './sla-state.js';

const at = (iso: string): Timestamp => iso as Timestamp;

/** §23.5's worked example: a team open 10:00–19:00, in IST. A FIXTURE, not a proposal. */
const desk = (over: Partial<BusinessCalendar> = {}): BusinessCalendar => ({
  calendarId: 'cal',
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

/** §23.5's example target: first response within 30 minutes. Also a fixture. */
const target = (over: Partial<SlaTarget> = {}): SlaTarget => ({
  clock: 'FIRST_RESPONSE',
  targetSeconds: 30 * 60,
  basis: 'BUSINESS_HOURS',
  warningPct: 80,
  provisional: true,
  ...over,
});

describe('§23.5 case A — the clock pauses overnight', () => {
  /**
   * The document's own worked example:
   *
   *   18:55 message · clock starts, 5 min elapse before close
   *   19:00 CLOSE  · clock PAUSES with 25 min remaining
   *   ~~~ overnight: NO elapsed time counted ~~~
   *   10:00 OPEN   · clock RESUMES with 25 min remaining
   *   10:20 reply  · total elapsed 25 min · MET
   */
  const startedAt = at('2026-08-26T13:25:00.000Z'); // 18:55 IST Wednesday

  it('counts five minutes before the close, and nothing overnight', () => {
    // Asked at 02:00 IST, hours after closing. Still five minutes.
    const state = slaState(target(), { startedAt }, [desk()], at('2026-08-26T20:30:00.000Z'));
    expect(state.elapsedSeconds).toBe(5 * 60);
    expect(state.status).toBe('RUNNING');
  });

  it('resumes with 25 minutes remaining and MEETS the target at 10:20', () => {
    const state = slaState(
      target(),
      { startedAt, stoppedAt: at('2026-08-27T04:50:00.000Z') }, // 10:20 IST Thursday
      [desk()],
      at('2026-08-27T05:00:00.000Z'),
    );

    expect(state.elapsedSeconds).toBe(25 * 60);
    expect(state.status).toBe('MET');
    // The fifteen overnight hours are not counted. "Counting them would breach every
    // evening enquiry."
    expect(state.remainingSeconds).toBe(5 * 60);
  });

  it('puts the breach instant in the morning, not at 19:25 the night before', () => {
    /**
     * §23.5: "Breach is a flag with a timestamp… *Late, and by how much* must stay
     * answerable." Against a business-hours target that instant is nowhere near
     * `start + target` on a wall clock — 5 minutes elapse before the close, so the
     * remaining 25 fall after 10:00 the next morning.
     */
    const state = slaState(target(), { startedAt }, [desk()], at('2026-08-26T20:30:00.000Z'));
    expect(state.breachAt).toBe('2026-08-27T04:55:00.000Z'); // 10:25 IST
  });
});

describe('§23.5 case B — an after-hours arrival starts no clock', () => {
  /**
   *   23:30 message · PERSISTED · acknowledged · queued · CLOCK NOT STARTED
   *   10:00 OPEN    · routed · CLOCK STARTS NOW
   *   10:25 reply   · elapsed 25 min · MET
   *
   * The caller resolves "became routable" — `nextOpening` does that — so what this
   * asserts is that an unstarted clock reports NOT_STARTED rather than zero elapsed.
   * Zero elapsed looks like a clock running perfectly; it is not the same claim.
   */
  it('reports NOT_STARTED, not a running clock at zero', () => {
    const state = slaState(target(), {}, [desk()], at('2026-08-26T18:00:00.000Z'));
    expect(state.status).toBe('NOT_STARTED');
    expect(state.elapsedSeconds).toBe(0);
    expect(state.remainingSeconds).toBe(30 * 60);
    expect(state.breachAt).toBeUndefined();
  });

  it('meets the target when the reply lands 25 minutes after opening', () => {
    const state = slaState(
      target(),
      { startedAt: at('2026-08-27T04:30:00.000Z'), stoppedAt: at('2026-08-27T04:55:00.000Z') },
      [desk()],
      at('2026-08-27T05:00:00.000Z'),
    );
    expect(state.elapsedSeconds).toBe(25 * 60);
    expect(state.status).toBe('MET');
  });
});

describe('24×7 never pauses', () => {
  it('breaches at midnight on a 23:30 arrival — correct only if someone is rostered', () => {
    // §23.5: "23:30 message · clock starts · 30 min target · 00:00 BREACHED. Correct only
    // if someone is actually rostered at midnight." The engine supports it; §23.2 warns
    // that choosing it without staffing is "a staffing decision wearing an SLA costume".
    const state = slaState(
      target({ basis: 'CALENDAR_24X7' }),
      { startedAt: at('2026-08-26T18:00:00.000Z') }, // 23:30 IST
      [desk()],
      at('2026-08-26T18:31:00.000Z'), // 00:01 IST
    );

    expect(state.status).toBe('BREACHED');
    expect(state.breachedAt).toBe('2026-08-26T18:30:00.000Z'); // 00:00 IST
  });
});

describe('warning, breach and the settled outcome (§23.6)', () => {
  const startedAt = at('2026-08-26T04:30:00.000Z'); // 10:00 IST, team open

  it('warns at the configured percentage of the target, not before', () => {
    // D-25's warning threshold. §23.6: "notify the OWNER. Nothing else. Quiet nudge."
    const justUnder = slaState(target(), { startedAt }, [desk()], at('2026-08-26T04:53:00.000Z'));
    expect(justUnder.status).toBe('RUNNING'); // 23 min of 30 — under 80%

    const atWarning = slaState(target(), { startedAt }, [desk()], at('2026-08-26T04:54:00.000Z'));
    expect(atWarning.status).toBe('WARNING'); // 24 min = exactly 80%
  });

  it('breaches at the target and reports how late it is', () => {
    const state = slaState(target(), { startedAt }, [desk()], at('2026-08-26T05:10:00.000Z'));
    expect(state.status).toBe('BREACHED');
    // Ten minutes over — "late, and by how much".
    expect(state.remainingSeconds).toBe(-10 * 60);
    expect(state.breachedAt).toBe('2026-08-26T05:00:00.000Z');
  });

  it('keeps the breach instant after the case is answered late', () => {
    // §23.5: a breach is "a flag with a timestamp, not a deletion of the target". The
    // record must survive the answer, or "how late were we" stops being answerable.
    const state = slaState(
      target(),
      { startedAt, stoppedAt: at('2026-08-26T05:20:00.000Z') },
      [desk()],
      at('2026-08-27T09:00:00.000Z'),
    );
    expect(state.status).toBe('MISSED');
    expect(state.breachedAt).toBe('2026-08-26T05:00:00.000Z');
    expect(state.elapsedSeconds).toBe(50 * 60);
  });
});

describe('pause and resume — waiting on the customer (D-22)', () => {
  const startedAt = at('2026-08-26T04:30:00.000Z'); // 10:00 IST
  const resolution = target({ clock: 'RESOLUTION', targetSeconds: 4 * 3600 });

  it('does not count time spent waiting on the customer', () => {
    /**
     * D-22's confirmed behaviour: "does waiting on the customer stop the resolution
     * clock? (Proposal: yes — otherwise we are measured on their response time)".
     */
    const withoutPause = slaState(resolution, { startedAt }, [desk()], at('2026-08-26T07:30:00.000Z'));
    expect(withoutPause.elapsedSeconds).toBe(3 * 3600);

    const withPause = slaState(
      resolution,
      {
        startedAt,
        pauses: [{ from: at('2026-08-26T05:30:00.000Z'), to: at('2026-08-26T06:30:00.000Z') }],
      },
      [desk()],
      at('2026-08-26T07:30:00.000Z'),
    );
    expect(withPause.elapsedSeconds).toBe(2 * 3600);
  });

  it('does NOT pause the first-response clock', () => {
    // By the time anyone is waiting on the customer we have already replied, so that
    // clock has stopped. Applying the pause there would silently forgive a slow first
    // reply because the customer later went quiet.
    const firstResponse = target({ targetSeconds: 4 * 3600 });
    const state = slaState(
      firstResponse,
      {
        startedAt,
        pauses: [{ from: at('2026-08-26T05:30:00.000Z'), to: at('2026-08-26T06:30:00.000Z') }],
      },
      [desk()],
      at('2026-08-26T07:30:00.000Z'),
    );
    expect(state.elapsedSeconds).toBe(3 * 3600);
  });

  it('measures the pause on the SAME basis as the clock it pauses', () => {
    /**
     * A pause spanning a closed night must not subtract wall-clock hours from a
     * working-time total — that would hand back time the business never spent, and could
     * drive elapsed below zero. Here a pause runs from 18:00 one day to 11:00 the next:
     * one working hour before the close, one after the open, so two working hours.
     */
    const state = slaState(
      resolution,
      {
        startedAt,
        pauses: [{ from: at('2026-08-26T12:30:00.000Z'), to: at('2026-08-27T05:30:00.000Z') }],
      },
      [desk()],
      at('2026-08-27T07:30:00.000Z'), // 13:00 IST Thursday
    );

    // Gross working time: 9h Wednesday (10:00–19:00) + 3h Thursday = 12h. Minus a
    // two-working-hour pause = 10h.
    expect(state.elapsedSeconds).toBe(10 * 3600);
    expect(state.elapsedSeconds).toBeGreaterThan(0);
  });

  it('handles a pause that is still open', () => {
    // Waiting on the customer right now: the pause has no end, so it runs to the moment
    // being asked about and the clock stands still.
    const first = slaState(
      resolution,
      { startedAt, pauses: [{ from: at('2026-08-26T05:30:00.000Z') }] },
      [desk()],
      at('2026-08-26T06:30:00.000Z'),
    );
    const later = slaState(
      resolution,
      { startedAt, pauses: [{ from: at('2026-08-26T05:30:00.000Z') }] },
      [desk()],
      at('2026-08-26T08:30:00.000Z'),
    );
    expect(first.elapsedSeconds).toBe(1 * 3600);
    expect(later.elapsedSeconds).toBe(1 * 3600);
  });

  it('pushes the breach instant later by the time paused', () => {
    // A customer who took a day to reply must not have that day counted against us.
    const unpaused = slaState(resolution, { startedAt }, [desk()], at('2026-08-26T05:30:00.000Z'));
    const paused = slaState(
      resolution,
      {
        startedAt,
        pauses: [{ from: at('2026-08-26T04:45:00.000Z'), to: at('2026-08-26T05:15:00.000Z') }],
      },
      [desk()],
      at('2026-08-26T05:30:00.000Z'),
    );
    expect(Date.parse(paused.breachAt!)).toBeGreaterThan(Date.parse(unpaused.breachAt!));
  });
});

describe('retroactive re-derivation', () => {
  it('changes a past case’s verdict when a holiday is declared afterwards', () => {
    /**
     * The property that justifies computing rather than storing, and the exit criterion
     * §23.5 names. Nothing is migrated or backfilled here — the same question is asked of
     * a corrected calendar and the answer changes.
     *
     * A stored deadline would still hold the number it was given, and no amount of
     * correcting the calendar would move it.
     */
    const startedAt = at('2026-08-26T12:55:00.000Z'); // 18:25 IST Wednesday
    const askedAt = at('2026-08-27T04:40:00.000Z'); // 10:10 IST Thursday
    // A 40-minute target, so the correction changes the VERDICT and not merely a number.
    const fortyMinutes = target({ targetSeconds: 40 * 60 });

    // 35 min Wednesday (18:25→19:00) + 10 min Thursday (10:00→10:10) = 45 min. Breached.
    const before = slaState(fortyMinutes, { startedAt }, [desk()], askedAt);
    expect(before.elapsedSeconds).toBe(45 * 60);
    expect(before.status).toBe('BREACHED');

    // Thursday is declared a holiday after the fact — nobody was rostered, so the ten
    // minutes counted against us that morning never should have been.
    const corrected = slaState(fortyMinutes, { startedAt }, [desk({ holidays: ['2026-08-27'] })], askedAt);
    expect(corrected.elapsedSeconds).toBe(35 * 60);
    // A breach becomes a warning, on the next read, with nothing migrated.
    expect(corrected.status).toBe('WARNING');
    expect(corrected.breachedAt).toBeUndefined();
  });

  it('re-derives across a calendar VERSION change', () => {
    // Hours changed mid-case. Each version applies to its own effective period, so a case
    // spanning the change is measured against the hours that were actually in force.
    const v1 = desk({
      calendarId: 'v1',
      effectiveTo: at('2026-08-27T00:00:00.000Z'),
    });
    const v2 = desk({
      calendarId: 'v2',
      version: 2,
      effectiveFrom: at('2026-08-27T00:00:00.000Z'),
      // From Thursday the desk opens at 14:00 instead of 10:00.
      workingWindows: ([1, 2, 3, 4, 5] as Weekday[]).map((weekday) => ({
        weekday,
        openMinute: 14 * 60,
        closeMinute: 19 * 60,
      })),
    });

    const state = slaState(
      target({ targetSeconds: 4 * 3600 }),
      { startedAt: at('2026-08-26T13:00:00.000Z') }, // 18:30 IST Wednesday
      [v1, v2],
      at('2026-08-27T09:00:00.000Z'), // 14:30 IST Thursday
    );

    // 30 min Wednesday under v1 + 30 min Thursday under v2 (opens 14:00) = 1 hour.
    expect(state.elapsedSeconds).toBe(3600);
  });
});

describe('a case with no configured target has no clock', () => {
  it('selects nothing rather than inventing a default', () => {
    // §44.5 D-22: "None proposed… We will not invent these." A missing target must not
    // become a guessed one — that would be the business promising something nobody agreed.
    expect(selectTarget([], { categoryId: 'claims', teamId: 'claims' }, 'FIRST_RESPONSE')).toBeUndefined();
  });

  it('prefers a CATEGORY target over a TEAM one', () => {
    // D-22 permits both scopes, so something must choose. Most specific wins — the same
    // precedence `capacity_policies` uses for PRINCIPAL over TEAM.
    const scoped = [
      { ...target({ targetSeconds: 600 }), scopeKind: 'TEAM', scopeId: 'claims' },
      { ...target({ targetSeconds: 300 }), scopeKind: 'CATEGORY', scopeId: 'claims.new' },
    ];
    const chosen = selectTarget(scoped, { categoryId: 'claims.new', teamId: 'claims' }, 'FIRST_RESPONSE');
    expect(chosen?.targetSeconds).toBe(300);
  });

  it('falls back to the TEAM target when the category has none', () => {
    const scoped = [{ ...target({ targetSeconds: 600 }), scopeKind: 'TEAM', scopeId: 'claims' }];
    const chosen = selectTarget(scoped, { categoryId: 'claims.new', teamId: 'claims' }, 'FIRST_RESPONSE');
    expect(chosen?.targetSeconds).toBe(600);
  });

  it('does not cross clocks when selecting', () => {
    // A resolution target must never be used as a first-response one.
    const scoped = [
      { ...target({ clock: 'RESOLUTION', targetSeconds: 4 * 3600 }), scopeKind: 'TEAM', scopeId: 'claims' },
    ];
    expect(selectTarget(scoped, { teamId: 'claims' }, 'FIRST_RESPONSE')).toBeUndefined();
    expect(selectTarget(scoped, { teamId: 'claims' }, 'RESOLUTION')?.targetSeconds).toBe(4 * 3600);
  });
});

describe('clock skew does not produce nonsense', () => {
  it('never reports negative elapsed time', () => {
    // A stop stamped before the start is two clocks disagreeing (ADR-025), not a
    // conversation answered before it arrived.
    const state = slaState(
      target({ basis: 'CALENDAR_24X7' }),
      { startedAt: at('2026-08-26T05:00:00.000Z'), stoppedAt: at('2026-08-26T04:59:00.000Z') },
      [desk()],
      at('2026-08-26T06:00:00.000Z'),
    );
    expect(state.elapsedSeconds).toBe(0);
    expect(state.status).toBe('MET');
  });
});
