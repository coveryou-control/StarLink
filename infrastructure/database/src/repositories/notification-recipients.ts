/**
 * Who a notification actually goes to (doc §29.2).
 *
 * §29.2's table names ROLES — "Owner", "Owner, then lead", "Receiving officer", "Both
 * parties", "Team". The outbox stores PRINCIPALS. Something has to turn one into the
 * other, and this is it.
 *
 * That translation is deliberately a database read rather than a value the caller passes
 * in. A caller that already knows who the owner is has usually just changed it, and the
 * one it remembers is as likely to be the previous holder as the current one — which is
 * exactly the notification that goes to the wrong person and is never noticed, because
 * nobody complains about a notification they did not receive.
 *
 * ## What is deliberately absent
 *
 * There is no `membersOf(team)`. §29.2's two team-scope rows (cover needed, new in the
 * team queue) have a recipient that is not a principal, and fanning them out to every
 * member would write one row per member per event — the storm §29.5's coalescing exists
 * to prevent, manufactured on purpose. That needs a recipient model and a decision about
 * whether a team notification is per-person or a shared badge; neither exists, so this
 * refuses to guess. `identity.team_memberships` would make the query easy and the answer
 * wrong.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export class PgNotificationRecipients {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The current owner, from the ownership episode that has not ended.
   *
   * Read from `ownership_episodes` rather than `service_cases.current_owner_id` because
   * the episode table is where the invariant lives — one open episode per conversation,
   * enforced by the exclusion constraint (BR-11). `current_owner_id` is a denormalised
   * convenience maintained alongside it; reading the constrained table means a
   * notification cannot be addressed to an owner the constraint says is not the owner.
   */
  async ownerOf(conversationId: UUID): Promise<UUID | undefined> {
    const result = await this.pool.query(
      `SELECT owner_id FROM conversation.ownership_episodes
        WHERE conversation_id = $1 AND effective_to IS NULL
        LIMIT 1`,
      [conversationId],
    );
    return result.rows[0]?.owner_id as UUID | undefined;
  }

  /**
   * The customer on a conversation — §29.2's one non-staff recipient row.
   *
   * Read from `participants` rather than from `conversations.customer_ref`, because
   * `customer_ref` is a CanonicalRef into whatever system owns the customer and is not a
   * StarLink principal id; the outbox stores principal ids. A conversation has exactly one
   * customer participant, but the LIMIT is here rather than assumed — a notification
   * addressed to the wrong one of two would be a cross-customer leak, which is the one
   * failure §27.3 will not tolerate degrading gracefully.
   *
   * Bounded by the application clock at both ends (ADR-025), like every other
   * effective-dated read: a participation row that a differently-set database clock
   * considers not-yet-live would silently return nobody.
   */
  async customerOf(conversationId: UUID, at: Timestamp): Promise<UUID | undefined> {
    const result = await this.pool.query(
      `SELECT principal_id
         FROM conversation.participants
        WHERE conversation_id = $1
          AND principal_kind = 'CUSTOMER'
          AND effective_from <= $2
          AND (effective_to IS NULL OR effective_to > $2)
        LIMIT 1`,
      [conversationId, at],
    );
    return result.rows[0]?.principal_id as UUID | undefined;
  }

  /** The team that owns the case behind this conversation, for the lead lookup. */
  async teamOf(conversationId: UUID): Promise<string | undefined> {
    const result = await this.pool.query(
      `SELECT sc.owning_team_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    return (result.rows[0]?.owning_team_id as string | null | undefined) ?? undefined;
  }

  /**
   * The live team leads.
   *
   * Read from `identity.role_assignments`, not from `team_memberships.role`, because the
   * role grant is what `decide()` reads — so "the lead" here is the same person the
   * authorization ladder would let act on the team's work. Two sources for one fact is
   * how the notification goes to somebody the system would then refuse.
   *
   * Bounded by the clock at BOTH ends and stamped by the application (ADR-025), for the
   * same reason participation is: a grant read against the database's clock on a machine
   * whose clock differs is a grant that is live to one query and not to the next.
   *
   * Inactive principals are excluded. Emailing a leaver about a breach is noise at best;
   * at worst it is a notification about work nobody is looking at, which reads as
   * coverage that does not exist.
   */
  async leadsOfTeam(teamId: string, at: Timestamp): Promise<readonly UUID[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ra.principal_id
         FROM identity.role_assignments ra
         JOIN identity.principals p ON p.principal_id = ra.principal_id
        WHERE ra.role = 'TEAM_LEAD'
          AND ra.scope_kind = 'TEAM'
          AND ra.scope_id = $1
          AND ra.effective_from <= $2
          AND (ra.effective_to IS NULL OR ra.effective_to > $2)
          AND p.status = 'ACTIVE'`,
      [teamId, at],
    );
    return result.rows.map((row) => row.principal_id as UUID);
  }
}
