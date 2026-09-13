import type pg from 'pg';
import type {
  ChannelAccessPolicy,
  ChannelPostAccess,
  ChannelPurpose,
  ChannelReadAccess,
  ChannelVisibility,
  UUID,
} from '@starlink/shared-contracts';

/**
 * Channels: the persistent rooms, their access policy, and who can find them.
 *
 * ## The word
 *
 * `conversation.channel_sessions` in this same schema is the EXTERNAL DELIVERY channel — a
 * WhatsApp thread, an email conversation. This file is about the other kind: an internal
 * room for a department or a team. Nothing here touches that table and nothing there
 * touches these.
 *
 * ## What is NOT in this file
 *
 * Messages, reactions, replies, attachments, read state, mute, pins, search and realtime.
 * A channel is an `INTERNAL_CHANNEL` conversation, so all of those are the existing stores
 * working unchanged on an existing `conversation_id`. `0030_channels.sql` argues the case;
 * the short version is that a second messaging stack is where the authorization check gets
 * forgotten (§38).
 *
 * What is here is the three access questions and the directory that answers "which rooms
 * are there".
 */

/**
 * THE audience test, written once.
 *
 * ## Why this is a shared constant and not two similar queries
 *
 * `authz-reader.ts` asks it on every read and `message-store.ts` asks it on every send. Two
 * hand-written copies of an authorization predicate is precisely the divergence §38 records
 * as the reference platform's defect — one gets a fix and the other does not, and the one
 * that does not is the write path, which is the worse half to be wrong.
 *
 * ## Why it is a function of the parameter number
 *
 * The three callers number their parameters differently — the read path already has the
 * conversation in `$1`, the directory does not. Hard-coding `$2` here and passing a dead
 * `$1` to make it fit does not work: PostgreSQL refuses a statement with a parameter it
 * cannot type. So the caller says which placeholder holds the viewing principal, and there
 * is still exactly one copy of the predicate.
 *
 * It correlates on `c` (the conversations row) and reads `ch`, so the caller must have
 * joined `conversation.channels ch`.
 *
 * ## Blank is not a wildcard
 *
 * A principal with no department compares NULL against `scope_id`, which is never equal to
 * anything — so an employee with no department does not silently match a channel scoped to
 * a department, and (with the non-blank CHECK on the column) a channel scoped to '' cannot
 * be created to match them either. §27.2, in the place it actually matters.
 */
export const channelVisibilitySql = (viewer: string): string => `
  COALESCE(
    ch.visibility = 'EVERYONE'
    OR EXISTS (
      SELECT 1
        FROM conversation.channel_audience a
       WHERE a.conversation_id = c.conversation_id
         AND (
              (a.scope_kind = 'PRINCIPAL'
                AND a.scope_id = ${viewer}::text)
           OR (a.scope_kind = 'DEPARTMENT'
                AND a.scope_id = (SELECT pr.department
                                    FROM identity.principals pr
                                   WHERE pr.principal_id = ${viewer}::uuid))
           OR (a.scope_kind = 'TEAM'
                AND a.scope_id IN (SELECT tm.team_id
                                     FROM identity.team_memberships tm
                                    WHERE tm.principal_id = ${viewer}::uuid))
         )
    ),
    false
  )`;

/** The columns the fragment above needs beside it. Selected together so neither is forgotten. */
export const CHANNEL_POLICY_COLUMNS = `
  ch.visibility        AS channel_visibility,
  ch.read_access       AS channel_read_access,
  ch.post_access       AS channel_post_access,
  (ch.archived_at IS NOT NULL) AS channel_archived`;

export const CHANNEL_POLICY_JOIN = `
  LEFT JOIN conversation.channels ch ON ch.conversation_id = c.conversation_id`;

/**
 * Turns those columns into the shape `decide()` reads, or `undefined`.
 *
 * `undefined` when the row carries no policy — which happens for every conversation that is
 * not a channel, and would also happen for a channel whose policy row is missing. `decide()`
 * refuses a channel with no policy, so the second case fails closed rather than defaulting.
 */
export function channelFactsFrom(
  row: Record<string, unknown>,
): { readonly policy: ChannelAccessPolicy; readonly visibleToActor: boolean } | undefined {
  if (row.channel_visibility == null) return undefined;
  return {
    policy: {
      visibility: row.channel_visibility as ChannelVisibility,
      readAccess: row.channel_read_access as ChannelReadAccess,
      postAccess: row.channel_post_access as ChannelPostAccess,
      archived: row.channel_archived === true,
    },
    visibleToActor: row.channel_visible === true,
  };
}

/** One row of a channel's audience, when the audience is not everybody. */
export interface ChannelAudienceEntry {
  readonly scopeKind: 'DEPARTMENT' | 'TEAM' | 'PRINCIPAL';
  readonly scopeId: string;
}

/** A channel as the directory shows it. */
export interface ChannelDirectoryRow {
  readonly conversationId: UUID;
  readonly name: string;
  readonly description: string | undefined;
  readonly purpose: ChannelPurpose;
  readonly visibility: ChannelVisibility;
  readonly readAccess: ChannelReadAccess;
  readonly postAccess: ChannelPostAccess;
  readonly archived: boolean;
  readonly memberCount: number;
  /** Is the VIEWER in it, and if so with what authority. */
  readonly membership: 'ADMIN' | 'MEMBER' | 'NONE';
  readonly lastActivityAt: string;
  /** Unread messages for the viewer. Zero for a channel they are not in. */
  readonly unreadCount: number;
}

export interface NewChannel {
  readonly conversationId: UUID;
  readonly purpose: ChannelPurpose;
  readonly description?: string | undefined;
  readonly visibility: ChannelVisibility;
  readonly readAccess: ChannelReadAccess;
  readonly postAccess: ChannelPostAccess;
  readonly audience: readonly ChannelAudienceEntry[];
}

export class PgChannelStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Writes the policy for a conversation that has already been created as a channel.
   *
   * Two statements in one transaction: a channel whose row exists without its audience is
   * visible to nobody, which is the safe direction but still a state no reader should be
   * able to observe.
   */
  async createPolicy(channel: NewChannel): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conversation.channels
           (conversation_id, purpose, description, visibility, read_access, post_access)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          channel.conversationId,
          channel.purpose,
          channel.description ?? null,
          channel.visibility,
          channel.readAccess,
          channel.postAccess,
        ],
      );
      await this.writeAudienceWith(client, channel.conversationId, channel.audience);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces the policy of an existing channel.
   *
   * A replace rather than a merge, and the audience goes with it: "who can see this" is one
   * answer, not a set of independently editable rows, and a partial update is how a channel
   * ends up scoped to a department somebody removed from the form three edits ago.
   */
  async updatePolicy(
    conversationId: UUID,
    update: {
      readonly purpose: ChannelPurpose;
      readonly description?: string | undefined;
      readonly visibility: ChannelVisibility;
      readonly readAccess: ChannelReadAccess;
      readonly postAccess: ChannelPostAccess;
      readonly audience: readonly ChannelAudienceEntry[];
    },
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE conversation.channels
            SET purpose = $2, description = $3, visibility = $4,
                read_access = $5, post_access = $6, updated_at = now()
          WHERE conversation_id = $1`,
        [
          conversationId,
          update.purpose,
          update.description ?? null,
          update.visibility,
          update.readAccess,
          update.postAccess,
        ],
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM conversation.channel_audience WHERE conversation_id = $1', [
        conversationId,
      ]);
      await this.writeAudienceWith(client, conversationId, update.audience);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeAudienceWith(
    client: pg.PoolClient,
    conversationId: UUID,
    audience: readonly ChannelAudienceEntry[],
  ): Promise<void> {
    for (const entry of audience) {
      /* Trimmed here as well as CHECKed at the column: the check refuses a blank and this
         stops '  technology  ' becoming a scope nobody's department will ever equal. */
      const scopeId = entry.scopeId.trim();
      if (scopeId === '') continue;
      await client.query(
        `INSERT INTO conversation.channel_audience (conversation_id, scope_kind, scope_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [conversationId, entry.scopeKind, scopeId],
      );
    }
  }

  /** Retires a channel, or brings it back. History is untouched either way (BR-09/§24.3). */
  async setArchived(conversationId: UUID, archived: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.channels
          SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
        WHERE conversation_id = $1`,
      [conversationId, archived],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The channel's name, which lives on the conversation rather than here.
   *
   * Separate from `updatePolicy` because it writes a different table, and folding it in
   * would mean a policy edit and a rename sharing a transaction that spans both - for no
   * gain, since a rename that succeeds while a policy edit fails leaves a correctly-named
   * room with its previous access, which is the safe half to keep.
   *
   * The unique partial index refuses a name another channel already holds; that surfaces as
   * a rejected query rather than a `false`, because a caller silently keeping the old name
   * would be worse than an error.
   */
  async rename(conversationId: UUID, name: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.conversations
          SET title = $2, updated_at = now()
        WHERE conversation_id = $1 AND conversation_type = 'INTERNAL_CHANNEL'`,
      [conversationId, name.trim()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Somebody walking into an open room.
   *
   * ## Not `addParticipant`
   *
   * The domain's add command is BR-07's: one person exposing the history to another, which
   * must be acknowledged and which writes "Archit added Rishitt" into the thread. Neither
   * applies here. Nobody is being exposed to anything they could not already read - that is
   * precisely what the caller checked - and a channel that announces every arrival becomes
   * unreadable in a department of forty.
   *
   * ## Re-joining
   *
   * A row may already exist, dated out, from a previous stay (BR-09/§24.3 - participation
   * ends, it is never deleted). Re-opening the existing row rather than inserting a second
   * keeps one history per person per room. `effective_from` is moved to now, so the
   * previous period is not silently re-granted.
   */
  async addSelfAsMember(conversationId: UUID, principalId: UUID, at: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const reopened = await client.query(
        `UPDATE conversation.participants
            SET effective_to = NULL, effective_from = $3, role = 'PARTICIPANT'
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, principalId, at.toISOString()],
      );
      if ((reopened.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO conversation.participants
             (conversation_id, principal_id, principal_kind, role, reply_authority,
              added_by, effective_from, added_at)
           VALUES ($1, $2, 'EMPLOYEE', 'PARTICIPANT', false, $2, $3, $3)`,
          [conversationId, principalId, at.toISOString()],
        );
      }
      /* Kept in step, because the directory reads it and a count that drifts is a count
         nobody trusts. Recomputed rather than incremented: an increment on a re-join that
         did not actually insert would double-count the same person. */
      await client.query(
        `UPDATE conversation.conversations c
            SET participant_count = (
                  SELECT count(*) FROM conversation.participants p
                   WHERE p.conversation_id = c.conversation_id
                     AND p.effective_from <= now()
                     AND (p.effective_to IS NULL OR p.effective_to > now()))
          WHERE c.conversation_id = $1`,
        [conversationId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The departments and teams a channel's audience can name.
   *
   * Read from `identity`, which is where they come from, rather than typed into a form. A
   * free-text scope is how a channel ends up addressed to "Techonlogy" and reaches nobody -
   * §27.2's rule says a blank must not match a blank, and a MISSPELLING behaves exactly
   * like a blank while looking deliberate.
   *
   * These are not business values (rule 10). They are the contents of the identity
   * directory, which is upstream data StarLink reads and does not decide.
   */
  async availableScopes(): Promise<{
    readonly departments: readonly string[];
    readonly teams: readonly { readonly teamId: string; readonly displayName: string }[];
  }> {
    const [departments, teams] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT department FROM identity.principals
          WHERE kind = 'EMPLOYEE' AND department IS NOT NULL AND btrim(department) <> ''
          ORDER BY department`,
      ),
      this.pool.query(
        `SELECT team_id, display_name FROM identity.teams ORDER BY display_name`,
      ),
    ]);
    return {
      departments: departments.rows.map((row) => row.department as string),
      teams: teams.rows.map((row) => ({
        teamId: row.team_id as string,
        displayName: row.display_name as string,
      })),
    };
  }

  async audienceOf(conversationId: UUID): Promise<readonly ChannelAudienceEntry[]> {
    const result = await this.pool.query(
      `SELECT scope_kind, scope_id FROM conversation.channel_audience
        WHERE conversation_id = $1 ORDER BY scope_kind, scope_id`,
      [conversationId],
    );
    return result.rows.map((row) => ({
      scopeKind: row.scope_kind as ChannelAudienceEntry['scopeKind'],
      scopeId: row.scope_id as string,
    }));
  }

  /**
   * The directory: every channel this principal is allowed to KNOW ABOUT.
   *
   * ## Visibility is applied in the query, not after it
   *
   * Filtering in the controller would mean the database returning rows the caller may not
   * know exist and trusting a `.filter()` to drop them — and a page of 50 that becomes 3
   * after filtering is also a paging bug. The same predicate `decide()` uses is applied
   * here, from the same constant.
   *
   * Note what this does NOT decide: whether the caller may READ the channel. A visible,
   * members-only channel appears here with `membership: 'NONE'`, which is the whole point —
   * that is the row with a "Request to join" on it. Every content path re-decides.
   *
   * ## Archived channels are excluded
   *
   * Except for members, who keep seeing rooms they are in so their history does not
   * silently vanish from the product.
   */
  async directoryFor(
    principalId: UUID,
    options: { readonly includeArchived?: boolean; readonly onlyConversationId?: UUID } = {},
  ): Promise<readonly ChannelDirectoryRow[]> {
    const result = await this.pool.query(
      `SELECT c.conversation_id,
              c.title,
              c.last_activity_at,
              ch.description,
              ch.purpose,
              ch.visibility,
              ch.read_access,
              ch.post_access,
              (ch.archived_at IS NOT NULL) AS archived,
              (SELECT count(*) FROM conversation.participants mp
                WHERE mp.conversation_id = c.conversation_id
                  AND mp.effective_from <= now()
                  AND (mp.effective_to IS NULL OR mp.effective_to > now()))::int AS member_count,
              me.role AS my_role,
              (me.principal_id IS NOT NULL) AS is_member,
              COALESCE((SELECT count(*) FROM conversation.messages m
                         WHERE m.conversation_id = c.conversation_id
                           AND m.seq > COALESCE(rs.last_read_seq, 0)
                           AND m.message_class <> 'MEMBERSHIP'
                           AND m.sender_principal_id IS DISTINCT FROM $1), 0)::int AS unread_count,
              ${channelVisibilitySql('$1')} AS channel_visible
         FROM conversation.conversations c
         JOIN conversation.channels ch ON ch.conversation_id = c.conversation_id
         LEFT JOIN conversation.participants me
                ON me.conversation_id = c.conversation_id
               AND me.principal_id = $1
               AND me.effective_from <= now()
               AND (me.effective_to IS NULL OR me.effective_to > now())
         LEFT JOIN conversation.read_state rs
                ON rs.conversation_id = c.conversation_id AND rs.principal_id = $1
        WHERE c.conversation_type = 'INTERNAL_CHANNEL'
          /* A member always sees their own room, whatever the audience says - the same
             rule decide() applies, so the directory and the decision agree. */
          AND (${channelVisibilitySql('$1')} OR me.principal_id IS NOT NULL)
          AND ($2::boolean OR ch.archived_at IS NULL OR me.principal_id IS NOT NULL)
          AND ($3::uuid IS NULL OR c.conversation_id = $3::uuid)
        ORDER BY ch.purpose, lower(c.title)`,
      [principalId, options.includeArchived === true, options.onlyConversationId ?? null],
    );

    return result.rows.map((row) => ({
      conversationId: row.conversation_id as UUID,
      name: row.title as string,
      description: row.description === null ? undefined : (row.description as string),
      purpose: row.purpose as ChannelPurpose,
      visibility: row.visibility as ChannelVisibility,
      readAccess: row.read_access as ChannelReadAccess,
      postAccess: row.post_access as ChannelPostAccess,
      archived: row.archived === true,
      memberCount: row.member_count as number,
      membership:
        row.is_member !== true ? 'NONE'
        : row.my_role === 'CREATOR' || row.my_role === 'ADMIN' ? 'ADMIN'
        : 'MEMBER',
      lastActivityAt: (row.last_activity_at as Date).toISOString(),
      unreadCount: row.is_member === true ? (row.unread_count as number) : 0,
    }));
  }

  /**
   * One channel, as the details panel needs it — including for somebody who is not in it.
   *
   * Returns `undefined` when the channel does not exist OR the caller may not know it does.
   * One answer for both, so "you may not" and "it is not there" are indistinguishable
   * (§27.3), which is the same rule every other read here obeys.
   */
  async describeFor(
    conversationId: UUID,
    principalId: UUID,
  ): Promise<ChannelDirectoryRow | undefined> {
    const rows = await this.directoryFor(principalId, {
      includeArchived: true,
      onlyConversationId: conversationId,
    });
    return rows[0];
  }
}
