/**
 * The connected database has every migration applied.
 *
 * Written after a confusing failure: five sweep tests reported
 * `relation "conversation.reservations" does not exist` when the same suite had passed
 * minutes earlier. The cause was not the schema — it was that `SL_DATABASE_URL` had not
 * been exported in that shell, so every test silently fell back to
 * `postgres://…@localhost:5432/starlink` and ran against a LOCAL database two migrations
 * behind.
 *
 * That fallback is convenient and genuinely dangerous. A missing variable does not make
 * the suite skip — the local database is reachable, so the tests run, and they run
 * against the wrong schema. The no-skips gate cannot see it either: nothing skipped and
 * nothing was unreachable.
 *
 * A missing table at least fails loudly. The worse version is a schema that is only
 * PARTLY behind: the tests pass, against data and constraints that are not the ones
 * shipping. This check turns both into one clear sentence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDatabaseAllowed } from './guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let pool: pg.Pool | undefined;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 3 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ schema currency check SKIPPED: no PostgreSQL.\n');
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
});

describe('schema currency', () => {
  it('has applied every migration on disk', async (ctx) => {
    if (!available) {
      console.warn('  ⚠ UNPROVEN: the connected schema was not compared to the migrations on disk.');
      ctx.skip();
      return;
    }

    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const applied = new Set(
      (await pool!.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (row) => row.filename,
      ),
    );

    const missing = onDisk.filter((file) => !applied.has(file));

    expect(onDisk.length, 'no migrations found on disk — is the path right?').toBeGreaterThan(0);
    expect(
      missing,
      'The connected database is BEHIND the migrations in this repository. Either run ' +
        '`pnpm --filter @starlink/database migrate`, or check that SL_DATABASE_URL points ' +
        'where you think — an unset variable falls back to a local database that may be ' +
        'several migrations old, and the suite will run against it without complaint.',
    ).toEqual([]);
  });

  it('is pointed at a database that was deliberately chosen', async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    // Not a failure — plenty of people run against local Postgres on purpose. But the
    // fallback firing UNNOTICED is what caused the confusion, so it is said out loud.
    if (process.env.SL_DATABASE_URL === undefined) {
      console.warn(
        '\n  ⚠ SL_DATABASE_URL is not set; using the local fallback. If you meant to test ' +
          'against the development database, export it first.\n',
      );
    }
    expect(true).toBe(true);
  });
});
