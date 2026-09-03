/**
 * The probe that keeps §32.4's index alert from watching an empty series.
 *
 * Two kinds of assertion here, and the second is the one that will earn its keep:
 *
 *   1. behaviour — it publishes a ratio for a long conversation, and publishes NOTHING
 *      when there is nothing to measure;
 *   2. agreement — the query it explains is the query the API actually runs. A monitoring
 *      probe that drifts from the thing it monitors reports health for a plan nobody
 *      executes, which is worse than no probe: the alert stays green while the real page
 *      degrades. That is a source-level check, because there is no runtime signal for it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createLogger, metrics } from '@starlink/observability';
import { assertDatabaseAllowed } from '@starlink/database';
import { MessagePageIndexHealthSweep } from './index-health-sweep.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const logger = createLogger({ service: 'index-health-test', level: 'error' });

let pool: pg.Pool | undefined;
let available = false;
const conversations: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 4 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
    available = true;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ index health sweep SKIPPED: no PostgreSQL.\n');
  }
}, 60_000);

afterAll(async () => {
  if (pool !== undefined && available && conversations.length > 0) {
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = ANY($1::uuid[])`, [
      conversations,
    ]);
    await pool.query(
      `DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`,
      [conversations],
    );
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, body: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      console.warn(`  ⚠ UNPROVEN: ${name}`);
      ctx.skip();
      return;
    }
    await body();
  }, 120_000);
};

async function seed(messageCount: number): Promise<string> {
  const conversationId = crypto.randomUUID();
  conversations.push(conversationId);
  await pool!.query(
    `INSERT INTO conversation.conversations (conversation_id, conversation_type, state, last_seq)
     VALUES ($1,'CUSTOMER_SERVICE','ACTIVE',$2)`,
    [conversationId, messageCount],
  );
  await pool!.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body, created_at)
     SELECT gen_random_uuid(), $1, g, 'CUSTOMER_VISIBLE', 'CUSTOMER', 'Probe Customer',
            'message ' || g, now() - (($2 - g) * interval '1 second')
     FROM generate_series(1, $2) g`,
    [conversationId, messageCount],
  );
  await pool!.query('ANALYZE conversation.messages');
  return conversationId;
}

/** The current value of the gauge, read back out of the registry. */
const publishedRatio = (): number | undefined => {
  const scraped = metrics.render();
  const line = scraped
    .split('\n')
    .find((l) => l.startsWith('starlink_message_page_rows_examined_ratio '));
  return line === undefined ? undefined : Number(line.split(' ')[1]);
};

describe('message page index health (§32.4, §38)', () => {
  withDb('publishes a bounded ratio for a long conversation', async () => {
    await seed(1_200);

    const outcome = await new MessagePageIndexHealthSweep({
      pool: pool!,
      logger,
      minMessages: 500,
    }).run();

    expect(outcome.acted).toBe(1);
    expect(outcome.ratio).toBeDefined();

    /**
     * The §38 property, now asserted on the PRODUCTION probe rather than only in the
     * spike: paging a long conversation examines rows proportional to rows returned.
     * `alerts.yml` uses 3 as its threshold, so this is the same number the alert fires on.
     */
    expect(outcome.ratio!).toBeLessThanOrEqual(3);
    expect(publishedRatio()).toBeCloseTo(outcome.ratio!, 5);
  });

  withDb('publishes nothing when there is nothing long enough to measure', async () => {
    /**
     * The honest silence. Reporting a healthy 1.0 for a database with no long
     * conversations would be inventing the reassurance the alert exists to withhold —
     * and it is the exact mistake that made the inactive-owner gauge meaningless before
     * it was hosted.
     */
    const outcome = await new MessagePageIndexHealthSweep({
      pool: pool!,
      logger,
      // Higher than anything seeded, so nothing qualifies.
      minMessages: 10_000_000,
    }).run();

    expect(outcome).toEqual({ examined: 0, acted: 0 });
  });
});

describe('the probe measures the query the product runs', () => {
  it('explains the same shape as PgMessageReader pages with', () => {
    /**
     * A source comparison, because there is no runtime way to notice this drifting.
     *
     * If someone changes the message page — a new predicate, a different ordering, a
     * covering index — and does not change the probe, the alert keeps reporting on the
     * old plan. It would stay green through exactly the regression it exists to catch.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const probe = readFileSync(join(here, 'index-health-sweep.ts'), 'utf8');
    const reader = readFileSync(
      join(here, '..', '..', 'database', 'src', 'repositories', 'message-store.ts'),
      'utf8',
    );

    // The clauses that decide the plan: the predicate, the visibility filter and the
    // compound ordering the index has to serve.
    //
    // There was a fourth. Threads added `thread_parent_id IS NULL OR also_send_to_channel`
    // to the page, the probe kept explaining the query without it, and the alert would have
    // gone on reporting a healthy ratio for a plan nobody ran any more — this guard is what
    // caught that, and it is why the list is checked against BOTH files rather than
    // maintained in one. Removing threads removed the clause from the reader, so it comes
    // out of the list in the same commit; leaving it here would fail the build for the
    // opposite reason and teach the next person to delete the guard.
    //
    // The clauses carry the reader's `m` alias. Comparing unaliased text would quietly stop
    // matching the day an alias appeared — a drift guard that no longer sees the thing it
    // guards is worse than none, because it is still green.
    for (const clause of [
      'WHERE m.conversation_id = $1',
      'm.visibility = ANY($2::conversation.message_visibility[])',
      'ORDER BY m.created_at DESC, m.message_id DESC',
    ]) {
      expect(probe, `probe lost: ${clause}`).toContain(clause);
      expect(reader, `message-store changed: ${clause}`).toContain(clause);
    }
  });
});
