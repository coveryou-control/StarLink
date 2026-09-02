/**
 * The outbox funnel refuses what the catalogue does not describe.
 *
 * §10 declares sixteen events and §14 makes them a versioned contract. Until 2026-08-29
 * the only thing checking that contract was `MockEventPublisher`, at PUBLISH time — after
 * the row was committed, so a malformed payload could not fail the request that produced
 * it and instead became a poison row that retried and dead-lettered. An operational
 * incident standing in for a programming error.
 *
 * These tests pin the write-time half. The publisher's check stays: two boundaries, which
 * is the right number for a contract that crosses a process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';
import { assertDatabaseAllowed } from '../guard.js';
import { appendOutboxIn, UnpublishableEvent } from './outbox-writer.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const CONVERSATION = '018f2c5a-0b17-7000-8000-00000000000a' as UUID;

let pool: pg.Pool | undefined;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 3 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
    available = true;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ outbox writer SKIPPED: no PostgreSQL.\n');
  }
}, 60_000);

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = $1`, [CONVERSATION]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, body: (client: pg.PoolClient) => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      console.warn(`  ⚠ UNPROVEN: ${name}`);
      ctx.skip();
      return;
    }
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await body(client);
    } finally {
      // Always rolled back: these tests are about what the funnel ACCEPTS, and leaving
      // rows behind would pollute the shared dev database (N-41).
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);
};

describe('the outbox funnel validates against §10', () => {
  withDb('accepts an event whose payload matches the catalogue', async (client) => {
    await appendOutboxIn(client, {
      eventName: 'conversation.resolved.v1',
      aggregateType: 'conversation',
      aggregateId: CONVERSATION,
      payload: {
        conversationId: CONVERSATION,
        caseId: '018f2c5a-0b17-7000-8000-00000000000b',
        outcomeCode: 'Answered.',
        actorId: '018f2c5a-0b17-7000-8000-00000000000c',
      },
      correlationId: 'ow-1',
    });

    const rows = await client.query(
      `SELECT event_name, event_version, state FROM conversation.outbox WHERE aggregate_id = $1`,
      [CONVERSATION],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].event_name).toBe('conversation.resolved.v1');
    // PENDING, not published: the relay is what publishes, and P-05 puts the record first.
    expect(rows.rows[0].state).toBe('PENDING');
  });

  withDb('refuses an event that is not in the catalogue', async (client) => {
    /**
     * An unknown name is rejected rather than passed through. A consumer subscribing to
     * §10's catalogue would never see it, so writing it is a silent loss dressed as a
     * successful publish.
     */
    await expect(
      appendOutboxIn(client, {
        eventName: 'conversation.vanished.v1',
        aggregateType: 'conversation',
        aggregateId: CONVERSATION,
        payload: { conversationId: CONVERSATION },
        correlationId: 'ow-2',
      }),
    ).rejects.toBeInstanceOf(UnpublishableEvent);
  });

  withDb('refuses a known event whose payload is wrong, and writes nothing', async (client) => {
    // `conversation.resolved.v1` requires caseId, outcomeCode and actorId. Missing them is
    // the realistic mistake — a caller that had the conversation id and assumed the rest.
    await expect(
      appendOutboxIn(client, {
        eventName: 'conversation.resolved.v1',
        aggregateType: 'conversation',
        aggregateId: CONVERSATION,
        payload: { conversationId: CONVERSATION },
        correlationId: 'ow-3',
      }),
    ).rejects.toBeInstanceOf(UnpublishableEvent);

    const rows = await client.query(
      `SELECT count(*)::int AS n FROM conversation.outbox WHERE aggregate_id = $1`,
      [CONVERSATION],
    );
    // The refusal happens BEFORE the insert, so the caller's transaction is still clean
    // and can commit whatever else it was doing — or, as here, roll back with nothing lost.
    expect(rows.rows[0].n).toBe(0);
  });

  withDb('carries the §20.7 events the realtime rooms depend on', async (client) => {
    /**
     * Both were added on 2026-08-29 (N-27). The team and principal rooms had been
     * joinable since Phase 3 with nothing publishing to either, so a queue view and a
     * notification bell both received silence and updated only on reload.
     */
    await appendOutboxIn(client, {
      eventName: 'conversation.queue.arrived.v1',
      aggregateType: 'conversation',
      aggregateId: CONVERSATION,
      payload: {
        conversationId: CONVERSATION,
        teamId: 'renewals',
        priority: 'NORMAL',
        afterHours: false,
      },
      correlationId: 'ow-4',
    });

    await appendOutboxIn(client, {
      eventName: 'notification.created.v1',
      aggregateType: 'principal',
      aggregateId: CONVERSATION,
      payload: {
        notificationId: '018f2c5a-0b17-7000-8000-00000000000d',
        recipientId: CONVERSATION,
        event: 'CONVERSATION_ASSIGNED',
      },
      correlationId: 'ow-5',
    });

    const rows = await client.query(
      `SELECT event_name FROM conversation.outbox WHERE aggregate_id = $1 ORDER BY event_name`,
      [CONVERSATION],
    );
    expect(rows.rows.map((r) => r.event_name)).toEqual([
      'conversation.queue.arrived.v1',
      'notification.created.v1',
    ]);
  });
});
