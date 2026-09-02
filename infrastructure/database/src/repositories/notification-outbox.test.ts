/**
 * The notification outbox, the idempotency ledger and recipient resolution, against real
 * PostgreSQL.
 *
 * The unit tests for these use in-memory fakes with the same intended semantics. That is
 * fine for the sequencing, and useless for the part that only the database can get right:
 * the conditional UPDATE that makes two workers produce one delivery, the partial unique
 * index that makes two writers produce one notification, and `FOR UPDATE SKIP LOCKED`.
 *
 * A fake cannot disagree with itself. The database can, and this is where that is caught.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgNotificationOutbox } from './notification-outbox.js';
import { PgIdempotencyLedger } from './idempotency-ledger.js';
import { PgNotificationRecipients } from './notification-recipients.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `9a9a` block — owned by this file alone. */
const OWNER = '018f2c5a-9a9a-7000-8000-00000000000a';
const LEAD = '018f2c5a-9a9a-7000-8000-00000000000b';
const EX_LEAD = '018f2c5a-9a9a-7000-8000-00000000000c';
const DEPARTED_LEAD = '018f2c5a-9a9a-7000-8000-00000000000d';
const TEAM_ID = 'notification-outbox-team';
const OTHER = '018f2c5a-9a9a-7000-8000-00000000000e';
const ALL = [OWNER, LEAD, EX_LEAD, DEPARTED_LEAD, OTHER];

const AT = '2026-08-28T12:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
const ENDED = '2026-08-10T00:00:00.000Z';

let pool: pg.Pool | undefined;
let outbox: PgNotificationOutbox;
let ledger: PgIdempotencyLedger;
let recipients: PgNotificationRecipients;
let available = false;
let conversationId: string;
let caseId: string;

const written: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    outbox = new PgNotificationOutbox(probe);
    ledger = new PgIdempotencyLedger(probe);
    recipients = new PgNotificationRecipients(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ notification outbox tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Notification Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','Outbox Owner','Service','ACTIVE'),
            ($2,'EMPLOYEE','Outbox Lead','Service','ACTIVE'),
            ($3,'EMPLOYEE','Outbox Ex-Lead','Service','ACTIVE'),
            ($4,'EMPLOYEE','Outbox Departed Lead','Service','EXITED'),
            ($5,'EMPLOYEE','Outbox Other Employee','Service','ACTIVE')
     ON CONFLICT (principal_id) DO NOTHING`,
    ALL,
  );
  await probe.query(
    `INSERT INTO identity.role_assignments
       (assignment_id, principal_id, role, scope_kind, scope_id, effective_from, effective_to, granted_by)
     VALUES (gen_random_uuid(), $2, 'TEAM_LEAD', 'TEAM', $1, $5, NULL,  $2),
            (gen_random_uuid(), $3, 'TEAM_LEAD', 'TEAM', $1, $5, $6,    $2),
            (gen_random_uuid(), $4, 'TEAM_LEAD', 'TEAM', $1, $5, NULL,  $2)`,
    [TEAM_ID, LEAD, EX_LEAD, DEPARTED_LEAD, PAST, ENDED],
  );

  caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await probe.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id, customer_ref)
     VALUES ($1,'ACTIVE',$2,$3,'CCS:customer:outbox-1')`,
    [caseId, TEAM_ID, OWNER],
  );
  await probe.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, customer_ref, state, title)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'CCS:customer:outbox-1','ACTIVE','Outbox thread')`,
    [conversationId, caseId],
  );
  await probe.query(
    `INSERT INTO conversation.ownership_episodes
       (episode_id, conversation_id, case_id, owner_id, effective_from, assignment_source)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LEAD_ASSIGNED')`,
    [conversationId, caseId, OWNER, PAST],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    if (written.length > 0) {
      await pool.query(
        'DELETE FROM conversation.notification_outbox WHERE notification_id = ANY($1::uuid[])',
        [written],
      );
    }
    await pool.query(`DELETE FROM conversation.idempotency_records WHERE scope LIKE 'test.ledger%'`);
    await pool.query('DELETE FROM conversation.ownership_episodes WHERE conversation_id = $1', [
      conversationId,
    ]);
    await pool.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [
      conversationId,
    ]);
    await pool.query('DELETE FROM conversation.service_cases WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM identity.role_assignments WHERE scope_id = $1', [TEAM_ID]);
    await pool.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [ALL]);
    await pool.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
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

const enqueue = async (dedupeKey: string | undefined, channel = 'INAPP'): Promise<string> => {
  const notificationId = crypto.randomUUID();
  written.push(notificationId);
  await outbox.enqueue({
    notificationId: notificationId as never,
    recipientId: OWNER as never,
    recipientKind: 'EMPLOYEE',
    channel,
    event: 'CONVERSATION_ASSIGNED',
    targetRef: conversationId,
    payload: {},
    ...(dedupeKey !== undefined ? { dedupeKey } : {}),
    at: AT as never,
  });
  return notificationId;
};

const stateOf = async (id: string): Promise<string | undefined> => {
  const row = await pool!.query(
    'SELECT state FROM conversation.notification_outbox WHERE notification_id = $1',
    [id],
  );
  return row.rows[0]?.state as string | undefined;
};

describe('dedupe is the database’s, not the caller’s', () => {
  withDb('suppresses a second row for the same key', async () => {
    const key = `test-dedupe-${crypto.randomUUID()}`;
    const first = await enqueue(key);
    const second = await enqueue(key);

    expect(await stateOf(first)).toBe('PENDING');
    // Not an error, and not a second notification. §29.5 exists to make this happen.
    expect(await stateOf(second)).toBeUndefined();
  });

  withDb('folds a burst into the waiting row and carries the count', async () => {
    /**
     * §29.5 asks for "'3 new messages', not three notifications" — the COUNT, not just
     * the suppression. Dropping the second and third gives one notification saying "you
     * have an update", which is less use than the three it replaced.
     */
    const key = `test-coalesce-${crypto.randomUUID()}`;
    const first = await enqueue(key);
    await enqueue(key);
    await enqueue(key);

    const row = await pool!.query(
      'SELECT coalesced_count FROM conversation.notification_outbox WHERE notification_id = $1',
      [first],
    );
    // Two FURTHER events folded in; the renderer adds one for the row itself.
    expect(row.rows[0].coalesced_count).toBe(2);

    const claimed = await outbox.claimDue(50, AT as never);
    expect(claimed.find((r) => r.notificationId === first)?.coalescedCount).toBe(2);
  });

  withDb('stops folding once the row has been claimed', async () => {
    /**
     * A claimed row is on its way to a provider. Bumping its count then would change a
     * message that has already left, so the fold stops and the next event is genuinely
     * suppressed for the rest of the window — the honest limit of window-based
     * coalescing rather than a bug in it.
     */
    const key = `test-coalesce-claimed-${crypto.randomUUID()}`;
    const id = await enqueue(key);
    await outbox.claimDue(50, AT as never);

    // Not an insert (the key is taken) and not a fold (the row is PROCESSING).
    const accepted = await enqueue(key);
    expect(await stateOf(accepted)).toBeUndefined();

    const row = await pool!.query(
      'SELECT coalesced_count FROM conversation.notification_outbox WHERE notification_id = $1',
      [id],
    );
    expect(row.rows[0].coalesced_count).toBe(0);
  });

  withDb('lets a different CHANNEL through on the same event', async () => {
    // The badge-and-no-email failure. The service puts the channel in the key; this
    // proves the index does not collapse the two anyway.
    const base = crypto.randomUUID();
    const inApp = await enqueue(`INAPP:test-${base}`);
    const email = await enqueue(`EMAIL:test-${base}`, 'EMAIL');

    expect(await stateOf(inApp)).toBe('PENDING');
    expect(await stateOf(email)).toBe('PENDING');
  });

  withDb('does not let a dead-lettered row block a later notification', async () => {
    /**
     * The partial unique index excludes DEAD_LETTER on purpose: a notification that
     * failed permanently in March must not silently suppress the same event in April.
     */
    const key = `test-dedupe-dl-${crypto.randomUUID()}`;
    const dead = await enqueue(key);
    await outbox.claimDue(10, AT as never);
    await outbox.markDeadLetter(dead as never, 'INVALID_ADDRESS', AT as never);
    expect(await stateOf(dead)).toBe('DEAD_LETTER');

    const later = await enqueue(key);
    expect(await stateOf(later)).toBe('PENDING');
  });
});

describe('claim, deliver, dead-letter, replay', () => {
  withDb('only claims rows whose next attempt is due', async () => {
    const id = await enqueue(`test-backoff-${crypto.randomUUID()}`);
    const [claimed] = await outbox.claimDue(50, AT as never);
    expect(claimed).toBeDefined();

    await outbox.markRetrying(id as never, 3_600_000, 'PROVIDER_DOWN', AT as never);
    const again = await outbox.claimDue(50, AT as never);
    // Invisible until its time comes — otherwise the worker spins against a dead provider.
    expect(again.map((r) => r.notificationId)).not.toContain(id);
  });

  withDb('marks sent only from PROCESSING', async () => {
    /**
     * The conditional predicate is what makes two workers safe. A second worker that
     * somehow marks a row it never claimed would be reporting a delivery that did not
     * happen — the silent version of the failure §29.6 cares about.
     */
    const id = await enqueue(`test-sent-${crypto.randomUUID()}`);
    await outbox.markSent(id as never, AT as never);
    // Still PENDING: it was never claimed, so the UPDATE matched nothing.
    expect(await stateOf(id)).toBe('PENDING');

    await outbox.claimDue(50, AT as never);
    await outbox.markSent(id as never, AT as never);
    expect(await stateOf(id)).toBe('SENT');
  });

  withDb('replays a dead-lettered row with a full retry budget', async () => {
    const id = await enqueue(`test-replay-${crypto.randomUUID()}`);
    await outbox.claimDue(50, AT as never);
    await outbox.markDeadLetter(id as never, 'EMAIL_PROVIDER_NOT_CONFIGURED', AT as never);

    const replayed = await outbox.replay(id as never, AT as never);
    expect(replayed).toBe(true);
    expect(await stateOf(id)).toBe('PENDING');

    const row = await pool!.query(
      'SELECT attempts, dedupe_key, last_error_code FROM conversation.notification_outbox WHERE notification_id = $1',
      [id],
    );
    // Attempts reset, or a replay after the provider is repaired dies on its first retry.
    expect(row.rows[0].attempts).toBe(0);
    // The key is cleared: its window is long past, and keeping it would let a newer
    // notification for the same event collide with the replayed old one.
    expect(row.rows[0].dedupe_key).toBeNull();
    expect(row.rows[0].last_error_code).toBeNull();

    // Second replay does nothing — two operators clicking at once produce one replay.
    expect(await outbox.replay(id as never, AT as never)).toBe(false);
  });

  withDb('recovers a row abandoned in PROCESSING', async () => {
    const id = await enqueue(`test-stalled-${crypto.randomUUID()}`);
    await outbox.claimDue(50, AT as never);
    expect(await stateOf(id)).toBe('PROCESSING');

    const reclaimed = await outbox.reclaimStalled('2027-01-01T00:00:00.000Z' as never, 50);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect(await stateOf(id)).toBe('PENDING');
  });
});

describe('the idempotency ledger', () => {
  withDb('claims once, then reports a completed key as a duplicate', async () => {
    const scope = 'test.ledger.a';
    const key = crypto.randomUUID();

    expect((await ledger.claim(scope, key, AT as never)).status).toBe('FRESH');
    // Claimed but not completed — a first attempt that has not finished.
    expect((await ledger.claim(scope, key, AT as never)).status).toBe('RECLAIMED');

    await ledger.complete(scope, key, { resultRef: 'message:1' });
    const third = await ledger.claim(scope, key, AT as never);
    expect(third.status).toBe('DUPLICATE');
    expect(third.status === 'DUPLICATE' && third.entry.resultRef).toBe('message:1');
  });

  withDb('two concurrent claims of the same key produce one FRESH', async () => {
    /**
     * The whole reason the claim is an `ON CONFLICT DO NOTHING` insert rather than a
     * check-then-insert. A provider that fans a webhook out to two instances arrives
     * here simultaneously, and exactly one of them must do the work.
     */
    const scope = 'test.ledger.b';
    const key = crypto.randomUUID();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => ledger.claim(scope, key, AT as never)),
    );

    expect(outcomes.filter((o) => o.status === 'FRESH')).toHaveLength(1);
  });
});

describe('recipient resolution', () => {
  withDb('reads the owner from the open ownership episode', async () => {
    expect(await recipients.ownerOf(conversationId as never)).toBe(OWNER);
  });

  withDb('finds the team behind the conversation', async () => {
    expect(await recipients.teamOf(conversationId as never)).toBe(TEAM_ID);
  });

  withDb('returns live leads only, and never an inactive one', async () => {
    const leads = await recipients.leadsOfTeam(TEAM_ID, AT as never);

    expect(leads).toContain(LEAD);
    // The grant ended on 10 August. A lapsed grant is not authority.
    expect(leads).not.toContain(EX_LEAD);
    // Still granted, but EXITED. Notifying them reads as coverage that is not there.
    expect(leads).not.toContain(DEPARTED_LEAD);
  });
});

describe('the in-app notification list (§19.6, §20.7)', () => {
  /** A delivered in-app notification, which is what the list shows. */
  const delivered = async (recipient = OWNER): Promise<string> => {
    const notificationId = crypto.randomUUID();
    written.push(notificationId);
    await outbox.enqueue({
      notificationId: notificationId as never,
      recipientId: recipient as never,
      recipientKind: 'EMPLOYEE',
      channel: 'INAPP',
      event: 'CONVERSATION_ASSIGNED',
      targetRef: conversationId,
      payload: {},
      dedupeKey: `list-${notificationId}`,
      at: AT as never,
    });
    await pool!.query(
      `UPDATE conversation.notification_outbox SET state = 'SENT' WHERE notification_id = $1`,
      [notificationId],
    );
    return notificationId;
  };

  withDb('shows a delivered in-app notification to its recipient', async () => {
    const id = await delivered();
    const rows = await outbox.listFor(OWNER as never, { limit: 50 });
    expect(rows.map((r) => r.notificationId)).toContain(id);
  });

  withDb('NEVER shows one principal the notifications of another', async () => {
    /**
     * §20.7 authorizes the notification event "personal room, self only", and the same
     * rule governs its HTTP fallback. The recipient predicate IS the boundary here —
     * there is no conversation to run an object check against — so this is the negative
     * that matters most in the file.
     */
    const mine = await delivered(OWNER);
    const theirs = await delivered(OTHER);

    const ids = (await outbox.listFor(OWNER as never, { limit: 100 })).map((r) => r.notificationId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  withDb('does not show an EMAIL row in the in-app list', async () => {
    // The same notification travelling a second way. Showing both would tell the
    // recipient twice about one thing and make the bell disagree with their inbox.
    const notificationId = crypto.randomUUID();
    written.push(notificationId);
    await outbox.enqueue({
      notificationId: notificationId as never,
      recipientId: OWNER as never,
      recipientKind: 'EMPLOYEE',
      channel: 'EMAIL',
      event: 'TRANSFERRED',
      payload: {},
      dedupeKey: `list-email-${notificationId}`,
      at: AT as never,
    });
    await pool!.query(
      `UPDATE conversation.notification_outbox SET state = 'SENT' WHERE notification_id = $1`,
      [notificationId],
    );

    const ids = (await outbox.listFor(OWNER as never, { limit: 100 })).map((r) => r.notificationId);
    expect(ids).not.toContain(notificationId);
  });

  withDb('does not show a row the worker has not delivered yet', async () => {
    // In-app delivery IS the row reaching SENT. A PENDING row would appear in the bell
    // before the pipeline had accepted it.
    const notificationId = crypto.randomUUID();
    written.push(notificationId);
    await outbox.enqueue({
      notificationId: notificationId as never,
      recipientId: OWNER as never,
      recipientKind: 'EMPLOYEE',
      channel: 'INAPP',
      event: 'CUSTOMER_REPLIED',
      payload: {},
      dedupeKey: `list-pending-${notificationId}`,
      at: AT as never,
    });

    const ids = (await outbox.listFor(OWNER as never, { limit: 100 })).map((r) => r.notificationId);
    expect(ids).not.toContain(notificationId);
  });
});

describe('read state (N-19 — an engineering decision, no source)', () => {
  const delivered = async (recipient = OWNER): Promise<string> => {
    const notificationId = crypto.randomUUID();
    written.push(notificationId);
    await outbox.enqueue({
      notificationId: notificationId as never,
      recipientId: recipient as never,
      recipientKind: 'EMPLOYEE',
      channel: 'INAPP',
      event: 'ROLE_OR_ACCESS_CHANGED',
      payload: {},
      dedupeKey: `read-${notificationId}`,
      at: AT as never,
    });
    await pool!.query(
      `UPDATE conversation.notification_outbox SET state = 'SENT' WHERE notification_id = $1`,
      [notificationId],
    );
    return notificationId;
  };

  withDb('marking read removes it from the unread view and the count', async () => {
    const id = await delivered();
    const before = await outbox.unreadCount(OWNER as never);

    expect(await outbox.markRead(OWNER as never, id as never, AT as never)).toBe(true);

    expect(await outbox.unreadCount(OWNER as never)).toBe(before - 1);
    const unread = await outbox.listFor(OWNER as never, { limit: 100, unreadOnly: true });
    expect(unread.map((r) => r.notificationId)).not.toContain(id);
    // Still in the full list — read is not deleted. "What was I told last week" is a
    // question a notification list should be able to answer.
    const all = await outbox.listFor(OWNER as never, { limit: 100 });
    expect(all.map((r) => r.notificationId)).toContain(id);
  });

  withDb('a principal cannot mark another principal\u2019s notification read', async () => {
    // The same predicate as the list, on the write path. A read-then-write would leave a
    // window; the WHERE clause has none.
    const theirs = await delivered(OTHER);
    expect(await outbox.markRead(OWNER as never, theirs as never, AT as never)).toBe(false);

    const row = await pool!.query(
      'SELECT read_at FROM conversation.notification_outbox WHERE notification_id = $1',
      [theirs],
    );
    expect(row.rows[0].read_at).toBeNull();
  });

  withDb('marking read twice does not move the timestamp', async () => {
    // Idempotent, so a double-click does not rewrite when the person first saw it.
    const id = await delivered();
    await outbox.markRead(OWNER as never, id as never, AT as never);
    const later = '2026-08-29T09:00:00.000Z';
    expect(await outbox.markRead(OWNER as never, id as never, later as never)).toBe(false);

    const row = await pool!.query(
      'SELECT read_at FROM conversation.notification_outbox WHERE notification_id = $1',
      [id],
    );
    expect(new Date(row.rows[0].read_at).toISOString()).toBe(AT);
  });

  withDb('read-all clears this principal only', async () => {
    await delivered(OWNER);
    await delivered(OWNER);
    const theirs = await delivered(OTHER);

    const cleared = await outbox.markAllRead(OWNER as never, AT as never);
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(await outbox.unreadCount(OWNER as never)).toBe(0);
    // Untouched.
    expect(await outbox.unreadCount(OTHER as never)).toBeGreaterThanOrEqual(1);
    expect(theirs).toBeDefined();
  });
});
