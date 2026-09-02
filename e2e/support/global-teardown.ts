/**
 * Removes this suite's rows.
 *
 * Teardown never fails the run: the tests have already reported by the time it executes,
 * and turning a clean-up problem into a red suite would hide whichever real result came
 * before it. A leak is announced instead, and `global-setup` cleans again on the way in.
 */
import { cleanup, connect } from './seed.js';

export default async function globalTeardown(): Promise<void> {
  let pool;
  try {
    pool = await connect();
    await cleanup(pool);
  } catch (cause) {
    // The runner has no logger and this must be seen.
    console.warn('e2e teardown could not clean its fixtures:', cause);
  } finally {
    await pool?.end();
  }
}
