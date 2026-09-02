/**
 * Notification preferences (doc §29.6).
 *
 * §29.6 puts them "per principal, per channel, per category". Two things follow from
 * that sentence and both are enforced rather than intended.
 *
 * **In-app cannot be opted out of.** §29.6: it "is not disableable — it is the unread
 * mechanism". The CHECK constraint in migration 0008 makes `INAPP` unrepresentable here,
 * so the way to turn it off is a schema change, which is a conversation, rather than a
 * row, which is not.
 *
 * **Absence means opted in.** No defaults are seeded and none are assumed. A principal
 * with no rows receives everything §29.2 says they should, which is the state the system
 * was already in — seeding a global default would be choosing a business value nobody
 * has set (rule 10).
 *
 * The more specific row wins: a preference for `claims.new` overrides the all-categories
 * one for the same channel. That is the only way "per category" means anything, and the
 * unique index keys on `COALESCE(category_id, '*')` so a principal cannot hold two
 * all-categories rows for one channel.
 */
import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';
import type { NotificationChannel } from '@starlink/notifications';

export class PgNotificationPreferences {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Channels this principal has opted OUT of, for this category.
   *
   * Returns a list rather than a per-channel predicate because the caller is deciding a
   * whole notification at once, and one round trip per channel would be three for an
   * event that needs one.
   */
  async optedOutOf(
    principalId: UUID,
    categoryId?: string,
  ): Promise<readonly NotificationChannel[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (channel) channel, opted_out
         FROM conversation.notification_preferences
        WHERE principal_id = $1
          AND (category_id IS NULL OR category_id = $2)
        -- The category-specific row first, so DISTINCT ON keeps it over the general one.
        ORDER BY channel, (category_id IS NULL)`,
      [principalId, categoryId ?? null],
    );
    return result.rows
      .filter((row) => row.opted_out === true)
      .map((row) => row.channel as NotificationChannel);
  }

  /**
   * Records a preference.
   *
   * Upsert rather than insert: a principal toggling the same switch twice is ordinary,
   * and making the second attempt an error would push the retry logic into every caller.
   */
  async set(input: {
    principalId: UUID;
    channel: 'EMAIL' | 'PUSH' | 'CUSTOMER_CHANNEL';
    categoryId?: string;
    optedOut: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation.notification_preferences
         (principal_id, channel, category_id, opted_out, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (principal_id, channel, COALESCE(category_id, '*'))
       DO UPDATE SET opted_out = EXCLUDED.opted_out, updated_at = now()`,
      [input.principalId, input.channel, input.categoryId ?? null, input.optedOut],
    );
  }
}
