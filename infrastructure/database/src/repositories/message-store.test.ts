/**
 * The message write path against real PostgreSQL.
 *
 * The unit tests in `packages/messaging` prove the invariants against an in-memory
 * store. These prove the SAME invariants survive contact with the database — the
 * transaction really rolls back, the unique index really catches a duplicate
 * idempotency key, and the sequence really serialises under concurrency.
 *
 * A port design is only worth something if both sides agree, so this runs the real
 * `sendMessage` against the real store rather than testing the SQL in isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sendMessage, type MessageStore } from '@starlink/messaging';
import type { ActorContext } from '@starlink/conversation-domain';
import { PgMessageReader, PgMessageStore } from './message-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

let pool: pg.Pool | undefined;
let available = false;
let store: MessageStore;
let reader: PgMessageReader;

const OWNER_ID = '018f2c5a-6666-7000-8000-0000000000aa';
const OUTSIDER_ID = '018f2c5a-6666-7000-8000-0000000000bb';
const TEAM_ID = 'msgstore-team';
let conversationId: string;
let caseId: string;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 12 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    store = new PgMessageStore(probe);
    reader = new PgMessageReader(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ PgMessageStore tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Message Store Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ($1,'EMPLOYEE','Store Owner','Service'), ($2,'EMPLOYEE','Store Outsider','Service')
     ON CONFLICT (principal_id) DO NOTHING`,
    [OWNER_ID, OUTSIDER_ID],
  );
});

afterAll(async () => {
  // Leave the development database as we found it; otherwise repeated runs silently
  // accumulate thousands of rows and later timing observations get noisy.
  if (pool !== undefined && available) {
    await pool.query(
      `DELETE FROM conversation.outbox
        WHERE aggregate_id IN (SELECT conversation_id FROM conversation.conversations
                                WHERE case_id IN (SELECT case_id FROM conversation.service_cases
                                                   WHERE owning_team_id = $1))`,
      [TEAM_ID],
    );
    await pool.query(
      `DELETE FROM conversation.messages
        WHERE conversation_id IN (SELECT conversation_id FROM conversation.conversations
                                   WHERE case_id IN (SELECT case_id FROM conversation.service_cases
                                                      WHERE owning_team_id = $1))`,
      [TEAM_ID],
    );
    await pool.query(
      `DELETE FROM conversation.conversations
        WHERE case_id IN (SELECT case_id FROM conversation.service_cases WHERE owning_team_id = $1)`,
      [TEAM_ID],
    );
    await pool.query('DELETE FROM conversation.service_cases WHERE owning_team_id = $1', [TEAM_ID]);
    await pool.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
      [OWNER_ID, OUTSIDER_ID],
    ]);
    await pool.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

/** Fresh conversation per test, so ordering and sequence assertions are independent. */
const freshConversation = async (): Promise<void> => {
  if (pool === undefined) return;
  caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO conversation.service_cases (case_id, owning_team_id, current_owner_id, state, customer_ref)
     VALUES ($1,$2,$3,'ACTIVE','CCS:customer:c-1')`,
    [caseId, TEAM_ID, OWNER_ID],
  );
  await pool.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, customer_ref, last_seq)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','CCS:customer:c-1',0)`,
    [conversationId, caseId],
  );
};

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: OWNER_ID,
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [TEAM_ID],
  departments: ['Service'],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

const deps = () => ({
  store,
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
});

const send = (over: Partial<Parameters<typeof sendMessage>[0]> = {}) =>
  sendMessage(
    {
      conversationId,
      actor: actor(),
      senderDisplayName: 'Store Owner',
      body: 'hello from postgres',
      visibility: 'CUSTOMER_VISIBLE',
      correlationId: 'pg-corr',
      ...over,
    },
    deps(),
  );

const withDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await freshConversation();
    await fn();
  });

const countRows = async (table: string, column: string, value: string): Promise<number> => {
  const result = await pool!.query(`SELECT count(*)::int AS c FROM ${table} WHERE ${column} = $1`, [value]);
  return result.rows[0].c as number;
};

describe('PgMessageStore — write path against real PostgreSQL', () => {
  withDb('persists the message and its outbox row together', async () => {
    const result = await send();
    expect(result.ok).toBe(true);
    expect(await countRows('conversation.messages', 'conversation_id', conversationId)).toBe(1);
    expect(await countRows('conversation.outbox', 'aggregate_id', conversationId)).toBe(1);
  });

  withDb('rolls back BOTH when the transaction fails after the writes', async () => {
    // The real proof of gate (c): a committed message whose event never existed is
    // the drift the outbox exists to prevent (brief §17).
    const exploding: MessageStore = {
      transaction: (work) =>
        store.transaction(async (tx) => {
          await work(tx);
          throw new Error('simulated failure after write');
        }),
    };
    await expect(
      sendMessage(
        {
          conversationId,
          actor: actor(),
          senderDisplayName: 'Store Owner',
          body: 'doomed',
          visibility: 'CUSTOMER_VISIBLE',
          correlationId: 'pg-corr',
        },
        { ...deps(), store: exploding },
      ),
    ).rejects.toThrow('simulated failure');

    expect(await countRows('conversation.messages', 'conversation_id', conversationId)).toBe(0);
    expect(await countRows('conversation.outbox', 'aggregate_id', conversationId)).toBe(0);
  });

  withDb('refuses a non-participant and writes nothing', async () => {
    const result = await send({ actor: actor({ principalId: OUTSIDER_ID, teams: [] }) });
    expect(result.ok).toBe(false);
    expect(await countRows('conversation.messages', 'conversation_id', conversationId)).toBe(0);
  });

  withDb('returns the original message when an idempotency key is retried', async () => {
    const first = await send({ clientMessageId: 'retry-key' });
    const retry = await send({ clientMessageId: 'retry-key' });
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.duplicate).toBe(true);
      expect(retry.message.messageId).toBe(first.message.messageId);
    }
    expect(await countRows('conversation.messages', 'conversation_id', conversationId)).toBe(1);
  });

  withDb('allocates a gap-free sequence under CONCURRENT sends', async () => {
    // The row lock in loadConversationForUpdate is what makes this hold. Without it
    // two sends could be handed the same sequence and one insert would violate the
    // (conversation_id, seq) unique constraint.
    const sends = Array.from({ length: 20 }, (_, i) => send({ clientMessageId: `concurrent-${i}` }));
    const results = await Promise.all(sends);
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await pool!.query(
      'SELECT seq FROM conversation.messages WHERE conversation_id = $1 ORDER BY seq',
      [conversationId],
    );
    expect(rows.rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  withDb('keeps internal-note text out of the conversation preview', async () => {
    await send({ visibility: 'INTERNAL', body: 'staff-only assessment' });
    const row = await pool!.query(
      'SELECT last_message_preview FROM conversation.conversations WHERE conversation_id = $1',
      [conversationId],
    );
    expect(row.rows[0].last_message_preview).toBe('');
  });
});

describe('PgMessageReader — paging', () => {
  withDb('filters by visibility at the query, not in application code', async () => {
    // ADR-021: the customer read path must never load internal rows at all.
    await send({ visibility: 'CUSTOMER_VISIBLE', body: 'visible one', clientMessageId: 'v1' });
    await send({ visibility: 'INTERNAL', body: 'internal one', clientMessageId: 'i1' });

    const customerView = await reader.readPage({
      conversationId,
      visibility: ['CUSTOMER_VISIBLE'],
      limit: 50,
    });
    expect(customerView).toHaveLength(1);
    expect(customerView[0]?.body).toBe('visible one');

    const staffView = await reader.readPage({
      conversationId,
      visibility: ['CUSTOMER_VISIBLE', 'INTERNAL'],
      limit: 50,
    });
    expect(staffView).toHaveLength(2);
  });

  withDb('pages backwards with a compound keyset, without repeating or skipping', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await send({ body: `message ${i}`, clientMessageId: `page-${i}` });
    }

    const first = await reader.readPage({ conversationId, visibility: ['CUSTOMER_VISIBLE'], limit: 4 });
    const last = first[first.length - 1];
    expect(last).toBeDefined();

    const second = await reader.readPage({
      conversationId,
      visibility: ['CUSTOMER_VISIBLE'],
      limit: 4,
      before: { createdAt: last!.createdAt, id: last!.messageId },
    });

    const firstIds = new Set(first.map((m) => m.messageId));
    // No overlap between pages, and the ordering continues strictly downwards.
    expect(second.some((m) => firstIds.has(m.messageId))).toBe(false);
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(first.map((m) => m.seq)).toEqual([10, 9, 8, 7]);
    expect(second.map((m) => m.seq)).toEqual([6, 5, 4, 3]);
  });
});
