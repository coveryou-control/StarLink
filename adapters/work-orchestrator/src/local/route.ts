/**
 * The routing decision tree (doc §21.8, diagram 19).
 *
 * "No random selection at any point. Every branch is deterministic and inspectable."
 * So this is a pure function over stated facts, returning a decision that carries the
 * path it took — a lead asking "why did this go to the queue instead of to Priya?"
 * gets an answer from the decision itself rather than from a log archaeology exercise.
 *
 * The five steps, exactly as the diagram has them:
 *
 *   1. Is the team for this category OPEN? (business calendar §23.1)
 *      → NO: after-hours queue. Acknowledged, NO clock started (§23.5).
 *   2. Is the category relationship-shaped? (D-17)
 *      → NO: team queue, oldest first within priority band.
 *   3. Does this customer have a DESIGNATED employee? (D-19)
 *      → NO: team queue.
 *   4. Is the designated employee AVAILABLE? (§21.9)
 *      → YES: assign to them.
 *   5. → NO: fallback policy (D-05) — named backup, team queue, or lead reassigns.
 *
 * And the branch the document cares most about: when step 5 is exhausted and nobody is
 * available anywhere — Grievance is one person — the conversation "stays QUEUED and
 * VISIBLY UNANSWERED. Never silently held." That is an organisational single point of
 * failure, "which the software's job is to make undeniable rather than to hide."
 *
 * ## What this function does NOT decide
 *
 * Which categories are relationship-shaped (D-17), where a designated employee comes
 * from (D-19), the fallback policy (D-05) and any capacity ceiling (D-05) are all
 * business decisions. They arrive as INPUTS. Nothing here has a default for them,
 * because a default would be an invented business value wearing a sensible-looking hat.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { isAvailable, type Candidate } from './availability.js';

/** The fallback ladder when a designated employee is unavailable (D-05). */
export type FallbackPolicy =
  /** Try a named backup, then the team queue. */
  | { readonly kind: 'NAMED_BACKUP'; readonly backup: Candidate }
  /** Straight to the team queue — the safe default a business may still choose. */
  | { readonly kind: 'TEAM_QUEUE' }
  /** Hold for a lead to place by hand. Still queued and still visible. */
  | { readonly kind: 'LEAD_REASSIGNS'; readonly leadId: UUID };

export interface RoutingInputs {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  /** Absent when the customer did not choose one (§21.5 permits that). */
  readonly categoryId?: string;
  /** The team this category maps to (D-17). Absent means the mapping is unconfigured. */
  readonly teamId?: string;
  /** From the team's business calendar (§23.1). Phase 6 supplies the calendar itself. */
  readonly teamCalendarOpen: boolean;
  /** D-17. Renewals is relationship-shaped; Fresh Sales is queue-shaped. */
  readonly categoryIsRelationshipShaped: boolean;
  /** D-19. A new prospect has none, and that is normal, not an error. */
  readonly designated?: Candidate;
  readonly fallback: FallbackPolicy;
  readonly at: Timestamp;
}

/** Every step the decision passed through, in order. Carried for audit and for humans. */
export type RoutingStep =
  | 'TEAM_CLOSED'
  | 'TEAM_OPEN'
  | 'QUEUE_SHAPED_CATEGORY'
  | 'RELATIONSHIP_SHAPED_CATEGORY'
  | 'NO_DESIGNATED_EMPLOYEE'
  | 'DESIGNATED_AVAILABLE'
  | 'DESIGNATED_UNAVAILABLE'
  | 'FALLBACK_NAMED_BACKUP'
  | 'FALLBACK_BACKUP_UNAVAILABLE'
  | 'FALLBACK_TEAM_QUEUE'
  | 'FALLBACK_LEAD_REASSIGNS'
  | 'NO_TEAM_CONFIGURED';

export type RoutingDecision =
  /**
   * Assign now. The designated employee is UNCHANGED by this — assignment sets the
   * current owner, and cover never destroys the relationship (§21.7).
   */
  | {
      readonly outcome: 'ASSIGN';
      readonly ownerId: UUID;
      readonly basis: Candidate['basis'];
      readonly path: readonly RoutingStep[];
    }
  /** Waiting for someone to claim. Oldest first within a priority band. */
  | {
      readonly outcome: 'QUEUE';
      readonly teamId: string;
      /** After hours: acknowledged, and NO SLA clock starts until opening (§23.5). */
      readonly afterHours: boolean;
      readonly path: readonly RoutingStep[];
    }
  /**
   * Queued and VISIBLY UNANSWERED (§21.8).
   *
   * Not an error and not a silent hold. It means the organisation has nobody for this
   * work right now, and the product's job is to say so — to a lead, and in the
   * `unanswered` metric — rather than to absorb it.
   */
  | {
      readonly outcome: 'UNROUTABLE';
      readonly teamId?: string;
      readonly escalateTo?: UUID;
      readonly path: readonly RoutingStep[];
    };

export function route(inputs: RoutingInputs): RoutingDecision {
  const path: RoutingStep[] = [];

  // A category with no team mapping cannot be queued anywhere. Refusing loudly beats
  // inventing a destination — routing to "some team" is how work disappears.
  if (inputs.teamId === undefined) {
    path.push('NO_TEAM_CONFIGURED');
    return { outcome: 'UNROUTABLE', path };
  }
  const teamId = inputs.teamId;

  // ── 1. Is the team open? ────────────────────────────────────────────────────────
  if (!inputs.teamCalendarOpen) {
    path.push('TEAM_CLOSED');
    // Queued, acknowledged, no clock. Re-enters the tree at step 1 on opening.
    return { outcome: 'QUEUE', teamId, afterHours: true, path };
  }
  path.push('TEAM_OPEN');

  // ── 2. Relationship-shaped? ─────────────────────────────────────────────────────
  if (!inputs.categoryIsRelationshipShaped) {
    path.push('QUEUE_SHAPED_CATEGORY');
    return { outcome: 'QUEUE', teamId, afterHours: false, path };
  }
  path.push('RELATIONSHIP_SHAPED_CATEGORY');

  // ── 3. Designated employee? ─────────────────────────────────────────────────────
  if (inputs.designated === undefined) {
    path.push('NO_DESIGNATED_EMPLOYEE');
    return { outcome: 'QUEUE', teamId, afterHours: false, path };
  }

  // ── 4. Available? ───────────────────────────────────────────────────────────────
  if (isAvailable(inputs.designated)) {
    path.push('DESIGNATED_AVAILABLE');
    return {
      outcome: 'ASSIGN',
      ownerId: inputs.designated.principalId,
      basis: 'DESIGNATED',
      path,
    };
  }
  path.push('DESIGNATED_UNAVAILABLE');

  // ── 5. Fallback (D-05) ──────────────────────────────────────────────────────────
  switch (inputs.fallback.kind) {
    case 'NAMED_BACKUP': {
      if (isAvailable(inputs.fallback.backup)) {
        path.push('FALLBACK_NAMED_BACKUP');
        return {
          outcome: 'ASSIGN',
          ownerId: inputs.fallback.backup.principalId,
          basis: 'NAMED_BACKUP',
          path,
        };
      }
      // The backup is out too. Fall through to the queue rather than giving up: a
      // named backup is a preference, not the only remaining option.
      path.push('FALLBACK_BACKUP_UNAVAILABLE');
      return { outcome: 'QUEUE', teamId, afterHours: false, path };
    }

    case 'TEAM_QUEUE':
      path.push('FALLBACK_TEAM_QUEUE');
      return { outcome: 'QUEUE', teamId, afterHours: false, path };

    case 'LEAD_REASSIGNS':
      path.push('FALLBACK_LEAD_REASSIGNS');
      // Still queued and still visible — a lead placing it by hand is a human step, not
      // a reason to hide the work while waiting.
      return {
        outcome: 'UNROUTABLE',
        teamId,
        escalateTo: inputs.fallback.leadId,
        path,
      };
  }
}
