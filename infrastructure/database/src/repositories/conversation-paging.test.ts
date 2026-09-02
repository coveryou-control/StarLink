/**
 * Conversation-list paging and unread counts, against real PostgreSQL.
 *
 * The list was `LIMIT`-only until now, which silently truncated at 50 threads with no
 * way to see the rest. Adding a cursor introduces the classic paging hazards, and the
 * one that actually bites is the tiebreaker: `last_activity_at` is NOT unique — two
 * threads can move in the same millisecond, and a page boundary landing between them
 * either skips one or shows it twice. The row-value keyset carries the conversation id
 * for exactly that case, and the test below forces it by giving several conversations
 * an identical timestamp.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgConversationReader } from './conversation-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const READER = '018f2c5a-cccc-7000-8000-00000000000a';
const OTHER = '018f2c5a-cccc-7000-8000-00000000000b';
const OUTSIDER = '018f2c5a-cccc-7000-8000-00000000000c';
const PREFIX = 'paging-';

let pool: pg.Pool | undefined;
let reader: PgConversationReader;
let available = false;
let ids: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    reader = new PgConversationReader(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Conversation paging tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ($1,'EMPLOYEE','Paging Reader','Service'),
            ($2,'EMPLOYEE','Paging Other','Service'),
            ($3,'EMPLOYEE','Paging Outsider','Service')
     ON CONFLICT (principal_id) DO NOTHING`,
    [READER, OTHER, OUTSIDER],
  );

  const at = new Date('2026-08-25T10:00:00.000Z');
  ids = [];
  for (let i = 0; i < 12; i += 1) {
    const conversationId = crypto.randomUUID();
    ids.push(conversationId);
    // Deliberately COARSE timestamps: conversations 0-3 share one instant, 4-7 another,
    // 8-11 a third. Without the id tiebreaker, page boundaries inside those groups are
    // where rows get skipped or duplicated.
    const movedAt = new Date(at.getTime() + Math.floor(i / 4) * 60_000);
    await probe.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, title, last_activity_at, participant_count)
       VALUES ($1,'INTERNAL_GROUP',$2,$3,2)`,
      [conversationId, `${PREFIX}${String(i).padStart(2, '0')}`, movedAt],
    );
    await probe.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, added_by, effective_from, added_at)
       VALUES ($1,$2,'EMPLOYEE','MEMBER',$2,$4,$4), ($1,$3,'EMPLOYEE','MEMBER',$2,$4,$4)`,
      [conversationId, READER, OTHER, at.toISOString()],
    );
  }
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.read_state WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.participants WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [READER, OTHER, OUTSIDER],
    ]);
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
  });
};

/** Walks every page, returning the conversations in order. */
async function pageAll(principalId: string, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: { lastActivityAt: string; id: string } | undefined;

  for (let guard = 0; guard < 50; guard += 1) {
    const page = await reader.listForPrincipal(principalId, pageSize, cursor);
    if (page.length === 0) break;
    seen.push(...page.map((c) => c.title ?? ''));
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!;
    cursor = { lastActivityAt: last.lastActivityAt, id: last.conversationId };
  }
  return seen;
}

describe('conversation list paging', () => {
  withDb('returns the newest first', async () => {
    const page = await reader.listForPrincipal(READER, 4);
    // 8-11 share the newest timestamp.
    expect(page.map((c) => c.title).every((t) => t!.startsWith(PREFIX))).toBe(true);
    expect(page).toHaveLength(4);
  });

  withDb('walks every conversation exactly once across pages', async () => {
    const walked = (await pageAll(READER, 5)).filter((t) => t.startsWith(PREFIX));

    // The property that matters: no skips, no repeats. Twelve conversations, page size
    // five, and boundaries that fall inside groups sharing a timestamp.
    expect(new Set(walked).size).toBe(12);
    expect(walked).toHaveLength(12);
  });

  withDb('survives a page size that divides the tied groups exactly', async () => {
    // Page size 2 puts every boundary INSIDE a group of four identical timestamps,
    // which is where a keyset without a tiebreaker fails.
    const walked = (await pageAll(READER, 2)).filter((t) => t.startsWith(PREFIX));

    expect(new Set(walked).size).toBe(12);
    expect(walked).toHaveLength(12);
  });

  withDb('produces a stable descending order', async () => {
    const walked = (await pageAll(READER, 3)).filter((t) => t.startsWith(PREFIX));
    const groups = walked.map((t) => Math.floor(Number(t.slice(PREFIX.length)) / 4));

    // Group 2 (newest) before group 1 before group 0. Within a group the order is by id
    // and unspecified, but it must be CONSISTENT — which the no-repeats test covers.
    expect(groups).toEqual([...groups].sort((a, b) => b - a));
  });

  withDb('returns nothing to someone who is not a participant', async () => {
    // Scope is the join, not a filter applied afterwards. A forgotten predicate here
    // would hand over the company's conversations.
    const page = await reader.listForPrincipal(OUTSIDER, 50);
    expect(page.filter((c) => (c.title ?? '').startsWith(PREFIX))).toEqual([]);
  });

  withDb('a cursor from one page does not resurrect earlier rows', async () => {
    const first = await reader.listForPrincipal(READER, 4);
    const last = first[first.length - 1]!;
    const second = await reader.listForPrincipal(READER, 4, {
      lastActivityAt: last.lastActivityAt,
      id: last.conversationId,
    });

    const firstIds = new Set(first.map((c) => c.conversationId));
    expect(second.some((c) => firstIds.has(c.conversationId))).toBe(false);
  });
});

describe('unread counts', () => {
  withDb('counts messages from others that are newer than the read marker', async () => {
    const target = ids[0]!;
    for (let seq = 1; seq <= 3; seq += 1) {
      await pool!.query(
        `INSERT INTO conversation.messages
           (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
            sender_display_name, body)
         VALUES ($1,$2,$3,'INTERNAL',$4,'EMPLOYEE','Paging Other','hello')`,
        [crypto.randomUUID(), target, seq, OTHER],
      );
    }

    const page = await reader.listForPrincipal(READER, 50);
    const row = page.find((c) => c.conversationId === target);
    expect(row?.unreadCount).toBe(3);
  });

  withDb('does not count the reader’s OWN messages as unread', async () => {
    const target = ids[1]!;
    await pool!.query(
      `INSERT INTO conversation.messages
         (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
          sender_display_name, body)
       VALUES ($1,$2,1,'INTERNAL',$3,'EMPLOYEE','Paging Reader','my own message')`,
      [crypto.randomUUID(), target, READER],
    );

    const page = await reader.listForPrincipal(READER, 50);
    // A thread showing "1 unread" because you just posted in it is the classic bug.
    expect(page.find((c) => c.conversationId === target)?.unreadCount).toBe(0);
  });

  withDb('drops to zero once the read marker passes them', async () => {
    const target = ids[2]!;
    for (let seq = 1; seq <= 2; seq += 1) {
      await pool!.query(
        `INSERT INTO conversation.messages
           (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
            sender_display_name, body)
         VALUES ($1,$2,$3,'INTERNAL',$4,'EMPLOYEE','Paging Other','unread')`,
        [crypto.randomUUID(), target, seq, OTHER],
      );
    }
    await pool!.query(
      `INSERT INTO conversation.read_state (principal_id, conversation_id, last_read_seq, last_read_at)
       VALUES ($1,$2,2,now())
       ON CONFLICT (principal_id, conversation_id)
       DO UPDATE SET last_read_seq = 2`,
      [READER, target],
    );

    const page = await reader.listForPrincipal(READER, 50);
    expect(page.find((c) => c.conversationId === target)?.unreadCount).toBe(0);
  });
});

describe('naming a conversation from its participants', () => {
  /**
   * The employee list had no way to name an internal thread. Titles are optional and
   * nobody types one for a colleague chat, so every direct message rendered as
   * "Untitled conversation" — `participantCount` was the only participant fact the
   * summary carried, and a number cannot name anybody.
   */
  withDb('returns the OTHER live participants for an internal conversation', async () => {
    const page = await reader.listForPrincipal(READER, 50);
    const row = page.find((c) => (c.title ?? '').startsWith(PREFIX));
    expect(row, 'the paging fixture is missing — this proves nothing').toBeDefined();

    const names = (row?.participants ?? []).map((p) => p.displayName);
    expect(names, 'participants were not returned for an internal conversation').toEqual([
      'Paging Other',
    ]);
    expect(
      names,
      'the caller is in their own list — their own name says nothing about the thread',
    ).not.toContain('Paging Reader');
  });

  withDb('withholds participants for a CUSTOMER conversation', async () => {
    /**
     * The Stage 2 payload must stay exactly as it was. A customer conversation is named by
     * its case, needs no participant names, and the join is gated on the type so the field
     * is ABSENT rather than empty — which is also what lets the UI tell "not asked" from
     * "nobody else here".
     */
    const conversationId = crypto.randomUUID();
    const caseId = crypto.randomUUID();
    const at = new Date('2026-08-30T09:00:00.000Z').toISOString();
    try {
      await pool!.query(
        `INSERT INTO conversation.service_cases (case_id, state) VALUES ($1,'NEW')`,
        [caseId],
      );
      await pool!.query(
        `INSERT INTO conversation.conversations
           (conversation_id, conversation_type, case_id, state, title, last_activity_at, participant_count)
         VALUES ($1,'CUSTOMER_SERVICE',$2,'NEW','paging-customer',$3,2)`,
        [conversationId, caseId, at],
      );
      await pool!.query(
        `INSERT INTO conversation.participants
           (conversation_id, principal_id, principal_kind, role, added_by, effective_from, added_at)
         VALUES ($1,$2,'EMPLOYEE','OWNER',$2,$3,$3), ($1,$4,'EMPLOYEE','MEMBER',$2,$3,$3)`,
        [conversationId, READER, at, OTHER],
      );

      const page = await reader.listForPrincipal(READER, 50);
      const row = page.find((c) => c.conversationId === conversationId);
      expect(row, 'the customer fixture was not returned at all').toBeDefined();
      expect(
        row?.participants,
        'participant names leaked into a customer conversation summary',
      ).toBeUndefined();
    } finally {
      await pool!.query(`DELETE FROM conversation.participants WHERE conversation_id = $1`, [conversationId]);
      await pool!.query(`DELETE FROM conversation.conversations WHERE conversation_id = $1`, [conversationId]);
      await pool!.query(`DELETE FROM conversation.service_cases WHERE case_id = $1`, [caseId]);
    }
  });

  withDb('never returns a conversation the caller is not in', async () => {
    /**
     * The authorization boundary this feature must not widen. `listForPrincipal` reaches a
     * row only through an INNER JOIN on the caller's own live participation, and adding a
     * lateral join over OTHER participants must not have turned that into a way to see a
     * thread from the outside.
     */
    const page = await reader.listForPrincipal(OUTSIDER, 50);
    expect(
      page.filter((c) => (c.title ?? '').startsWith(PREFIX)),
      'an outsider can see conversations they are not part of',
    ).toEqual([]);
  });
});
