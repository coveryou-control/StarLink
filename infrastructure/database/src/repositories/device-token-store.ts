/**
 * FCM registration tokens, one row per device (§29's PUSH channel).
 *
 * Small on purpose: the push transport asks one question — "where do I send for this
 * principal" — and answers one event, "that token is gone". Everything else about a
 * device is not StarLink's business to keep.
 */
import type pg from 'pg';

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
  async register(principalId: string, token: string, platform = 'WEB'): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity.device_tokens (token, principal_id, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
         SET principal_id = EXCLUDED.principal_id,
             platform = EXCLUDED.platform,
             last_seen_at = now()`,
      [token, principalId, platform],
    );
  }

  /** Every device this person has registered. */
  async tokensFor(principalId: string): Promise<readonly string[]> {
    const result = await this.pool.query(
      `SELECT token FROM identity.device_tokens WHERE principal_id = $1`,
      [principalId],
    );
    return result.rows.map((row) => row.token as string);
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
