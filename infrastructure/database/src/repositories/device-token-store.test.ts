/**
 * Two properties that decide whether push keeps working for a person over months.
 *
 * ## `inserted` is how a browser learns its token died
 *
 * FCM invalidates a registration on its own schedule. The transport is told
 * `UNREGISTERED` and deletes the row; the browser goes on presenting the same token from
 * the SDK's own cache. Client and server then disagree in silence and that device never
 * receives another push — it happened twice while Firebase was being set up, and the
 * only thing that fixed it was wiping the browser profile.
 *
 * The upsert reports whether it INSERTED. A client that remembered a token and is told
 * the server had to insert it has exactly that disagreement, and mints a fresh one.
 *
 * ## The quiet window is written on every registration, including as absent
 *
 * Switching quiet hours off has to CLEAR the stored window. An upsert that only ever set
 * it would leave yesterday's window silencing a device whose owner had just turned it
 * off — silence being the failure nobody reports, because it looks like nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { PgDeviceTokenStore } from './device-token-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `d7` block — owned by this file alone, so a parallel suite cannot perturb it. */
const PRINCIPAL = '018f2c5a-d7d7-7000-8000-00000000000a';
const TOKEN = 'device-token-store-test-token-aaaaaaaaaaaa';
const OTHER = 'device-token-store-test-token-bbbbbbbbbbbb';

let pool: pg.Pool | undefined;
let store: PgDeviceTokenStore;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 4 });
  try {
    await probe.query('SELECT 1');
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('  ⚠ Device token tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.');
    return;
  }

  /*
     Fixture setup is OUTSIDE the availability catch, deliberately.

     It was inside, and a mistyped column name (`principal_kind`; the column is `kind`)
     was swallowed into "no database" — seven tests reported themselves skipped against
     a database that was running perfectly. A setup failure must be loud: the
     reachability check above is the only thing allowed to decide these cannot run.
  */
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, authority, status)
     VALUES ($1, 'EMPLOYEE', 'Device Token Test', 'TEMPORARY_AUTHORITY', 'ACTIVE')
     ON CONFLICT (principal_id) DO NOTHING`,
    [PRINCIPAL],
  );
  available = true;
  pool = probe;
  store = new PgDeviceTokenStore(probe);
});

afterAll(async () => {
  /* The principal row is left alone — it may be shared — but this file's tokens go. */
  await pool?.query('DELETE FROM identity.device_tokens WHERE principal_id = $1', [PRINCIPAL]);
  await pool?.end().catch(() => undefined);
});

const clean = async (): Promise<void> => {
  await pool!.query('DELETE FROM identity.device_tokens WHERE principal_id = $1', [PRINCIPAL]);
};

describe('registering a device', () => {
  it('reports INSERTED the first time and not the second', async (ctx) => {
    if (!available) {
      console.warn('  ⚠ UNPROVEN: the upsert was not exercised against a database.');
      ctx.skip();
      return;
    }
    await clean();

    const first = await store.register(PRINCIPAL, TOKEN);
    const again = await store.register(PRINCIPAL, TOKEN);

    expect(first.inserted, 'a token the server has never seen').toBe(true);
    expect(again.inserted, 'the same token again is an update, not an insert').toBe(false);
  });

  it('reports INSERTED again once the row has been reaped', async (ctx) => {
    /**
     * The signature the client acts on. This is what a dead token looks like from the
     * browser's side: it registered, the transport later deleted the row on FCM's
     * verdict, and the next registration of the SAME string inserts again.
     */
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();

    await store.register(PRINCIPAL, TOKEN);
    await store.forget(TOKEN);
    const afterReaping = await store.register(PRINCIPAL, TOKEN);

    expect(afterReaping.inserted).toBe(true);
  });

  it('does not accumulate a row per registration', async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();

    for (let i = 0; i < 4; i += 1) await store.register(PRINCIPAL, TOKEN);

    const rows = await pool!.query(
      'SELECT count(*)::int AS n FROM identity.device_tokens WHERE principal_id = $1',
      [PRINCIPAL],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('the quiet window', () => {
  const WINDOW = { from: '20:00', to: '09:00', timeZone: 'Asia/Kolkata' };

  it('is stored, and cleared again when it is switched off', async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();

    await store.register(PRINCIPAL, TOKEN, 'WEB', WINDOW);
    const set = await pool!.query(
      'SELECT quiet_from, quiet_to, quiet_zone FROM identity.device_tokens WHERE token = $1',
      [TOKEN],
    );
    expect(set.rows[0]).toEqual({ quiet_from: '20:00', quiet_to: '09:00', quiet_zone: 'Asia/Kolkata' });

    // Switching quiet hours off registers again with nothing. The window must GO.
    await store.register(PRINCIPAL, TOKEN, 'WEB', undefined);
    const cleared = await pool!.query(
      'SELECT quiet_from, quiet_to, quiet_zone FROM identity.device_tokens WHERE token = $1',
      [TOKEN],
    );
    expect(cleared.rows[0]).toEqual({ quiet_from: null, quiet_to: null, quiet_zone: null });
  });

  it('hides a device from `tokensFor` while it is inside the window', async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();
    await store.register(PRINCIPAL, TOKEN, 'WEB', WINDOW);

    // 18:30Z is 00:00 in Kolkata — inside 20:00-09:00.
    const quiet = await store.tokensFor(PRINCIPAL, new Date('2026-09-11T18:30:00.000Z'));
    // 06:30Z is 12:00 in Kolkata — outside it.
    const awake = await store.tokensFor(PRINCIPAL, new Date('2026-09-11T06:30:00.000Z'));

    expect(quiet).toEqual([]);
    expect(awake).toEqual([TOKEN]);
  });

  it('is per DEVICE — a quiet phone does not silence the laptop beside it', async (ctx) => {
    /* The whole reason the window lives on the token rather than on the principal. */
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();
    await store.register(PRINCIPAL, TOKEN, 'WEB', WINDOW);
    await store.register(PRINCIPAL, OTHER, 'WEB', undefined);

    const atMidnight = await store.tokensFor(PRINCIPAL, new Date('2026-09-11T18:30:00.000Z'));

    expect(atMidnight).toEqual([OTHER]);
  });

  it('delivers to a device whose window cannot be read', async (ctx) => {
    /**
     * The failure direction. "I cannot tell" must mean deliver: a device muted for ever
     * by an unparseable window is indistinguishable from the feature being broken, and
     * nobody would ever discover why. Written straight to the column, because the API
     * and the CHECK both refuse this shape — which is the point of testing it.
     */
    if (!available) {
      ctx.skip();
      return;
    }
    await clean();
    await store.register(PRINCIPAL, TOKEN);
    await pool!.query(
      `UPDATE identity.device_tokens
          SET quiet_from = '20:00', quiet_to = '09:00', quiet_zone = 'Mars/Olympus'
        WHERE token = $1`,
      [TOKEN],
    );

    expect(await store.tokensFor(PRINCIPAL, new Date('2026-09-11T18:30:00.000Z'))).toEqual([TOKEN]);
  });
});
