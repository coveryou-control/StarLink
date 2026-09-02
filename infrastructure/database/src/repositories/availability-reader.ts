/**
 * The facts §21.9 permits for an availability decision, read from the database.
 *
 * Deliberately narrow. `AvailabilityFacts` (in the Local orchestrator, alongside the
 * §21.8 tree it feeds) has no field for a
 * socket, a heartbeat or a last-seen time, so this reader has nothing of that kind to
 * supply — "availability is declared or derived from the calendar. It is never inferred
 * from a socket."
 *
 * Two facts it does NOT source, and cannot:
 *
 *   * **The team calendar** is Phase 6 and its hours are an unanswered business question
 *     (D-20/D-21). It arrives as a parameter, which is correct layering as well as
 *     honest: whether a team is open is a question about a calendar, not about a person.
 *   * **The designated employee** comes from D-19 — CRM, policy system, prior history or
 *     manual assignment. The column exists on the case; who fills it does not.
 *
 * Capacity IS sourced here, because it is a fact about live reservations rather than a
 * policy: the ceiling is configuration, the current load is a query.
 *
 * ## What "load" currently measures, and what it does not — N-17
 *
 * The sum below counts LIVE reservations, which is what migration 0004 declares the
 * capacity answer to be. Nothing releases a reservation when the work finishes: the
 * contract has `release()`, and no code path calls it, because conversation resolve and
 * close arrive in Phase 6. So a hold lapses on its TTL — 120 seconds by default — while
 * the conversation it was taken for is still open and still owned.
 *
 * The consequence is worth stating plainly rather than discovering later: this measures
 * SIMULTANEOUS PLACEMENT, not sustained workload. Two conversations routed to the same
 * person at once cannot both land against a ceiling of one; two routed ten minutes apart
 * can. Raising the TTL moves the cliff without removing it — the fix is to end the hold
 * when the work ends, which is Phase 6's to make possible.
 */
import { effectiveCapacityUnits } from './capacity-scope.js';
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export interface PrincipalAvailabilityFacts {
  readonly principalId: UUID;
  readonly accountActive: boolean;
  readonly onDeclaredAbsence: boolean;
  readonly explicitlyUnavailable: boolean;
  /** Present only when a ceiling is configured (D-05). Absent means no ceiling. */
  readonly capacity?: { readonly openConversations: number; readonly ceiling: number };
}

export class PgAvailabilityReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Reads what the database knows about one principal's availability.
   *
   * Load is measured as the sum of LIVE reservation weights, not a count of
   * conversations. A claim conversation costs more than a renewal question (brief §12:
   * never a hard-coded "5 chats"), and a sum over rows cannot drift the way a
   * maintained counter does.
   */
  async factsFor(principalId: UUID, at: Timestamp): Promise<PrincipalAvailabilityFacts> {
    const result = await this.pool.query(
      `SELECT p.status,
              COALESCE((
                SELECT sum(r.weight)::int FROM conversation.reservations r
                 WHERE r.principal_id = p.principal_id
                   AND r.released_at IS NULL
                   AND r.expires_at > $2
              ), 0) AS load,
              ${effectiveCapacityUnits('p.principal_id::text')} AS ceiling
         FROM identity.principals p
        WHERE p.principal_id = $1`,
      [principalId, at],
    );

    const row = result.rows[0];
    if (row === undefined) {
      // An unknown principal is not available. Fail closed: the alternative is routing
      // work to somebody who does not exist.
      return {
        principalId,
        accountActive: false,
        onDeclaredAbsence: false,
        explicitlyUnavailable: false,
      };
    }

    const ceiling = row.ceiling as number | null;

    return {
      principalId,
      accountActive: row.status === 'ACTIVE',
      // Declared absence and explicit unavailability are human-entered facts with no
      // table yet — leave, off-shift and "unavailable" are D-05, and inventing a
      // storage shape for an undecided policy is how the policy gets decided by
      // accident. Reported as false rather than guessed.
      onDeclaredAbsence: false,
      explicitlyUnavailable: false,
      // No configured ceiling means NO ceiling, not a ceiling of zero — which would
      // make everyone permanently unavailable the moment they held one thread.
      ...(ceiling !== null ? { capacity: { openConversations: row.load as number, ceiling } } : {}),
    };
  }

  /** The designated advisor for a case, if the business has recorded one (D-19). */
  async designatedEmployee(conversationId: UUID): Promise<UUID | undefined> {
    const result = await this.pool.query(
      `SELECT sc.designated_employee_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    return (result.rows[0]?.designated_employee_id as UUID | null) ?? undefined;
  }
}
