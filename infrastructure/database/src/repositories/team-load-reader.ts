/**
 * What a team's work looks like right now (SL-083, doc O-07).
 *
 * O-07 states the outcome plainly: *"Leadership can see load and waiting customers —
 * queue and workload visible without a report request."* Grafana already carries the
 * operational series, but a dashboard behind an ops login is not "without a report
 * request" for a team lead, and the tracker row asks for waiting, ownership, SLA and
 * capacity together in the product.
 *
 * ## Aggregated in the database, not in the browser
 *
 * The alternative was to page the queue, then fetch each conversation's SLA one call at a
 * time. That is N+1 over exactly the screen someone opens when the team is busiest, which
 * is the worst possible moment to multiply reads. One grouped read answers all four
 * questions.
 *
 * ## The SLA column of SL-083 is deliberately absent
 *
 * The tracker row names "waiting, ownership, SLA, capacity", and three of those are here.
 * SLA is not, for two independent reasons that both had to be answered first:
 *
 *   1. **There is nothing to read.** Migration 0005 dropped `sla_first_response_due` and
 *      its siblings, because §23.5 requires the clock to be COMPUTED, never stored - "a
 *      calendar correction fixes history rather than leaving it wrong". An aggregate
 *      breach count would therefore mean running the clock engine over every open case on
 *      a dashboard refresh, which is the N+1 this reader exists to avoid.
 *   2. **The targets are not ratified.** SL-046 is Decision Required on D-SLA. A breach
 *      count against a placeholder target is a real number about an imaginary promise.
 *
 * Both resolve together: once D-SLA lands, the clock has something to be measured against
 * and the aggregate becomes worth its cost. Until then the panel says so rather than
 * showing a figure nobody should act on.
 *
 * ## Why per-person rows exist, and what they deliberately are not
 *
 * SL-083's acceptance is **"No individual vanity leaderboard required"**. Open-conversation
 * counts are here because a lead deciding who to hand work to needs them, and because
 * §21.9's cover and §21.7's transfer both ask "who has room". What is NOT here, and must
 * not be added: anything cumulative or comparative — messages sent, conversations closed,
 * response times per person. Those measure people; these measure work in flight.
 */
import { effectiveCapacityUnits } from './capacity-scope.js';
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export interface TeamMemberLoad {
  readonly principalId: UUID;
  readonly displayName: string;
  /** Conversations this person currently owns and has not resolved. */
  readonly openConversations: number;
  /** Reserved units against their ceiling, and the ceiling itself, when configured. */
  readonly reservedUnits: number;
  readonly capacityUnits: number | undefined;
}

export interface TeamLoad {
  readonly teamId: string;
  /** Waiting, never claimed. The number SL-006 calls "no invisible waiting". */
  readonly waiting: number;
  /** How long the longest-waiting customer has been waiting, in seconds. */
  readonly oldestWaitSeconds: number | undefined;
  readonly afterHoursWaiting: number;
  readonly members: readonly TeamMemberLoad[];
}

/** Conversation states that still represent work in someone's hands (§21.4). */
const OPEN_STATES = ['NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'];

export class PgTeamLoadReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The facts a TEAM-scoped authorization decision needs about a team.
   *
   * Returns `undefined` for a team that does not exist, which the caller treats exactly
   * like "you may not see it" — the same indistinguishability §27.3 requires everywhere
   * else, and the reason a probe cannot use this endpoint to enumerate team names.
   *
   * The department is loaded because `decideForTeam` evaluates DEPARTMENT-scoped grants
   * against it. Silently skipping that scope kind would be the quieter bug: a legitimate
   * department-wide grant would stop working with no error anywhere.
   */
  async contextFor(teamId: string): Promise<{ teamId: string; department?: string } | undefined> {
    const row = await this.pool.query<{ team_id: string; department: string | null }>(
      `SELECT team_id, department FROM identity.teams WHERE team_id = $1`,
      [teamId],
    );
    const found = row.rows[0];
    if (found === undefined) return undefined;
    return {
      teamId: found.team_id,
      ...(found.department !== null ? { department: found.department } : {}),
    };
  }

  async loadFor(teamId: string, at: Timestamp): Promise<TeamLoad> {
    const waiting = await this.pool.query<{
      waiting: string;
      after_hours: string;
      oldest: Date | null;
    }>(
      `SELECT count(*)::text                                        AS waiting,
              count(*) FILTER (WHERE q.after_hours)::text           AS after_hours,
              min(q.enqueued_at)                                    AS oldest
         FROM conversation.queue_entries q
        WHERE q.team_id = $1 AND q.state = 'WAITING'`,
      [teamId],
    );

    const members = await this.pool.query<{
      principal_id: string;
      display_name: string;
      open_conversations: string;
      reserved_units: string;
      capacity_units: number | null;
    }>(
      /**
       * Every member of the team, including the ones carrying nothing.
       *
       * A LEFT JOIN rather than a join through owned work: someone with an empty list is
       * the most useful row on this screen, and an inner join would hide exactly the
       * person a lead is looking for.
       */
      `SELECT p.principal_id,
              p.display_name,
              coalesce(o.open_count, 0)::text AS open_conversations,
              coalesce(r.reserved, 0)::text   AS reserved_units,
              ${effectiveCapacityUnits('p.principal_id::text')} AS capacity_units
         FROM identity.team_memberships tm
         JOIN identity.principals p ON p.principal_id = tm.principal_id
         LEFT JOIN (
              SELECT sc.current_owner_id AS owner, count(*) AS open_count
                FROM conversation.service_cases sc
                JOIN conversation.conversations c ON c.case_id = sc.case_id
               WHERE sc.owning_team_id = $1
                 AND sc.resolved_at IS NULL
                 AND c.state = ANY($2::conversation.conversation_state[])
               GROUP BY sc.current_owner_id
         ) o ON o.owner = p.principal_id
         LEFT JOIN (
              SELECT res.principal_id, sum(res.weight)::int AS reserved
                FROM conversation.reservations res
               WHERE res.released_at IS NULL AND res.expires_at > $3::timestamptz
               GROUP BY res.principal_id
         ) r ON r.principal_id = p.principal_id
         -- Capacity is scoped, not a column on the person. Resolved through the SHARED
         -- rule (capacity-scope.ts) so the queue view cannot show a ceiling the placement
         -- path does not enforce — they disagreed once, which is why the rule is shared.
         -- No backticks in here: this is inside a template literal, and one would
         -- end the string silently (CLAUDE.md records the last time that happened).
        WHERE tm.team_id = $1 AND p.status = 'ACTIVE'
        ORDER BY coalesce(o.open_count, 0) DESC, p.display_name ASC`,
      [teamId, OPEN_STATES, at],
    );

    const oldest = waiting.rows[0]?.oldest ?? null;

    return {
      teamId,
      waiting: Number(waiting.rows[0]?.waiting ?? '0'),
      afterHoursWaiting: Number(waiting.rows[0]?.after_hours ?? '0'),
      oldestWaitSeconds:
        oldest === null ? undefined : Math.max(0, Math.round((Date.parse(at) - oldest.getTime()) / 1000)),
      members: members.rows.map((row) => ({
        principalId: row.principal_id as UUID,
        displayName: row.display_name,
        openConversations: Number(row.open_conversations),
        reservedUnits: Number(row.reserved_units),
        capacityUnits: row.capacity_units ?? undefined,
      })),
    };
  }
}
