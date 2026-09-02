/**
 * Outbox relay, against real PostgreSQL.
 *
 * These are the assertions that make "persist before publish" more than a slogan:
 * a committed row is eventually delivered, a failed delivery is retried rather than
 * lost, a permanently failing row becomes visible instead of silent, and two relays
 * running at once do not deliver the same event twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiresTls } from '@starlink/database';
import pg from 'pg';
import { InProcessBackplane } from '@starlink/adapter-realtime-backplane';
import { MockEventPublisher } from '@starlink/adapter-event-bus';
import { createLogger } from '@starlink/observability';
import { assertDatabaseAllowed } from '@starlink/database';
import type { DomainEventEnvelope, RealtimeEvent } from '@starlink/shared-contracts';
import { OutboxRelay } from './outbox-relay.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const AGGREGATE = '018f2c5a-f1f1-7000-8000-00000000000a';
const logger = createLogger({ service: 'relay-test', sink: () => undefined });

let pool: pg.Pool | undefined;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({
    connectionString: CONNECTION,
    connectionTimeoutMillis: 10_000,
    /*
       `requiresTls`, not a substring match on "localhost".

       This read `CONNECTION.includes('localhost')`, so pointing SL_DATABASE_URL at
       `127.0.0.1` — the same loopback database, and the spelling that works when the host
       resolves ::1 first — demanded verified TLS from a server that has none. The
       connection failed, the `catch` below called it "no PostgreSQL", and eleven tests
       skipped rather than failing. `test:verify` caught it; nothing else would have.

       The client already answers this question correctly for all three loopback
       spellings, so this asks it rather than approximating it.
    */
    ...(requiresTls(CONNECTION) ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Outbox relay tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
  }
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query('DELETE FROM conversation.outbox WHERE aggregate_id = $1', [AGGREGATE]);
  }
  await pool?.end().catch(() => undefined);
});

const seedRow = async (over: { eventName?: string; payload?: Record<string, unknown> } = {}) => {
  const id = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO conversation.outbox
       (outbox_id, event_name, event_version, aggregate_type, aggregate_id, payload, correlation_id)
     VALUES ($1, $2, 1, 'conversation', $3, $4, 'relay-corr')`,
    [
      id,
      over.eventName ?? 'message.created.v1',
      AGGREGATE,
      JSON.stringify(
        over.payload ?? {
          messageId: crypto.randomUUID(),
          conversationId: AGGREGATE,
          seq: 1,
          senderKind: 'EMPLOYEE',
          visibility: 'CUSTOMER_VISIBLE',
          channel: 'INTERNAL',
          hasAttachments: false,
        },
      ),
    ],
  );
  return id;
};

/**
 * Drains until THIS row is settled, rather than assuming one pass reaches it.
 *
 * `drainOnce` claims a bounded batch (100 by default) ordered by age, so a freshly seeded
 * row sits behind whatever else is pending — and on a shared development database that is
 * other suites' rows, not this one's. A single call was fine while only two events were
 * ever emitted; it stopped being fine the moment the product started emitting six.
 *
 * This is also closer to what the relay actually does: it runs on a timer, repeatedly,
 * until the outbox is empty. Asserting on one pass was the test being less faithful than
 * the thing it tests.
 */
const drainUntilSettled = async (
  relay: { drainOnce: () => Promise<unknown> },
  outboxId: string,
  passes = 6,
): Promise<void> => {
  for (let i = 0; i < passes; i += 1) {
    await relay.drainOnce();
    const row = await pool!.query('SELECT state FROM conversation.outbox WHERE outbox_id = $1', [
      outboxId,
    ]);
    if (row.rows[0]?.state !== 'PENDING') return;
  }
};

const stateOf = async (outboxId: string): Promise<{ state: string; attempts: number }> => {
  const row = await pool!.query('SELECT state, attempts FROM conversation.outbox WHERE outbox_id = $1', [
    outboxId,
  ]);
  return { state: row.rows[0].state, attempts: row.rows[0].attempts };
};

/**
 * The relay drains the WHOLE outbox — that is its job — but the suite runs test files
 * in parallel against one database, so other files are creating rows while these run.
 *
 * Two consequences, both learned the hard way when this file passed alone and failed
 * in the suite:
 *
 *   * Never `DELETE FROM conversation.outbox` wholesale. That deletes another file's
 *     pending rows mid-run and breaks it.
 *   * Never assert on the relay's GLOBAL counts. Assert on rows belonging to this
 *     file's aggregate, which is the behaviour under test anyway.
 */
const withDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await pool!.query('DELETE FROM conversation.outbox WHERE aggregate_id = $1', [AGGREGATE]);
    await fn();
  });

/** Events this file created, isolated from whatever else the suite is publishing. */
const mine = (publisher: MockEventPublisher): readonly DomainEventEnvelope[] =>
  publisher.publishedEvents().filter((e) => e.payload.conversationId === AGGREGATE);

const myPendingCount = async (): Promise<number> => {
  const row = await pool!.query(
    `SELECT count(*)::int AS c FROM conversation.outbox
      WHERE aggregate_id = $1 AND state IN ('PENDING','PROCESSING') AND next_attempt_at <= now()`,
    [AGGREGATE],
  );
  return row.rows[0].c as number;
};

describe('draining committed rows', () => {
  withDb('publishes a pending row to realtime and the event fabric, then marks it published', async () => {
    const outboxId = await seedRow();
    const backplane = new InProcessBackplane();
    const publisher = new MockEventPublisher();
    const received: RealtimeEvent[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: AGGREGATE }, (e) => received.push(e));

    const relay = new OutboxRelay({ pool: pool!, backplane, publisher, logger });
    /**
     * Drained until THIS row settles rather than once. A batch is bounded (100) and
     * ordered by age, so on the shared database a freshly seeded row can sit behind other
     * suites' pending rows — which is what happened on 2026-08-29 once the product began
     * emitting six event types instead of two. Repeating the drain is also what the relay
     * does in production, so this is the more faithful assertion, not a looser one.
     */
    await drainUntilSettled(relay, outboxId);

    expect(received).toHaveLength(1);
    expect(mine(publisher)).toHaveLength(1);
    expect((await stateOf(outboxId)).state).toBe('PUBLISHED');
  });

  withDb('does not republish an already-published row', async () => {
    await seedRow();
    const backplane = new InProcessBackplane();
    const publisher = new MockEventPublisher();
    const relay = new OutboxRelay({ pool: pool!, backplane, publisher, logger });

    await relay.drainOnce();
    await relay.drainOnce();
    await relay.drainOnce();
    // Mine was delivered exactly once, however much other traffic the relay also drained.
    expect(mine(publisher)).toHaveLength(1);
    expect(await myPendingCount()).toBe(0);
  });

  withDb('routes the event to its conversation channel', async () => {
    await seedRow();
    const backplane = new InProcessBackplane();
    const elsewhere: RealtimeEvent[] = [];
    await backplane.subscribe(
      { kind: 'CONVERSATION', conversationId: crypto.randomUUID() },
      (e) => elsewhere.push(e),
    );
    await new OutboxRelay({ pool: pool!, backplane, publisher: new MockEventPublisher(), logger }).drainOnce();
    expect(elsewhere).toHaveLength(0);
  });
});

describe('failure handling', () => {
  withDb('retries with backoff rather than losing the event', async () => {
    const outboxId = await seedRow();
    const publisher = new MockEventPublisher();
    // Fail only THIS file's event. A count-based failure would hit whichever event
    // the relay happened to publish first, making the test depend on scheduling.
    publisher.failWhen((e) => e.payload.conversationId === AGGREGATE);

    const relay = new OutboxRelay({ pool: pool!, backplane: new InProcessBackplane(), publisher, logger });
    const first = await relay.drainOnce();

    expect(first.retried).toBeGreaterThanOrEqual(1);
    const after = await stateOf(outboxId);
    expect(after.state).toBe('PENDING');
    expect(after.attempts).toBe(1);

    // Backoff pushed next_attempt_at into the future, so MY row is not yet re-claimable.
    expect(await myPendingCount()).toBe(0);
  });

  withDb('dead-letters a row that keeps failing, instead of retrying forever', async () => {
    const outboxId = await seedRow();
    const publisher = new MockEventPublisher();
    publisher.failWhen((e) => e.payload.conversationId === AGGREGATE);

    // maxAttempts 1 so the first failure is terminal; backoff is irrelevant here.
    const relay = new OutboxRelay({
      pool: pool!,
      backplane: new InProcessBackplane(),
      publisher,
      logger,
      maxAttempts: 1,
    });
    const result = await relay.drainOnce();

    expect(result.deadLettered).toBeGreaterThanOrEqual(1);
    expect((await stateOf(outboxId)).state).toBe('DEAD_LETTER');
  });

  withDb('still delivers when the realtime backplane fails — realtime is best effort', async () => {
    // Losing realtime costs latency, not correctness (FR-RT-1). The row must still
    // reach the event fabric and be marked published.
    const outboxId = await seedRow();
    const brokenBackplane = {
      ...new InProcessBackplane(),
      publish: async () => ({
        ok: false as const,
        error: {
          code: 'BACKPLANE_DOWN',
          message: 'down',
          retryable: true,
          failureClass: 'FAIL_DEGRADED' as const,
          correlationId: 'test',
        },
      }),
      subscribe: async () => ({ ok: true as const, value: () => undefined }),
      localSubscriberCount: () => 0,
      health: async () => ({ status: 'DOWN' as const, authority: 'MOCK' as const, checkedAt: '' }),
    };

    const relay = new OutboxRelay({
      pool: pool!,
      backplane: brokenBackplane,
      publisher: new MockEventPublisher(),
      logger,
    });
    expect((await relay.drainOnce()).published).toBeGreaterThanOrEqual(1);
    // The assertion that matters is MY row's fate, not the batch size — the batch may
    // also contain rows another test file created moments ago.
    expect((await stateOf(outboxId)).state).toBe('PUBLISHED');
  });
});

describe('concurrency and visibility', () => {
  withDb('two relays running at once do not deliver the same event twice', async () => {
    // SKIP LOCKED means they share the work; without it, both would claim every row.
    for (let i = 0; i < 12; i += 1) await seedRow();

    const publisher = new MockEventPublisher();
    const options = { pool: pool!, backplane: new InProcessBackplane(), publisher, logger, batchSize: 12 };
    const [a, b] = await Promise.all([
      new OutboxRelay(options).drainOnce(),
      new OutboxRelay(options).drainOnce(),
    ]);

    expect(a.published + b.published).toBeGreaterThanOrEqual(12);
    // The decisive assertion: exactly 12 deliveries for 12 rows, no duplicates.
    expect(mine(publisher)).toHaveLength(12);
  });

  withDb('reports depth and oldest age for the alerts', async () => {
    await seedRow();
    await seedRow();
    const relay = new OutboxRelay({
      pool: pool!,
      backplane: new InProcessBackplane(),
      publisher: new MockEventPublisher(),
      logger,
    });
    expect((await relay.metrics()).depth).toBeGreaterThanOrEqual(2);
    await relay.drainOnce();
    expect(await myPendingCount()).toBe(0);
  });
});

describe('staff-only marking (§27.16)', () => {
  withDb('marks an internal note staff-only so it can never fan out to a customer', async () => {
    await seedRow({ payload: { conversationId: AGGREGATE, seq: 1, visibility: 'INTERNAL' } });
    const backplane = new InProcessBackplane();
    const received: RealtimeEvent[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: AGGREGATE }, (e) => received.push(e));

    await new OutboxRelay({ pool: pool!, backplane, publisher: new MockEventPublisher(), logger }).drainOnce();
    expect(received[0]?.staffOnly).toBe(true);
  });

  withDb('defaults to staff-only for any event not explicitly customer-visible', async () => {
    // Erring toward staff-only means a new event type is invisible to customers by
    // default rather than exposed by oversight (§27.16 fail-closed serialisation).
    await seedRow({ eventName: 'conversation.escalated.v1', payload: { conversationId: AGGREGATE } });
    const backplane = new InProcessBackplane();
    const received: RealtimeEvent[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: AGGREGATE }, (e) => received.push(e));

    await new OutboxRelay({ pool: pool!, backplane, publisher: new MockEventPublisher(), logger }).drainOnce();
    expect(received[0]?.staffOnly).toBe(true);
  });

  withDb('marks a resolution event customer-visible', async () => {
    await seedRow({
      eventName: 'conversation.resolved.v1',
      payload: { conversationId: AGGREGATE, caseId: crypto.randomUUID(), outcomeCode: 'DONE' },
    });
    const backplane = new InProcessBackplane();
    const received: RealtimeEvent[] = [];
    await backplane.subscribe({ kind: 'CONVERSATION', conversationId: AGGREGATE }, (e) => received.push(e));

    await new OutboxRelay({ pool: pool!, backplane, publisher: new MockEventPublisher(), logger }).drainOnce();
    expect(received[0]?.staffOnly).toBe(false);
  });
});
