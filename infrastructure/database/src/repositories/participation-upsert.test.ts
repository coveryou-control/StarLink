/**
 * `addParticipant` is an upsert, and its two branches mean opposite things.
 *
 * `ON CONFLICT (conversation_id, principal_id)` fires on a DEAD row and on a LIVE one, and
 * the right behaviour differs:
 *
 *   * **Dead row — revive with the CALLER's values.** Anything else is a privilege
 *     escalation. A row dated out while holding `OWNER` / `reply_authority = true` used to
 *     be revived still holding them: claim, remove, transfer away, then re-add the original
 *     owner as a plain participant, and they could address the customer again on a
 *     conversation somebody else now owned. `decide()` reads reply authority straight off
 *     this row.
 *   * **Live row — change nothing.** The domain command hardcodes `role: 'PARTICIPANT',
 *     replyAuthority: false`, so applying the caller's values to a live row DEMOTES whoever
 *     is named. Point it at the sitting owner and their `reply_authority` goes false while
 *     `ownership_episodes` and `service_cases.current_owner_id` still record them as the
 *     owner — the owner silently unable to answer their own customer, with no error and
 *     nothing that reads as a permission change. Overwriting `effective_from` on the same
 *     row is BR-09's question ("could they read this on 5 March?") starting to answer no
 *     for a participation that never lapsed.
 *
 * The first fix did the first half and broke the second. Both are pinned here.
 *
 * ## Why this is tested at the STORE and not through the API
 *
 * `addParticipant` in `@starlink/conversation-domain` refuses `ALREADY_PARTICIPANT` before
 * it reaches the upsert, so the live-row branch is unreachable over HTTP today. A reviewer
 * read the demotion as live over that route; it is not. But "unreachable" is a property of
 * one caller, and this is a public repository method — the second layer has to be correct
 * on its own terms, and it needs a test that can actually reach it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import { assertDatabaseAllowed } from '../guard.js';
import { PgConversationStore } from './conversation-store.js';

const CONNECTION =
  process.env['SL_DATABASE_URL'] ??
  'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const TEAM = 'participation-upsert-team';

let pool: pg.Pool | undefined;
let store: PgConversationStore | undefined;
let available = false;

const conversations: string[] = [];
const cases: string[] = [];
const principals: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 3 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    store = new PgConversationStore(probe);
    await probe.query(
      `INSERT INTO identity.teams (team_id, display_name) VALUES ($1,$1)
       ON CONFLICT (team_id) DO NOTHING`,
      [TEAM],
    );
  } catch {
    await probe.end().catch(() => undefined);
    console.warn(
      '\n  ⚠ participation upsert check SKIPPED: no PostgreSQL. The revive/preserve ' +
        'semantics of addParticipant are UNPROVEN in this run.\n',
    );
  }
});

afterAll(async () => {
  if (pool !== undefined) {
    await pool.query(`DELETE FROM conversation.participants WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [principals]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, fn: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await fn();
  });
};

async function principal(): Promise<UUID> {
  const id = crypto.randomUUID();
  principals.push(id);
  await pool!.query(
    `INSERT INTO identity.principals (principal_id, kind, status, display_name)
     VALUES ($1,'EMPLOYEE','ACTIVE','Upsert Fixture')`,
    [id],
  );
  return id as UUID;
}

async function conversation(): Promise<UUID> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  cases.push(caseId);
  conversations.push(conversationId);
  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
    [caseId, TEAM],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'NEW','upsert fixture',$3)`,
    [conversationId, caseId, new Date().toISOString()],
  );
  return conversationId as UUID;
}

const rowFor = async (conversationId: UUID, principalId: UUID) =>
  (
    await pool!.query(
      `SELECT role, reply_authority, effective_to, effective_from
         FROM conversation.participants
        WHERE conversation_id = $1 AND principal_id = $2`,
      [conversationId, principalId],
    )
  ).rows[0];

describe('addParticipant upsert semantics', () => {
  withDb('revives a DEAD row with the caller\'s role, not the one it died holding', async () => {
    const conversationId = await conversation();
    const who = await principal();
    const adder = await principal();

    // Seeded directly as OWNER with reply authority, then dated out — the state a removed
    // ex-owner's row is left in.
    await pool!.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
          effective_from, effective_to)
       VALUES ($1,$2,'EMPLOYEE','OWNER',true,$3,$4,$5)`,
      [conversationId, who, adder, '2020-01-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z'],
    );

    const at = new Date().toISOString() as Timestamp;
    await store!.transaction(async (tx) => {
      await tx.addParticipant(
        conversationId,
        { principalId: who, principalKind: 'EMPLOYEE', role: 'PARTICIPANT', replyAuthority: false },
        adder,
        at,
      );
    });

    const row = await rowFor(conversationId, who);
    expect(row.effective_to, 'the row was not revived').toBeNull();
    expect(
      row.role,
      'a dead OWNER row was revived still holding OWNER — re-adding an ex-owner as a plain ' +
        'participant restores their authority over somebody else\'s conversation',
    ).toBe('PARTICIPANT');
    expect(row.reply_authority, 'reply authority survived the revival').toBe(false);
    // A genuinely new period, so BR-09 dates it from now rather than from 2020.
    expect(row.effective_from.toISOString()).toBe(at);
  });

  withDb('leaves a LIVE row exactly as it was', async () => {
    const conversationId = await conversation();
    const owner = await principal();
    const adder = await principal();

    const originalFrom = '2020-03-05T00:00:00.000Z';
    await pool!.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
          effective_from)
       VALUES ($1,$2,'EMPLOYEE','OWNER',true,$3,$4)`,
      [conversationId, owner, adder, originalFrom],
    );

    await store!.transaction(async (tx) => {
      await tx.addParticipant(
        conversationId,
        { principalId: owner, principalKind: 'EMPLOYEE', role: 'PARTICIPANT', replyAuthority: false },
        adder,
        new Date().toISOString() as Timestamp,
      );
    });

    const row = await rowFor(conversationId, owner);
    expect(row.role, 'the sitting owner was demoted by a re-add').toBe('OWNER');
    expect(
      row.reply_authority,
      'the owner lost reply authority over their own customer conversation while the case ' +
        'still records them as its owner',
    ).toBe(true);
    expect(
      row.effective_from.toISOString(),
      'the start of a participation that never lapsed was overwritten — BR-09 can no ' +
        'longer answer when their access actually began',
    ).toBe(originalFrom);
    expect(row.effective_to).toBeNull();
  });

  withDb('adds somebody who was never here', async () => {
    /**
     * The positive control. Without it, both cases above are satisfied by a store method
     * that writes nothing at all — "the row is unchanged" is trivially true of a row no
     * statement ever touched.
     */
    const conversationId = await conversation();
    const who = await principal();
    const adder = await principal();

    await store!.transaction(async (tx) => {
      await tx.addParticipant(
        conversationId,
        { principalId: who, principalKind: 'EMPLOYEE', role: 'PARTICIPANT', replyAuthority: false },
        adder,
        new Date().toISOString() as Timestamp,
      );
    });

    const row = await rowFor(conversationId, who);
    expect(row, 'no participant row was written at all').toBeDefined();
    expect(row.role).toBe('PARTICIPANT');
    expect(row.effective_to).toBeNull();
  });
});
