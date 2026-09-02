/**
 * SLA state, computed on read (doc §23.5, §23.6, §24.11).
 *
 * §23.5's first rule governs the whole file: **"The clock is computed, never stored as a
 * countdown."** What IS stored is the observations — when the clock started, when it
 * stopped, and its pause spans (§24.11's *SLA State* entity). Everything derived from
 * them is computed here, every time, so that:
 *
 *   * *"A holiday added retrospectively re-derives correctly"* — the correction lands in
 *     the calendar and the next read is right, with no backfill to remember.
 *   * *"Pause and resume are calendar-driven. No job needs to have run for the arithmetic
 *     to be right"* — a night when the sweep did not run leaves nothing wrong.
 *
 * ## The three clocks and what stops each
 *
 * | Clock | Starts | Stops | Question |
 * |---|---|---|---|
 * | First response | the customer's first message becomes routable | a human replies on the customer-visible channel | *Did anyone answer this person?* |
 * | Resolution | same as first response | the case reaches resolved | *Did we finish?* |
 * | Escalation | on escalation | the receiving function makes first contact | *Did the specialist pick it up?* |
 *
 * Two details from §23.5 that are easy to get wrong and are enforced below:
 *
 * **"An internal note does not stop the first-response clock."** Only a message the
 * customer can actually see counts — otherwise the metric measures internal activity
 * rather than service. The caller supplies `firstCustomerVisibleReplyAt`, and the name is
 * deliberately unwieldy so nobody passes it the wrong timestamp.
 *
 * **The start is not the arrival.** *"The customer's first message becomes routable —
 * immediately if open, at opening if after hours."* §23.5's case B is explicit: a message
 * at 23:30 is persisted, acknowledged and queued with the CLOCK NOT STARTED; it starts at
 * 10:00. Starting it on arrival would breach every overnight enquiry before anyone was
 * rostered to read it.
 *
 * ## Pauses
 *
 * Two kinds, and they are different in nature:
 *
 *   * **Calendar pauses** are implicit. Business-hours clocks count working time, so
 *     closed hours never contribute — there is nothing to subtract.
 *   * **Waiting on the customer** is an explicit pause on the RESOLUTION clock only
 *     (D-22, proposal accepted: *"otherwise we are measured on their response time"*). It
 *     does not pause first response, because by then we have already replied and that
 *     clock has stopped.
 */
import type { Timestamp } from '@starlink/shared-contracts';
import type { BusinessCalendar } from './calendar.js';
import { elapsedWorkingSeconds, instantAfterWorkingSeconds } from './clock.js';

/** §23.5's three clocks. Mirrors the `sla_clock_check` constraint in migration 0001. */
export type SlaClock = 'FIRST_RESPONSE' | 'RESOLUTION' | 'ESCALATION';

/** §23.2's promise models, as stored. Mirrors `sla_basis_check`. */
export type SlaBasis = 'BUSINESS_HOURS' | 'CALENDAR_24X7';

export interface SlaTarget {
  readonly clock: SlaClock;
  readonly targetSeconds: number;
  readonly basis: SlaBasis;
  /**
   * The warning threshold as a percentage of the target (D-25). §23.6: at
   * `target × warning threshold`, "notify the OWNER. Nothing else. Quiet nudge."
   */
  readonly warningPct: number;
  /** Carried so a surface can say the target is not signed off (§68 gate 8). */
  readonly provisional: boolean;
}

/** A span during which the resolution clock was paused, half-open `[from, to)`. */
export interface PauseSpan {
  readonly from: Timestamp;
  /** Absent while still paused. */
  readonly to?: Timestamp;
}

export interface ClockFacts {
  /**
   * When the clock STARTED — already resolved by the caller to "became routable".
   *
   * Absent means it has not started: an after-hours arrival before the team opens, or an
   * escalation clock on a case nobody has escalated. That is `NOT_STARTED`, not zero
   * elapsed, and the difference matters — zero looks like a clock running perfectly.
   */
  readonly startedAt?: Timestamp;
  /** When it stopped. Absent means still running. */
  readonly stoppedAt?: Timestamp;
  /** Resolution-clock pauses only. Ignored for the other two clocks. */
  readonly pauses?: readonly PauseSpan[];
}

export type SlaStatus =
  /** No clock is running: after hours before opening, or never escalated. */
  | 'NOT_STARTED'
  | 'RUNNING'
  /** Past `target × warningPct` and not yet breached. §23.6: notify the owner only. */
  | 'WARNING'
  | 'BREACHED'
  /** Answered or resolved inside the target. */
  | 'MET'
  /** Answered or resolved, but late. "Late, and by how much" stays answerable. */
  | 'MISSED';

export interface SlaState {
  readonly clock: SlaClock;
  readonly status: SlaStatus;
  /** Working seconds counted so far, or to the stop. Zero when not started. */
  readonly elapsedSeconds: number;
  readonly targetSeconds: number;
  /** Negative once the target is passed — "by how much" (§23.5). */
  readonly remainingSeconds: number;
  /**
   * When the target was, or will be, crossed. Computed by walking the calendar forward,
   * so it is the real instant rather than `start + target` on a wall clock.
   *
   * Absent when the clock has not started, or when the horizon contains no working time
   * in which to breach.
   */
  readonly breachAt?: Timestamp;
  /** Set once the breach instant has passed. §23.5: a flag WITH a timestamp. */
  readonly breachedAt?: Timestamp;
  readonly provisional: boolean;
}

/** Sums pause time that falls inside the measured window, on the clock's own basis. */
function pausedSeconds(
  pauses: readonly PauseSpan[],
  windowFrom: Timestamp,
  windowTo: Timestamp,
  basis: SlaBasis,
  calendars: readonly BusinessCalendar[],
): number {
  let total = 0;
  for (const pause of pauses) {
    const from = Date.parse(pause.from) < Date.parse(windowFrom) ? windowFrom : pause.from;
    const to =
      pause.to === undefined || Date.parse(pause.to) > Date.parse(windowTo) ? windowTo : pause.to;
    if (Date.parse(to) <= Date.parse(from)) continue;

    // Measured on the SAME basis as the clock it pauses. Subtracting wall-clock hours
    // from a working-time total would remove a whole weekend from a clock that never
    // counted it, and hand back time the business never spent.
    total +=
      basis === 'CALENDAR_24X7'
        ? (Date.parse(to) - Date.parse(from)) / 1000
        : elapsedWorkingSeconds(calendars, from, to);
  }
  return Math.round(total);
}

/**
 * Computes one clock's state.
 *
 * Pure, and reads nothing it was not given — which is what makes the whole model
 * re-derivable. Hand it a corrected calendar and it returns a corrected answer.
 */
export function slaState(
  target: SlaTarget,
  facts: ClockFacts,
  calendars: readonly BusinessCalendar[],
  at: Timestamp,
): SlaState {
  const base = {
    clock: target.clock,
    targetSeconds: target.targetSeconds,
    provisional: target.provisional,
  };

  if (facts.startedAt === undefined) {
    return {
      ...base,
      status: 'NOT_STARTED',
      elapsedSeconds: 0,
      remainingSeconds: target.targetSeconds,
    };
  }

  const stopped = facts.stoppedAt !== undefined;
  const measureTo = facts.stoppedAt ?? at;

  // Never negative: a stop stamped before the start is clock skew (ADR-025), not a
  // conversation answered before it arrived.
  const gross =
    target.basis === 'CALENDAR_24X7'
      ? Math.max(0, (Date.parse(measureTo) - Date.parse(facts.startedAt)) / 1000)
      : elapsedWorkingSeconds(calendars, facts.startedAt, measureTo);

  // Pauses apply to the resolution clock only. First response has already stopped by the
  // time anyone is waiting on the customer, and the escalation clock measures the
  // specialist's pickup, which the customer cannot pause.
  const paused =
    target.clock === 'RESOLUTION' && facts.pauses !== undefined && facts.pauses.length > 0
      ? pausedSeconds(facts.pauses, facts.startedAt, measureTo, target.basis, calendars)
      : 0;

  const elapsedSeconds = Math.max(0, Math.round(gross) - paused);
  const remainingSeconds = target.targetSeconds - elapsedSeconds;

  /**
   * The breach instant, computed forward from the start.
   *
   * Pauses shift it later, so the target is extended by whatever has been paused so far.
   * That is an approximation while a pause is OPEN — nobody knows when the customer will
   * reply — and it is exact once the clock stops. Stated rather than hidden: the value is
   * a projection while running and a fact once settled.
   */
  const effectiveTarget = target.targetSeconds + paused;
  const breachAt =
    target.basis === 'CALENDAR_24X7'
      ? (new Date(Date.parse(facts.startedAt) + effectiveTarget * 1000).toISOString() as Timestamp)
      : instantAfterWorkingSeconds(calendars, facts.startedAt, effectiveTarget);

  const overTarget = elapsedSeconds >= target.targetSeconds;

  if (stopped) {
    return {
      ...base,
      status: overTarget ? 'MISSED' : 'MET',
      elapsedSeconds,
      remainingSeconds,
      ...(breachAt !== undefined ? { breachAt } : {}),
      // A settled miss keeps its breach instant: §23.5 requires "late, and by how much"
      // to stay answerable after the fact, not only while it is happening.
      ...(overTarget && breachAt !== undefined ? { breachedAt: breachAt } : {}),
    };
  }

  if (overTarget) {
    return {
      ...base,
      status: 'BREACHED',
      elapsedSeconds,
      remainingSeconds,
      ...(breachAt !== undefined ? { breachAt, breachedAt: breachAt } : {}),
    };
  }

  const warningAt = (target.targetSeconds * target.warningPct) / 100;
  return {
    ...base,
    status: elapsedSeconds >= warningAt ? 'WARNING' : 'RUNNING',
    elapsedSeconds,
    remainingSeconds,
    ...(breachAt !== undefined ? { breachAt } : {}),
  };
}

/**
 * Picks the target that applies, most specific first.
 *
 * D-22 allows targets "per category or per team", so both scopes may hold a row and
 * something has to choose. CATEGORY wins over TEAM, matching how `capacity_policies`
 * already resolves PRINCIPAL over TEAM — a rule stated once and applied the same way in
 * both places is easier to reason about than two subtly different precedences.
 *
 * Returns `undefined` when nothing is configured. There is NO fallback target: §44.5 D-22
 * says "None proposed… We will not invent these", so a case with no configured target has
 * no clock rather than a guessed one.
 */
export function selectTarget(
  targets: readonly (SlaTarget & { scopeKind: string; scopeId: string })[],
  scope: { categoryId?: string; teamId?: string },
  clock: SlaClock,
): SlaTarget | undefined {
  const forClock = targets.filter((t) => t.clock === clock);
  return (
    forClock.find((t) => t.scopeKind === 'CATEGORY' && t.scopeId === scope.categoryId) ??
    forClock.find((t) => t.scopeKind === 'TEAM' && t.scopeId === scope.teamId)
  );
}
