/**
 * Turning §29.2's roles into principals, and answering the away question honestly.
 *
 * §29.2's table addresses ROLES. The outbox stores principals. `PgNotificationRecipients`
 * does the lookups; this wraps it for injection and adds the one thing that is not a
 * database fact.
 *
 * ## Away is not knowable from this process, and says so
 *
 * §29.6 defines away narrowly — "simply 'not currently connected'", never presence, and
 * §21.9 forbids inferring anything about a person from a socket. The only thing that
 * knows about connections is `PresenceStore`, and its one implementation is
 * `InProcessPresence` inside the realtime gateway: a different process, with no shared
 * backplane until Redis arrives (§33.2, ADR-006's trigger).
 *
 * Part IV §52 settles where the answer will come from — it assigns "presence leases" to
 * the shared realtime backplane. So this is not a gap for StarLink to fill some other
 * way: a `last_seen_at` column was considered and withdrawn (N-21), because it has no
 * source support and it would answer "recently made a request", which is not the
 * question §29.6 asks.
 *
 * So the API cannot answer it, and this returns `false` — "not away" — rather than
 * guessing. The consequence is stated plainly because it is a real gap, not a detail:
 * **every "in-app + external if away" row resolves to in-app only.** Two rows are
 * affected, `CONVERSATION_ASSIGNED` and `CUSTOMER_REPLIED`. The rows §29.2 marks
 * "in-app + external" unconditionally are unaffected.
 *
 * The alternative default is worse. Assuming everyone is away would send an email for
 * every assignment to everyone, which is the noise §29.2's governing sentence — "notify
 * only what someone must act on" — exists to prevent, and it would arrive the moment an
 * email provider is configured, from a default nobody chose.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { NotificationChannel } from '@starlink/notifications';
import type { PgNotificationPreferences, PgNotificationRecipients } from '@starlink/database';
import { NOTIFICATION_PREFERENCES, NOTIFICATION_RECIPIENTS } from '../tokens.js';

@Injectable()
export class NotificationRecipients {
  constructor(
    @Inject(NOTIFICATION_RECIPIENTS) private readonly store: PgNotificationRecipients,
    @Inject(NOTIFICATION_PREFERENCES) private readonly preferences: PgNotificationPreferences,
  ) {}

  ownerOf(conversationId: UUID): Promise<UUID | undefined> {
    return this.store.ownerOf(conversationId);
  }

  teamOf(conversationId: UUID): Promise<string | undefined> {
    return this.store.teamOf(conversationId);
  }

  /** §29.2's single customer row — the recipient of `CUSTOMER_CONVERSATION_ANSWERED`. */
  customerOf(conversationId: UUID, at: Timestamp): Promise<UUID | undefined> {
    return this.store.customerOf(conversationId, at);
  }

  leadsOfTeam(teamId: string, at: Timestamp): Promise<readonly UUID[]> {
    return this.store.leadsOfTeam(teamId, at);
  }

  /** The leads of whichever team owns this conversation's case. */
  async leadsFor(conversationId: UUID, at: Timestamp): Promise<readonly UUID[]> {
    const teamId = await this.store.teamOf(conversationId);
    return teamId === undefined ? [] : this.store.leadsOfTeam(teamId, at);
  }

  /**
   * Channels this principal has opted out of (§29.6).
   *
   * In-app is not among the possible answers — the schema cannot express it, because
   * §29.6 makes it "the unread mechanism" rather than a preference.
   */
  optedOutOf(principalId: UUID, categoryId?: string): Promise<readonly NotificationChannel[]> {
    return this.preferences.optedOutOf(principalId, categoryId);
  }

  /**
   * Whether this principal has had no realtime connection recently.
   *
   * Always `false` today. See the header — this is a stated gap, not a stub pretending to
   * be an answer, and it closes when presence becomes readable across processes.
   */
  async isAway(_principalId: UUID): Promise<boolean> {
    return false;
  }
}
