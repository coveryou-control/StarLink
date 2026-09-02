/**
 * The case sweeps, against real PostgreSQL.
 *
 * Two properties carry the weight:
 *
 *   * **A stage fires ONCE.** Breach state is recomputed on every read, so without a
 *     record of having notified, a sweep running every minute would send the same breach
 *     alert every minute for as long as the case stayed breached — which is how a lead
 *     learns to ignore them.
 *   * **A customer's reply beats the closure sweep.** The reopen-window close is a
 *     conditional UPDATE rather than a read-then-write, so a conversation reopened in the
 *     same instant is not closed underneath the person typing into it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createLogger } from '@starlink/observability';
import { assertDatabaseAllowed } from '@starlink/database';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { BusinessCalendar, SlaState } from '@starlink/sla';

import { ReopenWindowClosureSweep, SlaBreachSweep, type SlaSweepPorts } from './case-sweeps.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `cf10` block — owned by this file alone. */
const TEAM_ID = 'case-sweep-team';
const OWNER = '018f2c5a-cf10-7000-8000-00000000000a';

let pool: pg.Pool | undefined;
let available = false;
const logger = createLogger({ service: 'case-sweeps-test', sink: () => undefined });
const cases: string[] = [];
const conversations: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ case sweep tests SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Case Sweep Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ($1,'EMPLOYEE','Sweep Owner','Service') ON CONFLICT (principal_id) DO NOTHING`,
    [OWNER],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.sla_notifications WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.case_state_episodes WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [OWNER]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
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
  }, 30_000);
};

/** A conversation in a given state, with an optional resolution time. */
async function makeCase(state: string, resolvedAt?: string): Promise<{ conversationId: UUID; caseId: UUID }> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  cases.push(caseId);
  conversations.push(conversationId);

  await pool!.query(
    `INSERT INTO conversation.service_cases
       (case_id, state, owning_team_id, current_owner_id, resolved_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [caseId, state === 'CLOSED' ? 'RESOLVED' : state, TEAM_ID, OWNER, resolvedAt ?? null],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,$3,'case sweep', now())`,
    [conversationId, caseId, state],
  );
  await pool!.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from)
     VALUES ($1,$2,$3, now() - interval '1 hour')`,
    [crypto.randomUUID(), conversationId, state],
  );
  return { conversationId: conversationId as UUID, caseId: caseId as UUID };
}

describe('ReopenWindowClosureSweep', () => {
  withDb('closes a resolved conversation once its window has passed', async () => {
    const long = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const { conversationId } = await makeCase('RESOLVED', long);

    const result = await new ReopenWindowClosureSweep({
      pool: pool!,
      logger,
      windowSeconds: 7 * 24 * 3600,
    }).run();

    expect(result.acted).toBeGreaterThan(0);
    const row = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].state).toBe('CLOSED');
  });

  withDb('leaves a conversation still inside its window alone', async () => {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    const { conversationId } = await makeCase('RESOLVED', recent);

    await new ReopenWindowClosureSweep({ pool: pool!, logger, windowSeconds: 7 * 24 * 3600 }).run();

    const row = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].state).toBe('RESOLVED');
  });

  withDb('never closes a conversation the customer has reopened', async () => {
    /**
     * The race the conditional UPDATE exists for. The case's `resolved_at` is old enough
     * to close, but the customer replied and the conversation is ACTIVE again. A
     * read-then-write sweep would close it underneath them, and they would be typing
     * into a thread the system considered finished.
     */
    const long = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const { conversationId } = await makeCase('ACTIVE', long);

    await new ReopenWindowClosureSweep({ pool: pool!, logger, windowSeconds: 7 * 24 * 3600 }).run();

    const row = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].state).toBe('ACTIVE');
  });

  withDb('records the closure in the append-only history, without overlapping', async () => {
    // The exclusion constraint would reject an overlap, so this proves the sweep closes
    // the previous episode at the same instant it opens CLOSED.
    const long = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const { conversationId } = await makeCase('RESOLVED', long);

    await new ReopenWindowClosureSweep({ pool: pool!, logger, windowSeconds: 7 * 24 * 3600 }).run();

    const episodes = await pool!.query(
      `SELECT state, effective_from, effective_to FROM conversation.case_state_episodes
        WHERE conversation_id = $1 ORDER BY effective_from`,
      [conversationId],
    );
    expect(episodes.rows).toHaveLength(2);
    expect(episodes.rows[1].state).toBe('CLOSED');
    // The previous episode is closed, not left open — otherwise two states would be live.
    expect(episodes.rows[0].effective_to).not.toBeNull();
    expect(episodes.rows[1].effective_to).toBeNull();
  });
});

describe('SlaBreachSweep', () => {
  const alwaysOpen: BusinessCalendar = {
    calendarId: 'sweep-cal',
    teamId: TEAM_ID,
    timezone: 'Asia/Kolkata',
    version: 1,
    effectiveFrom: '2020-01-01T00:00:00.000Z' as Timestamp,
    workingWindows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday: weekday as 0,
      openMinute: 0,
      closeMinute: 1439,
    })),
    holidays: [],
    exceptions: [],
    provisional: true,
  };

  /** Ports backed by the real tables for notification bookkeeping, stubbed elsewhere. */
  const portsFor = (conversationId: UUID, arrivedAt: Timestamp): SlaSweepPorts => ({
    openCases: async () => [conversationId],
    factsFor: async () => ({
      conversationId,
      teamId: TEAM_ID,
      arrivedAt,
      afterHours: false,
      waitingOnCustomerSpans: [],
    }),
    targetsFor: async () => [
      {
        clock: 'FIRST_RESPONSE',
        targetSeconds: 60,
        basis: 'CALENDAR_24X7',
        warningPct: 80,
        provisional: true,
        scopeKind: 'TEAM',
        scopeId: TEAM_ID,
      },
    ],
    calendarsFor: async () => [alwaysOpen],
    alreadyNotified: async (id, clock, level) => {
      const r = await pool!.query(
        `SELECT 1 FROM conversation.sla_notifications WHERE conversation_id=$1 AND clock=$2 AND level=$3`,
        [id, clock, level],
      );
      return (r.rowCount ?? 0) > 0;
    },
    recordNotification: async (input) => {
      const r = await pool!.query(
        `INSERT INTO conversation.sla_notifications
           (conversation_id, clock, level, notified_at, elapsed_seconds)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [input.conversationId, input.clock, input.level, input.at, input.elapsedSeconds],
      );
      return (r.rowCount ?? 0) > 0;
    },
  });

  withDb('notifies a breach exactly once, however often it runs', async () => {
    const { conversationId } = await makeCase('ACTIVE');
    // Arrived an hour ago against a 60-second target: comfortably breached.
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;

    const breaches: SlaState[] = [];
    const sweep = new SlaBreachSweep({
      ports: portsFor(conversationId, arrivedAt),
      notifier: {
        warn: async () => undefined,
        breach: async ({ state }) => void breaches.push(state),
        escalate: async () => undefined,
      },
      autoEscalates: () => false,
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    });

    const first = await sweep.run();
    const second = await sweep.run();
    const third = await sweep.run();

    expect(first.acted).toBe(1);
    // Still breached on every subsequent run, and silent on every one of them.
    expect(second.acted).toBe(0);
    expect(third.acted).toBe(0);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.status).toBe('BREACHED');
  });

  withDb('says nothing about a case comfortably inside its target', async () => {
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 5_000).toISOString() as Timestamp;

    let told = 0;
    const result = await new SlaBreachSweep({
      ports: portsFor(conversationId, arrivedAt),
      notifier: {
        warn: async () => void (told += 1),
        breach: async () => void (told += 1),
        escalate: async () => void (told += 1),
      },
      autoEscalates: () => false,
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    }).run();

    expect(result.acted).toBe(0);
    expect(told).toBe(0);
  });

  withDb('records what it believed at the moment it acted', async () => {
    /**
     * §23.5 requires "late, and by how much" to stay answerable. If a calendar is later
     * corrected and the breach un-happens, this row still says we notified someone and
     * what we thought at the time — because we did, and that is a different fact from
     * whether it is still true.
     */
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;

    await new SlaBreachSweep({
      ports: portsFor(conversationId, arrivedAt),
      notifier: { warn: async () => undefined, breach: async () => undefined, escalate: async () => undefined },
      autoEscalates: () => false,
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    }).run();

    const row = await pool!.query(
      `SELECT level, elapsed_seconds FROM conversation.sla_notifications WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].level).toBe('BREACH');
    expect(row.rows[0].elapsed_seconds).toBeGreaterThan(3000);
  });

  withDb('starts no clock, and says nothing, when no target is configured', async () => {
    // §44.5 D-22: "We will not invent these." No promise was made, so none can be missed.
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;
    const ports = { ...portsFor(conversationId, arrivedAt), targetsFor: async () => [] };

    let told = 0;
    const result = await new SlaBreachSweep({
      ports,
      notifier: {
        warn: async () => void (told += 1),
        breach: async () => void (told += 1),
        escalate: async () => void (told += 1),
      },
      autoEscalates: () => false,
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    }).run();

    expect(result.acted).toBe(0);
    expect(told).toBe(0);
  });

  withDb('says nothing when the team has no calendar and the arrival was after hours', async () => {
    // No hours configured means no opening to start the clock at. §23.1 refuses to
    // invent hours; the consequence is that no clock starts, not that one starts at zero.
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;
    const ports: SlaSweepPorts = {
      ...portsFor(conversationId, arrivedAt),
      factsFor: async () => ({
        conversationId,
        teamId: TEAM_ID,
        arrivedAt,
        afterHours: true,
        waitingOnCustomerSpans: [],
      }),
      calendarsFor: async () => [],
    };

    let told = 0;
    const result = await new SlaBreachSweep({
      ports,
      notifier: {
        warn: async () => void (told += 1),
        breach: async () => void (told += 1),
        escalate: async () => void (told += 1),
      },
      // The real resolver: after hours with no calendar yields no opening, so no start.
      autoEscalates: () => false,
      clockStartFor: (facts, calendars) => (facts.afterHours && calendars.length === 0 ? undefined : facts.arrivedAt),
      logger,
    }).run();

    expect(result.acted).toBe(0);
    expect(told).toBe(0);
  });

  withDb('escalates a breached Claims case automatically, once (D-25)', async () => {
    /**
     * §23.6's third stage, gated on D-25's answer: automatic for Claims and Grievance,
     * a lead's decision elsewhere. Claimed under its own level so a case that stays
     * breached for an afternoon does not climb a level per sweep tick.
     */
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;

    const escalations: string[] = [];
    const sweep = new SlaBreachSweep({
      ports: {
        ...portsFor(conversationId, arrivedAt),
        factsFor: async () => ({
          conversationId,
          teamId: TEAM_ID,
          categoryId: 'claims.new',
          arrivedAt,
          afterHours: false,
          waitingOnCustomerSpans: [],
        }),
      },
      notifier: {
        warn: async () => undefined,
        breach: async () => undefined,
        escalate: async ({ reason }) => void escalations.push(reason),
      },
      autoEscalates: (categoryId) =>
        categoryId !== undefined && ['claims', 'grievance'].includes(categoryId.split('.')[0] ?? ''),
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    });

    await sweep.run();
    await sweep.run();

    expect(escalations).toHaveLength(1);
    // The reason is mandatory: this is the one ownership-category event with no human
    // behind it, and an audit entry with no stated cause is unanswerable later.
    expect(escalations[0]).toContain('breached');
  });

  withDb('does NOT escalate a breached Sales case', async () => {
    // "Automatic everywhere risks escalation becoming noise the leads learn to ignore."
    // Sales still notifies the owner and lead; raising the level stays a human decision.
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;

    let escalated = 0;
    let breached = 0;
    await new SlaBreachSweep({
      ports: {
        ...portsFor(conversationId, arrivedAt),
        factsFor: async () => ({
          conversationId,
          teamId: TEAM_ID,
          categoryId: 'sales.new-policy',
          arrivedAt,
          afterHours: false,
          waitingOnCustomerSpans: [],
        }),
      },
      notifier: {
        warn: async () => undefined,
        breach: async () => void (breached += 1),
        escalate: async () => void (escalated += 1),
      },
      autoEscalates: (categoryId) =>
        categoryId !== undefined && ['claims', 'grievance'].includes(categoryId.split('.')[0] ?? ''),
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    }).run();

    expect(breached).toBe(1);
    expect(escalated).toBe(0);
  });

  withDb('does not escalate a category it does not recognise', async () => {
    // Fail towards a human decision, never towards an automatic one nobody asked for.
    const { conversationId } = await makeCase('ACTIVE');
    const arrivedAt = new Date(Date.now() - 3600_000).toISOString() as Timestamp;

    let escalated = 0;
    await new SlaBreachSweep({
      ports: portsFor(conversationId, arrivedAt), // no categoryId at all
      notifier: {
        warn: async () => undefined,
        breach: async () => undefined,
        escalate: async () => void (escalated += 1),
      },
      autoEscalates: (categoryId) =>
        categoryId !== undefined && ['claims', 'grievance'].includes(categoryId.split('.')[0] ?? ''),
      clockStartFor: (facts) => facts.arrivedAt,
      logger,
    }).run();

    expect(escalated).toBe(0);
  });
});
