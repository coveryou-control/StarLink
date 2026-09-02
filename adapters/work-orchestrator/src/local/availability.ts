/**
 * Employee availability (doc §21.9).
 *
 * The load-bearing rule, stated by the document twice: **availability is declared or
 * derived from the calendar. It is never inferred from a socket.** A dropped realtime
 * connection must not mean an employee is unavailable — "a phone entering a lift is not
 * leave" — and a network hiccup must never reassign anybody's work.
 *
 * That rule is enforced here STRUCTURALLY rather than by discipline: {@link
 * AvailabilityFacts} has no field for a socket, a heartbeat, a presence lease or a
 * last-seen time. There is nothing to pass, so there is nothing to accidentally consult.
 * A future contributor who wants to weigh presence has to change this type, which is a
 * conversation rather than a one-line edit.
 *
 * Presence still exists and is still useful — it tells a colleague whether someone is
 * likely to answer right now. It just has no vote in who owns work.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';

/**
 * Everything that may legitimately decide availability, and nothing else.
 *
 * Each field maps to a row of §21.9's table. `capacity` is optional because the
 * workload ceiling is D-05 — an unanswered business question — and a system that
 * invented one would be inventing a staffing policy.
 */
export interface AvailabilityFacts {
  readonly principalId: UUID;
  /** The team's business calendar (§23.1). Nobody is available outside their window. */
  readonly teamCalendarOpen: boolean;
  /** A deactivated account cannot own work (BR-13). */
  readonly accountActive: boolean;
  /** Leave, off-shift — an explicit, human-entered fact. */
  readonly onDeclaredAbsence: boolean;
  /** A deliberate declaration by the employee or a lead. */
  readonly explicitlyUnavailable: boolean;
  /**
   * Present only when a ceiling has been configured (D-05). `undefined` means no
   * position has been taken, and no ceiling is enforced — NOT a ceiling of zero.
   */
  readonly capacity?: { readonly openConversations: number; readonly ceiling: number };
}

export type UnavailableReason =
  | 'TEAM_CLOSED'
  | 'ACCOUNT_INACTIVE'
  | 'DECLARED_ABSENCE'
  | 'EXPLICITLY_UNAVAILABLE'
  | 'AT_CAPACITY';

export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: UnavailableReason };

/**
 * Ordered so the reason returned is the most fundamental one.
 *
 * An employee on leave whose team is also closed reads as TEAM_CLOSED, because that is
 * the fact a lead needs first — the whole team is shut, not one person missing. Ordering
 * matters because this reason is surfaced to a human deciding what to do about it.
 */
export function assessAvailability(facts: AvailabilityFacts): Availability {
  if (!facts.teamCalendarOpen) return { available: false, reason: 'TEAM_CLOSED' };
  if (!facts.accountActive) return { available: false, reason: 'ACCOUNT_INACTIVE' };
  if (facts.onDeclaredAbsence) return { available: false, reason: 'DECLARED_ABSENCE' };
  if (facts.explicitlyUnavailable) return { available: false, reason: 'EXPLICITLY_UNAVAILABLE' };

  // Capacity is checked last and only when configured. `>=` because a ceiling of N
  // means N is the maximum held, not the threshold to exceed.
  if (facts.capacity !== undefined && facts.capacity.openConversations >= facts.capacity.ceiling) {
    return { available: false, reason: 'AT_CAPACITY' };
  }

  return { available: true };
}

/** A candidate the router may assign to, with the facts that decided it. */
export interface Candidate {
  readonly principalId: UUID;
  readonly availability: Availability;
  /** For audit: why this person was considered at all. */
  readonly basis: 'DESIGNATED' | 'NAMED_BACKUP' | 'TEAM_MEMBER';
}

export const isAvailable = (candidate: Candidate): boolean => candidate.availability.available;

/**
 * A declared absence, as the store returns it.
 *
 * Dated rather than boolean so "was A available last Tuesday" stays answerable — the
 * same discipline as participation and role grants (§17.3).
 */
export interface DeclaredAbsence {
  readonly principalId: UUID;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly kind: string;
}

export const absenceCovers = (absence: DeclaredAbsence, at: Timestamp): boolean =>
  absence.effectiveFrom <= at && (absence.effectiveTo === undefined || absence.effectiveTo > at);
