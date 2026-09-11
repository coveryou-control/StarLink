/**
 * FCM registration tokens, one row per device (§29's PUSH channel).
 *
 * Small on purpose: the push transport asks one question — "where do I send for this
 * principal" — and answers one event, "that token is gone". Everything else about a
 * device is not StarLink's business to keep.
 */
import type pg from 'pg';
import { inQuietWindow, type QuietWindow } from '@starlink/notifications';

export class PgDeviceTokenStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Records a token for a principal, or refreshes one already recorded.
   *
   * Keyed on the TOKEN rather than the principal, because one person has several devices
   * and each mints its own. The conflict clause also re-points a token at a new
   * principal, which is the shared-machine case: a browser profile signed in as somebody
   * else keeps the same FCM registration, and without this the previous occupant would
   * keep receiving the pushes.
   */
  async register(
    principalId: string,
    token: string,
    platform = 'WEB',
    quiet?: QuietWindow,
  ): Promise<void> {
    /* Written on every registration, including as NULL. A device that turns quiet hours
       off must clear them, and an upsert that only ever set them would leave yesterday's
       window silencing a device whose owner had just switched it off. */
    await this.pool.query(
      `INSERT INTO identity.device_tokens
         (token, principal_id, platform, quiet_from, quiet_to, quiet_zone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token) DO UPDATE
         SET principal_id = EXCLUDED.principal_id,
             platform = EXCLUDED.platform,
             quiet_from = EXCLUDED.quiet_from,
             quiet_to = EXCLUDED.quiet_to,
             quiet_zone = EXCLUDED.quiet_zone,
             last_seen_at = now()`,
      [token, principalId, platform, quiet?.from ?? null, quiet?.to ?? null, quiet?.timeZone ?? null],
    );
  }

  /**
   * Every device this person has registered that is not currently in its quiet hours.
   *
   * The filter lives here rather than in the transport for a boundary reason and a
   * correctness one. The adapter depends on `shared-contracts` alone, so the window rule
   * — which is domain logic, shared with the web client — cannot be imported there. And
   * putting it here means any future caller asking "where do I send a push" gets the
   * answer that respects it, rather than each one remembering to.
   *
   * Evaluated per ROW, because the window is per device: a phone can be quiet while the
   * laptop beside it is not, which is the whole reason it is stored here.
   *
   * Suppresses the buzz and nothing else. The notification row is written and counted
   * before this is ever consulted (§29.6), so a quiet night still has everything waiting
   * in the morning.
   */
  async tokensFor(principalId: string, at: Date = new Date()): Promise<readonly string[]> {
    const result = await this.pool.query(
      `SELECT token, quiet_from, quiet_to, quiet_zone
         FROM identity.device_tokens WHERE principal_id = $1`,
      [principalId],
    );
    return result.rows
      .filter((row) => {
        const from = row.quiet_from as string | null;
        const to = row.quiet_to as string | null;
        const zone = row.quiet_zone as string | null;
        if (from === null || to === null || zone === null) return true;
        return !inQuietWindow({ from, to, timeZone: zone }, at);
      })
      .map((row) => row.token as string);
  }

  /**
   * Removes a token.
   *
   * Two callers, and they mean different things. The transport calls it when FCM reports
   * the token unregistered — the device is gone. The client calls it when somebody turns
   * notifications off or signs out — the device is still there and has asked to stop.
   * The row leaves either way, which is why one method serves both.
   */
  async forget(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM identity.device_tokens WHERE token = $1`, [token]);
  }

  /**
   * Every token belonging to a principal, dropped at once.
   *
   * For signing out everywhere: `sessionVersion` already invalidates the cookies, and a
   * device that can no longer authenticate must not keep receiving notifications either.
   */
  async forgetAllFor(principalId: string): Promise<void> {
    await this.pool.query(`DELETE FROM identity.device_tokens WHERE principal_id = $1`, [
      principalId,
    ]);
  }
}
