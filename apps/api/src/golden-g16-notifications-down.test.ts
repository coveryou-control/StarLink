/**
 * GOLDEN TEST G-16 — "Notification provider down | messages unaffected; outbox
 * accumulates; drains on recovery; DLQ visible".
 *
 * §34.3, clause by clause:
 *
 *   * **Effect** — "External notifications are delayed. **Messages are unaffected**"
 *   * **Behaviour** — "Outbox rows stay pending and retry with backoff (§29.4).
 *     **In-app notification and unread counts are unaffected** because they are not
 *     provider-dependent"
 *   * **Visibility** — "Outbox depth and dead-letter count are alerted on (§32.4). **A
 *     silent notification backlog is the real failure mode — worse than the outage**"
 *   * **Permanent failure** — "Dead-lettered … not retried indefinitely"
 *   * **Why it cannot cascade** — "P-05 — the record was written before delivery was
 *     attempted"
 *
 * ## What this adds over `notification-sweeps.test.ts`
 *
 * That file already proves the sweep's state machine — accumulate, back off, drain,
 * dead-letter — against an in-memory outbox, and this does not repeat it. What it cannot
 * prove, because it has no database and no message path, is the two CROSS-CUTTING claims
 * that make G-16 a golden test rather than a unit test:
 *
 *   1. a message still sends while the provider is down (the cascade §34.3 forbids), and
 *   2. the IN-APP channel keeps working while the external one fails — which is the
 *      difference between "notifications are degraded" and "notifications are down".
 *
 * Both are asserted here against the real `PgNotificationOutbox` and the real sweep, with
 * one transport failing and one healthy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  assertDatabaseAllowed,
  PgMessageStore,
  PgNotificationOutbox,
  resetTeamFixtures,
} from '@starlink/database';
import { createLogger } from '@starlink/observability';
import { sendMessage } from '@starlink/messaging';
import { NotificationDeliverySweep } from '@starlink/sweeps';
import { err, ok, type NotificationTransport, type Timestamp, type UUID } from '@starlink/shared-contracts';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** The `0b16` block belongs to this file alone. */
const AGENT = '018f2c5a-0b16-7000-8000-00000000000a';
const TEAM_ID = 'g16-notify-team';

const logger = createLogger({ service: 'g16-notifications-down', level: 'error' });

let pool: pg.Pool | undefined;
let available = false;
let outbox: PgNotificationOutbox;
let messages: PgMessageStore;
let conversationId: UUID;
let caseId: UUID;

/** Flipped mid-test to prove recovery drains what accumulated. */
let providerUp = false;
let emailAttempts = 0;

const emailTransport: NotificationTransport = {
  channel: 'EMAIL',
  async deliver() {
    emailAttempts += 1;
    if (providerUp) return ok('DELIVERED');
    return err({
      code: 'PROVIDER_UNREACHABLE',
      message: 'the relay did not answer',
      // Retryable and QUEUED: §34.3's "rows stay pending and retry with backoff". A
      // FAIL_CLOSED here would be a provider telling the product to deny, which is how
      // an outage becomes an outage of something else.
      retryable: true,
      failureClass: 'FAIL_QUEUED',
      correlationId: 'g16',
    });
  },
  async health() {
    return {
      status: providerUp ? 'UP' : 'DOWN',
      authority: 'MOCK',
      checkedAt: new Date().toISOString() as Timestamp,
    };
  },
};

/**
 * In-app never touches a provider. §29.6 makes it "the unread mechanism", which is why
 * §34.3 can say in-app is unaffected: the row IS the notification.
 */
const inAppTransport: NotificationTransport = {
  channel: 'INAPP',
  async deliver() {
    return ok('DELIVERED');
  },
  async health() {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() as Timestamp };
  },
};

const sweep = (): NotificationDeliverySweep =>
  new NotificationDeliverySweep({
    outbox: outbox as never,
    transports: new Map<string, NotificationTransport>([
      ['EMAIL', emailTransport],
      ['INAPP', inAppTransport],
    ]),
    render: (row) => ({
      recipientPrincipalId: row.recipientId,
      subject: 'A customer conversation assigned to you',
      body: 'There is something to look at in StarLink.',
    }),
    // Low, so the dead-letter boundary is reachable in a test without simulating a day.
    policy: { maxAttempts: 3 },
    logger,
  });

const enqueue = async (channel: string): Promise<UUID> => {
  const notificationId = crypto.randomUUID() as UUID;
  await outbox.enqueue({
    notificationId,
    recipientId: AGENT as UUID,
    recipientKind: 'EMPLOYEE',
    channel,
    event: 'CONVERSATION_ASSIGNED',
    targetRef: conversationId,
    payload: {},
    at: new Date().toISOString() as Timestamp,
  });
  return notificationId;
};

const stateOf = async (notificationId: UUID): Promise<string> => {
  const row = await pool!.query(
    `SELECT state FROM conversation.notification_outbox WHERE notification_id = $1`,
    [notificationId],
  );
  return row.rows[0]?.state as string;
};

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 4 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
    available = true;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ G-16 SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'G16 Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','G16 Agent','Service','ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE SET status = 'ACTIVE'`,
    [AGENT],
  );

  caseId = crypto.randomUUID() as UUID;
  conversationId = crypto.randomUUID() as UUID;
  const at = new Date().toISOString();
  await probe.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id)
     VALUES ($1,'ACTIVE',$2,$3)`,
    [caseId, TEAM_ID, AGENT],
  );
  await probe.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at, last_seq)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','G16 thread',$3,0)`,
    [conversationId, caseId, at],
  );
  await probe.query(
    `INSERT INTO conversation.ownership_episodes
       (episode_id, conversation_id, case_id, owner_id, effective_from, assignment_source)
     VALUES ($1,$2,$3,$4,$5,'ROUTED')`,
    [crypto.randomUUID(), conversationId, caseId, AGENT, at],
  );

  outbox = new PgNotificationOutbox(probe);
  messages = new PgMessageStore(probe);
}, 60_000);

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.notification_outbox WHERE recipient_id = $1`, [AGENT]);
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = $1`, [conversationId]);
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [AGENT]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, body: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      console.warn(`  ⚠ UNPROVEN (G-16): ${name}`);
      ctx.skip();
      return;
    }
    await body();
  }, 60_000);
};

describe('G-16 — notification provider down (§34.3)', () => {
  withDb('leaves message sending completely unaffected', async () => {
    /**
     * P-05, which §34.3 names as the reason the outage cannot cascade: "the record was
     * written before delivery was attempted". A send while the provider is down is the
     * direct test of it.
     */
    providerUp = false;

    const sent = await sendMessage(
      {
        conversationId,
        actor: {
          principalId: AGENT as UUID,
          kind: 'EMPLOYEE',
          status: 'ACTIVE',
          teams: [TEAM_ID],
          departments: ['Service'],
          grants: [],
          delegations: [],
          temporaryGrants: [],
        },
        senderDisplayName: 'G16 Agent',
        body: 'This reply must not depend on an email relay.',
        visibility: 'CUSTOMER_VISIBLE',
        correlationId: 'g16-send',
      },
      { store: messages, now: () => new Date(), newId: () => crypto.randomUUID() as UUID },
    );

    expect(sent.ok, 'a notification outage took the message path with it').toBe(true);
  });

  withDb('delivers in-app while the external channel fails — they are not one thing', async () => {
    /**
     * §34.3's most easily lost clause. In-app is not provider-dependent, so an email
     * outage must not stop an agent seeing that something needs them. If both channels
     * failed together the product would be reporting "notifications are down" when the
     * mechanism people actually watch is fine.
     */
    providerUp = false;
    const inApp = await enqueue('INAPP');
    const email = await enqueue('EMAIL');

    await sweep().run();

    expect(await stateOf(inApp)).toBe('SENT');
    // Never SENT while it was not sent — the first of the two ways to make a backlog
    // silent that this file exists to rule out.
    expect(await stateOf(email)).toBe('RETRYING');

    // And the unread count — §29.6's "in-app is the unread mechanism" — still moves.
    expect(await outbox.unreadCount(AGENT as UUID)).toBeGreaterThan(0);
  });

  withDb('accumulates a visible backlog rather than a silent one', async () => {
    providerUp = false;
    await enqueue('EMAIL');
    await enqueue('EMAIL');

    await sweep().run();

    /**
     * §34.3: "Outbox depth and dead-letter count are alerted on (§32.4). A silent
     * notification backlog is the real failure mode — worse than the outage." The counts
     * are what `NotificationBacklogNotDraining` and `DeadLetterRising` read.
     */
    const counts = await outbox.counts();
    expect(counts.pending).toBeGreaterThan(0);
  });

  withDb('dead-letters after the attempt limit, and the DLQ is readable', async () => {
    providerUp = false;
    const doomed = await enqueue('EMAIL');

    // maxAttempts is 3. Each run claims what is due; backoff is bypassed by asking the
    // sweep for a later "now" rather than by waiting.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await new NotificationDeliverySweep({
        outbox: outbox as never,
        transports: new Map<string, NotificationTransport>([['EMAIL', emailTransport]]),
        render: () => ({
          recipientPrincipalId: AGENT as UUID,
          subject: 'A customer conversation assigned to you',
          body: 'There is something to look at in StarLink.',
        }),
        policy: { maxAttempts: 3 },
        logger,
        // Far enough ahead that every backoff has elapsed.
        now: () => new Date(Date.now() + attempt * 60 * 60_000),
      }).run();
      if ((await stateOf(doomed)) === 'DEAD_LETTER') break;
    }

    expect(await stateOf(doomed), '§29.6: "not retried forever"').toBe('DEAD_LETTER');

    // "Dead-lettered, principal flagged for administrative attention" — the row survives
    // as evidence and is reachable by the admin surface, not discarded.
    const dead = await outbox.deadLettered(50);
    expect(dead.some((row) => row.notificationId === doomed)).toBe(true);
    expect((await outbox.counts()).deadLetter).toBeGreaterThan(0);
  });

  withDb('drains everything that accumulated once the provider returns', async () => {
    providerUp = false;
    const waiting = await enqueue('EMAIL');
    await sweep().run();
    expect(await stateOf(waiting)).toBe('RETRYING');

    // Recovery. §29.6: "rows accumulate as pending and drain on recovery."
    providerUp = true;
    await new NotificationDeliverySweep({
      outbox: outbox as never,
      transports: new Map<string, NotificationTransport>([['EMAIL', emailTransport]]),
      render: () => ({
        recipientPrincipalId: AGENT as UUID,
        subject: 'A customer conversation assigned to you',
        body: 'There is something to look at in StarLink.',
      }),
      policy: { maxAttempts: 3 },
      logger,
      now: () => new Date(Date.now() + 60 * 60_000),
    }).run();

    expect(await stateOf(waiting)).toBe('SENT');
    // Nothing was lost on the way: the row was attempted, not discarded and re-created.
    expect(emailAttempts).toBeGreaterThan(1);
  });
});
