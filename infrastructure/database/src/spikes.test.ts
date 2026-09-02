/**
 * Phase 1 validation spikes (b), (c), (d).
 *
 * These prove the three load-bearing assumptions of ADR-001 against a real PostgreSQL
 * rather than asserting them in prose. Doc §45 makes the same point about its own
 * technology-validation gate: cheap to test now, expensive to discover later.
 *
 *   (b) message paging examines a bounded number of rows  -> the 301-vs-20,000 property
 *   (c) transactional outbox commits atomically with the message it describes
 *   (d) atomic claim yields exactly one winner under heavy concurrency
 *
 * Requires a database. If SL_DATABASE_URL is unreachable the suite SKIPS LOUDLY — it
 * must never pass silently, because a green tick on an unrun gate is worse than a red
 * one on a failing test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from './guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

let pool: pg.Pool | undefined;
let dbAvailable = false;

beforeAll(async () => {
  // The guard applies to tests too. These spikes create and delete rows, so pointing
  // them at the wrong database would be destructive, not merely wrong (§35.4).
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 12 });
  try {
    await probe.query('SELECT 1');
    dbAvailable = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn(
      '\n  ⚠ SPIKES SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n' +
        '    Phase 1 gates (b) paging, (c) outbox and (d) atomic claim are UNPROVEN in this run.\n' +
        '    Start the stack with `pnpm dev:up` and re-run.\n',
    );
  }
});

afterAll(async () => {
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, fn: (p: pg.Pool) => Promise<void>) =>
  it(name, async (ctx) => {
    if (!dbAvailable || pool === undefined) {
      // Reported as SKIPPED, never as passed. A green tick on a gate that never ran is
      // worse than a red one on a failing test: it is a false claim of evidence.
      ctx.skip();
      return;
    }
    await fn(pool);
  });

const uuid = (): string => crypto.randomUUID();

async function seedConversation(p: pg.Pool, messageCount: number): Promise<string> {
  const conversationId = uuid();
  await p.query(
    `INSERT INTO conversation.conversations (conversation_id, conversation_type, state, last_seq)
     VALUES ($1, 'CUSTOMER_SERVICE', 'ACTIVE', $2)`,
    [conversationId, messageCount],
  );
  // One multi-row insert: the point of the spike is the READ shape, not write speed.
  await p.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body, created_at)
     SELECT gen_random_uuid(), $1, g, 'CUSTOMER_VISIBLE', 'CUSTOMER', 'Spike Customer',
            'message ' || g, now() - (($2 - g) * interval '1 second')
     FROM generate_series(1, $2) g`,
    [conversationId, messageCount],
  );
  return conversationId;
}

describe('gate (b) — message paging examines rows proportional to rows returned', () => {
  withDb('keeps rows-examined close to rows-returned on a 20k-message conversation', async (p) => {
    const conversationId = await seedConversation(p, 20_000);
    await p.query('ANALYZE conversation.messages');

    const pageSize = 50;
    const explain = await p.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       SELECT message_id, created_at FROM conversation.messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC, message_id DESC
       LIMIT $2`,
      [conversationId, pageSize],
    );

    const plan = explain.rows[0]['QUERY PLAN'][0]['Plan'];
    const planText = JSON.stringify(plan);

    // The index must serve the ordering. A sort here means the compound index is not
    // being used, which is precisely the regression doc §38 measured.
    expect(planText, 'query plan should not contain a blocking sort').not.toContain('"Node Type":"Sort"');
    expect(planText).toContain('Index');

    const rowsReturned: number = plan['Actual Rows'];
    const rowsExamined: number = collectRowsExamined(plan);
    expect(rowsReturned).toBe(pageSize);
    // The alert threshold in infrastructure/monitoring/alerts.yml is 3.
    expect(rowsExamined / Math.max(rowsReturned, 1)).toBeLessThanOrEqual(3);

    await p.query('DELETE FROM conversation.messages WHERE conversation_id = $1', [conversationId]);
    await p.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [conversationId]);
  });
});

function collectRowsExamined(plan: Record<string, unknown>): number {
  let total = Number(plan['Actual Rows'] ?? 0);
  const children = plan['Plans'];
  if (Array.isArray(children)) {
    for (const child of children) total += collectRowsExamined(child as Record<string, unknown>);
  }
  return total;
}

describe('gate (c) — transactional outbox', () => {
  withDb('commits the message and its event together, or neither', async (p) => {
    const conversationId = await seedConversation(p, 0);
    const messageId = uuid();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conversation.messages
           (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
         VALUES ($1, $2, 1, 'CUSTOMER_VISIBLE', 'EMPLOYEE', 'Spike Agent', 'hello')`,
        [messageId, conversationId],
      );
      await client.query(
        `INSERT INTO conversation.outbox
           (outbox_id, event_name, event_version, aggregate_type, aggregate_id, payload, correlation_id)
         VALUES ($1, 'message.created.v1', 1, 'conversation', $2, $3, $4)`,
        [uuid(), conversationId, JSON.stringify({ messageId, conversationId, seq: 1 }), 'spike-corr'],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const both = await p.query(
      `SELECT (SELECT count(*) FROM conversation.messages WHERE message_id = $1) AS msg,
              (SELECT count(*) FROM conversation.outbox WHERE aggregate_id = $2) AS evt`,
      [messageId, conversationId],
    );
    expect(Number(both.rows[0].msg)).toBe(1);
    expect(Number(both.rows[0].evt)).toBe(1);

    // And the negative case: a failure after the message insert must leave NEITHER.
    const failing = await p.connect();
    const doomedId = uuid();
    try {
      await failing.query('BEGIN');
      await failing.query(
        `INSERT INTO conversation.messages
           (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
         VALUES ($1, $2, 2, 'CUSTOMER_VISIBLE', 'EMPLOYEE', 'Spike Agent', 'doomed')`,
        [doomedId, conversationId],
      );
      await failing.query('INSERT INTO conversation.outbox (outbox_id) VALUES ($1)', [uuid()]); // violates NOT NULL
      await failing.query('COMMIT');
    } catch {
      await failing.query('ROLLBACK');
    } finally {
      failing.release();
    }
    const orphan = await p.query('SELECT count(*) AS c FROM conversation.messages WHERE message_id = $1', [
      doomedId,
    ]);
    expect(Number(orphan.rows[0].c), 'a message must not survive its failed event write').toBe(0);

    await p.query('DELETE FROM conversation.outbox WHERE aggregate_id = $1', [conversationId]);
    await p.query('DELETE FROM conversation.messages WHERE conversation_id = $1', [conversationId]);
    await p.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [conversationId]);
  });
});

describe('gate (d) — atomic claim under concurrency (golden tests G-06/G-07)', () => {
  withDb('100 simultaneous claimants produce exactly one winner', async (p) => {
    const teamId = `spike-team-${Date.now()}`;
    await p.query('INSERT INTO identity.teams (team_id, display_name) VALUES ($1, $2)', [teamId, 'Spike Team']);
    const conversationId = await seedConversation(p, 0);
    const queueEntryId = uuid();
    await p.query(
      `INSERT INTO conversation.queue_entries (queue_entry_id, conversation_id, team_id, state)
       VALUES ($1, $2, $3, 'WAITING')`,
      [queueEntryId, conversationId, teamId],
    );

    const claimants = Array.from({ length: 100 }, () => uuid());
    await p.query(
      `INSERT INTO identity.principals (principal_id, kind, display_name)
       SELECT unnest($1::uuid[]), 'EMPLOYEE', 'Spike Claimant'`,
      [claimants],
    );

    // The claim: a single conditional UPDATE. Exactly one transaction can move the row
    // out of WAITING, so the winner is decided by the database rather than by ordering
    // luck in application code (brief §44).
    const attempts = claimants.map(async (principalId) => {
      const client = await p.connect();
      try {
        const res = await client.query(
          `UPDATE conversation.queue_entries
              SET state = 'CLAIMED', claimed_by = $1, claimed_at = now()
            WHERE queue_entry_id = $2 AND state = 'WAITING'
            RETURNING queue_entry_id`,
          [principalId, queueEntryId],
        );
        return res.rowCount === 1;
      } finally {
        client.release();
      }
    });

    const results = await Promise.all(attempts);
    const winners = results.filter(Boolean).length;
    expect(winners, 'exactly one claimant must win').toBe(1);
    expect(results.length - winners, 'everyone else is told it is taken').toBe(99);

    await p.query('DELETE FROM conversation.queue_entries WHERE queue_entry_id = $1', [queueEntryId]);
    await p.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [conversationId]);
    await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [claimants]);
    await p.query('DELETE FROM identity.teams WHERE team_id = $1', [teamId]);
  });
});

describe('database-enforced invariants', () => {
  withDb('refuses two overlapping ownership episodes for one conversation (BR-10)', async (p) => {
    const conversationId = await seedConversation(p, 0);
    const ownerA = uuid();
    const ownerB = uuid();
    await p.query(
      `INSERT INTO identity.principals (principal_id, kind, display_name)
       VALUES ($1, 'EMPLOYEE', 'Owner A'), ($2, 'EMPLOYEE', 'Owner B')`,
      [ownerA, ownerB],
    );
    await p.query(
      `INSERT INTO conversation.ownership_episodes
         (episode_id, conversation_id, owner_id, assignment_source)
       VALUES ($1, $2, $3, 'ROUTED')`,
      [uuid(), conversationId, ownerA],
    );

    await expect(
      p.query(
        `INSERT INTO conversation.ownership_episodes
           (episode_id, conversation_id, owner_id, assignment_source)
         VALUES ($1, $2, $3, 'CLAIMED')`,
        [uuid(), conversationId, ownerB],
      ),
      'a second open ownership episode must be impossible, not merely discouraged',
    ).rejects.toThrow();

    await p.query('DELETE FROM conversation.ownership_episodes WHERE conversation_id = $1', [conversationId]);
    await p.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [conversationId]);
    await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [[ownerA, ownerB]]);
  });

  withDb('refuses UPDATE and DELETE on the audit ledger (FR-AUD-1)', async (p) => {
    const eventId = uuid();
    await p.query(
      `INSERT INTO audit.ledger (event_id, actor_kind, action, target_kind, target_id, outcome, correlation_id)
       VALUES ($1, 'EMPLOYEE', 'conversation.transfer', 'conversation', 'spike', 'SUCCEEDED', 'spike-corr')`,
      [eventId],
    );
    await expect(
      p.query('UPDATE audit.ledger SET outcome = $1 WHERE event_id = $2', ['REFUSED', eventId]),
      'an audit trail that can be edited is not an audit trail',
    ).rejects.toThrow();
    await expect(p.query('DELETE FROM audit.ledger WHERE event_id = $1', [eventId])).rejects.toThrow();
  });
});
