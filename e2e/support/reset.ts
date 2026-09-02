/**
 * Puts the team's fixtures back to a known state before a spec file runs.
 *
 * ## Why this is needed
 *
 * Every spec claims work with `claimFromQueue`, which takes the FIRST waiting entry -
 * §23.4's oldest-first, which is the rule the product follows and therefore the rule the
 * test has to live with. That is correct behaviour and a hazard for a suite: once more
 * than one spec file creates customer conversations, a later file happily claims one an
 * earlier file left behind, and then asserts against the wrong thread.
 *
 * It showed up exactly that way - thirteen browser tests that each passed alone, three of
 * which failed when the whole suite ran in one go. The queue is shared state, and shared
 * state between test files is the thing that makes a green run stop meaning anything.
 *
 * Cleaning per FILE rather than per test is deliberate: several specs are one long chain
 * where each step's precondition is the previous step's effect, and resetting between
 * those steps would destroy the journey being tested.
 */
import { cleanup, connect, seed } from './seed.js';

export async function resetTeamWork(): Promise<void> {
  const pool = await connect();
  try {
    await cleanup(pool);
    // Re-seeded because the cleanup removes the team's principals along with its work;
    // both halves come from one place so the fixtures cannot drift apart.
    await seed(pool);
  } finally {
    await pool.end();
  }
}
