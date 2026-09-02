/**
 * Prepares the database before any browser starts.
 *
 * Fails loudly when PostgreSQL is unreachable rather than skipping. A browser suite that
 * quietly reports "0 passed" is the failure mode CLAUDE.md's testing posture names — a
 * gate that did not run must never report green — and unlike the vitest database spikes
 * this suite has no partial value without a database: every path it covers starts at a
 * sign-in form backed by a real row.
 */
import { cleanup, connect, seed } from './seed.js';

export default async function globalSetup(): Promise<void> {
  let pool;
  try {
    pool = await connect();
  } catch (cause) {
    throw new Error(
      'The browser suite needs PostgreSQL. Start it with ' +
        '`powershell -File infrastructure/deployment/local-postgres.ps1 start` ' +
        'or point SL_DATABASE_URL at one.',
      { cause },
    );
  }

  try {
    // A previous run killed mid-test leaves rows behind; clean first so the queue this
    // suite reads contains only what this run put there.
    await cleanup(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
}
