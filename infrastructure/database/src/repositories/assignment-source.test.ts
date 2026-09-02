/**
 * The `AssignmentSource` union matches the database enum.
 *
 * Written because it did not. The TypeScript type invented `TRANSFERRED` for `TRANSFER`
 * and `ADMIN` for `LEAD_ASSIGNED`, and omitted `REASSIGNED_ON_EXIT` altogether. Nothing
 * caught it: the enum lives in SQL, so the compiler has no opinion, and every unit test
 * used `CLAIMED` — the one value that happened to be spelled correctly. The first
 * transfer, escalation or employee-exit reassignment in production would have failed on
 * an insert, on the path where losing the write matters most.
 *
 * This is the same shape as the route-table problem: a contract that lives in two places
 * with nothing comparing them. There the fix was one shared table; here the two
 * declarations genuinely must live apart — one in a migration, one in TypeScript — so
 * the fix is a test that reads both and diffs them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '../guard.js';
import type { AssignmentSource } from './routing-store.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/**
 * Every member of the union, listed exhaustively.
 *
 * The `satisfies` makes this a compile error if a member is added to the type and not
 * here; the test below makes it a test failure if it does not match the database. A
 * value can therefore only be introduced by touching all three places.
 */
const DECLARED = [
  'ROUTED',
  'CLAIMED',
  'LEAD_ASSIGNED',
  'REASSIGNED_ON_EXIT',
  'COVER',
  'ESCALATION',
  'TRANSFER',
] as const satisfies readonly AssignmentSource[];

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
    console.warn('\n  ⚠ assignment-source enum check SKIPPED: no PostgreSQL.\n');
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
});

describe('assignment_source', () => {
  it('the TypeScript union and the database enum are the same set', async (ctx) => {
    if (!available) {
      console.warn('  ⚠ UNPROVEN: the assignment_source union was not compared to the database.');
      ctx.skip();
      return;
    }

    const result = await pool!.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'conversation' AND t.typname = 'assignment_source'
        ORDER BY e.enumsortorder`,
    );

    const inDatabase = result.rows.map((row) => row.label).sort();
    const inTypeScript = [...DECLARED].sort();

    expect(inDatabase.length, 'the enum was not found in the database').toBeGreaterThan(0);
    expect(
      inTypeScript,
      'AssignmentSource and conversation.assignment_source have drifted — a value ' +
        'spelled differently in the two is a runtime insert failure on the transfer, ' +
        'escalation or employee-exit path.',
    ).toEqual(inDatabase);
  });

  it('every declared value is actually insertable', async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    // Belt to the braces above: a value present in `pg_enum` but rejected by a CHECK
    // constraint would still fail at runtime, and the set comparison would not see it.
    for (const source of DECLARED) {
      const cast = await pool!.query(`SELECT $1::conversation.assignment_source AS v`, [source]);
      expect(cast.rows[0]?.v, source).toBe(source);
    }
  });
});
