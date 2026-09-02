/**
 * "Is this team open right now?" (doc §23.1, §23.3).
 *
 * A thin composition: the calendar arithmetic is in `@starlink/sla`, the rows are in
 * `PgBusinessCalendarReader`, and what lives here is the one judgement neither of them
 * is allowed to make — **what to do when a team has no calendar at all.**
 *
 * ## Why an unconfigured team is treated as AFTER_HOURS
 *
 * §23.1 refuses to default the hours: *"Inventing '10:00–19:00, Monday to Saturday' would
 * be inventing a business fact."* So the reader returns an empty history and the clock
 * returns `UNKNOWN`. But `RoutingContext.businessHoursState` is `OPEN | AFTER_HOURS` —
 * the contract has no third state, and something has to be sent.
 *
 * AFTER_HOURS is the honest reduction, for the reason §23.2 gives: after-hours
 * acknowledgement *"promises nothing but honesty"* and costs nothing, while OPEN starts
 * an SLA clock and tells a customer a human is reading. We do not know that anybody is
 * rostered — nobody has said — so we must not imply it. §23.3's invariant still holds:
 * the conversation is queued, appears in the queue view, and is counted by the unassigned
 * metric exactly like any other waiting work. Nothing is lost and nothing is hidden; the
 * only thing withheld is a promise we have no basis for.
 *
 * This is fail-closed in the same sense as rule 4 — an unknown permission is denied — and
 * it is deliberately NOT silent: {@link teamsWithoutCalendar} exists so the gap shows up
 * as a number rather than as a team that mysteriously never gets routed work.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PgBusinessCalendarReader } from '@starlink/database';
import { openStateOf, versionAt, nextOpening, type BusinessCalendar } from '@starlink/sla';
import type { Timestamp } from '@starlink/shared-contracts';
import { CALENDAR_READER } from '../tokens.js';

export interface BusinessHoursAnswer {
  /** What the routing contract needs. */
  readonly state: 'OPEN' | 'AFTER_HOURS';
  /**
   * Why — kept separate from `state` so "shut for the night" and "nobody has told us the
   * hours" stay distinguishable everywhere downstream, even though both route the same.
   */
  readonly basis: 'CALENDAR_OPEN' | 'CALENDAR_CLOSED' | 'NO_CALENDAR';
  /** True when the answer came from a calendar still awaiting sign-off (D-20/D-21). */
  readonly provisional: boolean;
  /** When the team next opens, where that is knowable. Never a promise of a reply. */
  readonly opensAt?: Timestamp;
}

@Injectable()
export class BusinessHours {
  constructor(@Inject(CALENDAR_READER) private readonly calendars: PgBusinessCalendarReader) {}

  async stateFor(teamId: string, at: Date): Promise<BusinessHoursAnswer> {
    const history = await this.calendars.historyFor(teamId);
    return this.decide(history, at);
  }

  /**
   * The pure half, exposed so it can be tested without a database and reused by a caller
   * that already holds the history.
   */
  decide(history: readonly BusinessCalendar[], at: Date): BusinessHoursAnswer {
    if (history.length === 0) {
      return { state: 'AFTER_HOURS', basis: 'NO_CALENDAR', provisional: false };
    }

    const stamp = at.toISOString() as Timestamp;
    const active = versionAt(history, stamp);
    const open = openStateOf(active, at);
    const provisional = active?.provisional ?? false;

    if (open === 'OPEN') {
      return { state: 'OPEN', basis: 'CALENDAR_OPEN', provisional };
    }

    // A version GAP — the team has calendar rows, but none covers this instant — reports
    // NO_CALENDAR rather than CALENDAR_CLOSED. Both route identically; the distinction is
    // for whoever has to fix it, and "no declared hours cover right now" is a different
    // repair from "we are shut tonight".
    const opensAt = nextOpening(history, stamp);
    return {
      state: 'AFTER_HOURS',
      basis: active === undefined ? 'NO_CALENDAR' : 'CALENDAR_CLOSED',
      provisional,
      ...(opensAt !== undefined ? { opensAt } : {}),
    };
  }
}
