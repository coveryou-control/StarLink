/**
 * The LOCAL Work Orchestrator against the SAME conformance suite as the mock.
 *
 * That is the point of the exercise. ADR-002's promise — "swap the adapter, don't
 * rewrite the domain" — is only worth something if both implementations are held to one
 * contract, and this is the second family (after IAM) where that is demonstrated rather
 * than asserted. When the Phase-10 Remote adapter arrives it runs this same suite
 * against CCS staging.
 *
 * Backed by real PostgreSQL, because the guarantees under test are the database's: the
 * conformance suite's "exactly one winner when many claim at once" is `G-06` wearing a
 * different hat, and an in-memory stand-in would prove nothing about it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { workOrchestratorConformance } from '@starlink/shared-contracts';
import type { CanonicalRef, QueueMetrics, UUID } from '@starlink/shared-contracts';
import { PgRoutingStore, assertDatabaseAllowed, resetTeamFixtures } from '@starlink/database';

import {
  LocalWorkOrchestrator,
  type LocalWorkOrchestratorOptions,
  type WorkOrchestratorStore,
} from './local-work-orchestrator.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `8c8c` block — owned by this file alone. */
const TEAM_ID = 'local-wo-team';
const AGENT_PREFIX = '018f2c5a-8c8c-7000-8000-';
const agentId = (n: number): string => `${AGENT_PREFIX}${String(n).padStart(12, '0')}`;
const CLAIMANTS = 25;

let pool: pg.Pool | undefined;
let routing: PgRoutingStore;
let available = false;
const conversations: string[] = [];
const cases: string[] = [];
const policies: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 20_000, max: 15 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    routing = new PgRoutingStore(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ LocalWorkOrchestrator conformance SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Local WO Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  const rows = Array.from(
    { length: CLAIMANTS },
    (_, i) => `('${agentId(i)}','EMPLOYEE','WO Claimer ${i}','Service')`,
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ${rows.join(',')} ON CONFLICT (principal_id) DO NOTHING`,
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.reservations WHERE principal_id::text LIKE $1`, [`${AGENT_PREFIX}%`]);
    await pool.query(`DELETE FROM conversation.idempotency_records WHERE scope LIKE 'claim:%'`);
    await pool.query(`DELETE FROM conversation.ownership_episodes WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    // Anything an interrupted run left behind, which this process cannot name by id.
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id::text LIKE $1`, [`${AGENT_PREFIX}%`]);
    await pool.query(`DELETE FROM conversation.capacity_policies WHERE scope_id = ANY($1::text[])`, [policies]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

/** Adapts `PgRoutingStore` to the narrow port the orchestrator needs. */
function storeFor(p: pg.Pool): WorkOrchestratorStore {
  return {
    enqueue: (input) => routing.enqueue(input as never),
    claimQueueEntry: (input) => routing.claimQueueEntry(input as never),
    assignFromRouting: (input) => routing.assignFromRouting(input as never),
    async reserve(input) {
      const expiresAt = new Date(Date.parse(input.at) + input.ttlSeconds * 1000).toISOString();
      await p.query(
        `INSERT INTO conversation.reservations
           (reservation_id, principal_id, ref_system, ref_type, ref_id, weight, effective_from, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          input.reservationId,
          input.principalId,
          input.ref.system,
          input.ref.type,
          input.ref.id,
          input.weight,
          input.at,
          expiresAt,
        ],
      );
      return { reservationId: input.reservationId, expiresAt };
    },
    async release(reservationId, reason, at) {
      await p.query(
        `UPDATE conversation.reservations
            SET released_at = $2, release_reason = $3
          WHERE reservation_id = $1 AND released_at IS NULL`,
        [reservationId, at, reason],
      );
    },
    async queueMetrics(teamId, at): Promise<QueueMetrics> {
      const result = await p.query(
        `SELECT count(*)::int AS depth,
                COALESCE(EXTRACT(EPOCH FROM ($2::timestamptz - min(enqueued_at))), 0)::int AS oldest
           FROM conversation.queue_entries
          WHERE team_id = $1 AND state = 'WAITING'`,
        [teamId, at],
      );
      return {
        teamId,
        depth: result.rows[0].depth,
        oldestWaitingSeconds: result.rows[0].oldest,
        byPriority: {},
        byIntent: {},
        availableCapacityUnits: 0,
      };
    },
  };
}

/**
 * The routing inputs that are BUSINESS decisions, supplied for the test.
 *
 * Every one of them is an unanswered question — which categories are relationship-shaped
 * (D-17), the fallback ladder and any ceiling (D-05), the weight of a unit of work
 * (§12). The adapter takes them as inputs precisely so a test can state them without
 * anything having quietly decided them in production.
 */
interface RoutingKnobs {
  readonly relationshipShaped?: boolean;
  readonly availabilityOf?: LocalWorkOrchestratorOptions['availabilityOf'];
  readonly fallbackPolicy?: LocalWorkOrchestratorOptions['fallbackPolicy'];
  readonly weight?: number;
}

const AVAILABLE = {
  accountActive: true,
  onDeclaredAbsence: false,
  explicitlyUnavailable: false,
};

/** One queued conversation plus an adapter pointed at it. */
async function fixture(knobs: RoutingKnobs = {}): Promise<{
  adapter: LocalWorkOrchestrator;
  queueEntryId: UUID;
  claimantIds: readonly UUID[];
}> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const queueEntryId = crypto.randomUUID() as UUID;
  const at = new Date().toISOString();
  cases.push(caseId);
  conversations.push(conversationId);

  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
    [caseId, TEAM_ID],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED','WO fixture',$3)`,
    [conversationId, caseId, at],
  );
  await routing.enqueue({
    queueEntryId,
    conversationId: conversationId as UUID,
    caseId: caseId as UUID,
    teamId: TEAM_ID,
    priority: 'NORMAL',
    afterHours: false,
    at: at as never,
  });

  return {
    adapter: new LocalWorkOrchestrator({
      store: storeFor(pool!),
      reservationTtlSeconds: 120,
      categoryRouting: async (category) => ({
        ...(category === 'renewals' ? { teamId: TEAM_ID } : {}),
        // Queue-shaped by default: the conformance suite is about claiming, and a
        // default that assigned would take the work before a claimant could race for it.
        relationshipShaped: knobs.relationshipShaped ?? false,
        weight: knobs.weight ?? 1,
      }),
      availabilityOf: knobs.availabilityOf ?? (async () => AVAILABLE),
      fallbackPolicy: knobs.fallbackPolicy ?? { kind: 'TEAM_QUEUE' },
    }),
    queueEntryId,
    claimantIds: Array.from({ length: CLAIMANTS }, (_, i) => agentId(i) as UUID),
  };
}

// The shared suite. Always registered; each test skips loudly when there is no
// database rather than passing quietly — which is why there is no condition here. There
// used to be one, ending in `|| true`, which read as a guard and was not.
{
  workOrchestratorConformance(
    {
      describe,
      it: (name, fn) =>
        it(name, async (ctx) => {
          if (!available) {
            console.warn(`  ⚠ UNPROVEN: ${name}`);
            ctx.skip();
            return;
          }
          await fn();
        }, 120_000),
      expect: expect as never,
    },
    fixture as never,
  );
}

describe('LocalWorkOrchestrator specifics', () => {
  const gate = (name: string, body: () => Promise<void>): void =>
    void it(name, async (ctx) => {
      if (!available) {
        console.warn(`  ⚠ UNPROVEN: ${name}`);
        ctx.skip();
        return;
      }
      await body();
    }, 60_000);

  gate('reports itself as interim authority, never as canonical', async () => {
    // A stand-in that claims to be canonical is how a stand-in becomes permanent.
    const { adapter } = await fixture();
    expect((await adapter.health()).authority).toBe('TEMPORARY_AUTHORITY');
  });

  gate('defers after-hours intake without assigning it or starting a clock', async () => {
    const { adapter } = await fixture();
    const conversationId = crypto.randomUUID() as UUID;
    conversations.push(conversationId);
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE','QUEUED','after hours',now())`,
      [conversationId],
    );

    const decision = await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      channel: 'WEBSITE',
      businessHoursState: 'AFTER_HOURS',
    });

    expect(decision.ok && decision.value.outcome).toBe('DEFERRED_AFTER_HOURS');
  });

  gate('refuses a category with no team mapping rather than guessing one', async () => {
    // D-17 has not mapped it. Routing to "some team" is how work disappears.
    const { adapter } = await fixture();

    const decision = await adapter.requestRouting({
      conversationId: crypto.randomUUID() as UUID,
      intent: { category: 'not-mapped' },
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.error.failureClass).toBe('FAIL_CLOSED');
  });

  gate('reserves capacity with an expiry, and releases it', async () => {
    const { adapter } = await fixture();
    const ref: CanonicalRef = { system: 'LOCAL', type: 'conversation', id: crypto.randomUUID() };

    const reserved = await adapter.reserve(agentId(0) as UUID, ref, 2, 60);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    // A hold that never expires silently consumes capacity forever (ADR-023).
    expect(Date.parse(reserved.value.expiresAt)).toBeGreaterThan(Date.now());

    await adapter.release(reserved.value.reservationId, 'work completed');
    const row = await pool!.query(
      `SELECT released_at, release_reason FROM conversation.reservations WHERE reservation_id = $1`,
      [reserved.value.reservationId],
    );
    // Released, not deleted: "why was this agent at capacity at 14:05" stays answerable.
    expect(row.rows[0].released_at).not.toBeNull();
    expect(row.rows[0].release_reason).toBe('work completed');
  });

  gate('refuses a zero-weight reservation', async () => {
    const { adapter } = await fixture();
    const ref: CanonicalRef = { system: 'LOCAL', type: 'conversation', id: crypto.randomUUID() };

    expect((await adapter.reserve(agentId(0) as UUID, ref, 0, 60)).ok).toBe(false);
  });

  gate('sends transfer and escalation back to the domain command', async () => {
    /**
     * Two paths to the same state change is the defect §38 records in the reference
     * platform. Transfer and escalation carry a mandatory reason and a must-succeed
     * audit in `packages/routing`; an orchestrator shortcut would bypass both.
     */
    const { adapter } = await fixture();
    const conversationId = crypto.randomUUID() as UUID;

    const transferred = await adapter.transfer({
      conversationId,
      fromPrincipal: agentId(0) as UUID,
      toPrincipal: agentId(1) as UUID,
      reason: 'r',
      actor: agentId(0) as UUID,
    });
    expect(transferred.ok).toBe(false);
    expect(!transferred.ok && transferred.error.code).toBe('USE_DOMAIN_COMMAND');
  });

  gate('does not store self-reported agent state', async () => {
    // Agent work state belongs to CCS (Part IV ownership table), and availability for
    // routing comes from the calendar and declared absence — never a self-reported
    // status (§21.9). Accepted and discarded rather than quietly becoming an authority.
    const { adapter } = await fixture();
    expect((await adapter.reportAgentState(agentId(0) as UUID, 'BUSY')).ok).toBe(true);
  });

  /**
   * A bare conversation with a case, ready to be routed.
   *
   * `requestRouting` enqueues its own entry, so these tests need the conversation row to
   * exist for the foreign key and nothing more.
   */
  const routable = async (): Promise<UUID> => {
    const caseId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    cases.push(caseId);
    conversations.push(conversationId);
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
      [caseId, TEAM_ID],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED','routable',now())`,
      [conversationId, caseId],
    );
    return conversationId as UUID;
  };

  const setCeiling = async (principalId: string, units: number): Promise<void> => {
    await pool!.query(
      `INSERT INTO conversation.capacity_policies
         (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
       VALUES ($1,'PRINCIPAL',$2,$3,'{}'::jsonb,true)`,
      [crypto.randomUUID(), principalId, units],
    );
    policies.push(principalId);
  };

  gate('sends a relationship-shaped category to the designated advisor', async () => {
    // §21.8 steps 2–4. The whole reason the tree exists: a renewal goes to the person
    // who sold the policy, not to whoever is free.
    const advisor = agentId(3) as UUID;
    const { adapter } = await fixture({ relationshipShaped: true });
    const conversationId = await routable();

    const decision = await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      relationshipOwner: advisor,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok && decision.value.outcome).toBe('ASSIGNED');
    if (!decision.ok || decision.value.outcome !== 'ASSIGNED') return;
    expect(decision.value.principalId).toBe(advisor);
    // The path travelled, carried on the decision — an answer to "why Priya?" that does
    // not require reading logs.
    expect(decision.value.reason).toContain('DESIGNATED_AVAILABLE');

    // Assignment is an ownership episode stamped ROUTED, not CLAIMED: "the system gave
    // me this" and "I took this" are different facts and the ledger keeps them apart.
    const episode = await pool!.query(
      `SELECT owner_id, assignment_source FROM conversation.ownership_episodes
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    expect(episode.rows[0].owner_id).toBe(advisor);
    expect(episode.rows[0].assignment_source).toBe('ROUTED');
  });

  gate('queues a queue-shaped category even when a designated advisor exists', async () => {
    // Step 2 short-circuits step 3. Fresh Sales is queue-shaped: the customer has no
    // relationship yet, so preferring "their" advisor would be preferring a fiction.
    const { adapter } = await fixture({ relationshipShaped: false });
    const conversationId = await routable();

    const decision = await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      relationshipOwner: agentId(4) as UUID,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok && decision.value.outcome).toBe('QUEUED');
    expect(decision.ok && decision.value.outcome === 'QUEUED' && decision.value.reason).toContain(
      'QUEUE_SHAPED_CATEGORY',
    );
  });

  gate('queues rather than assigning when the designated advisor is on leave', async () => {
    const { adapter } = await fixture({
      relationshipShaped: true,
      availabilityOf: async () => ({ ...AVAILABLE, onDeclaredAbsence: true }),
    });
    const conversationId = await routable();

    const decision = await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      relationshipOwner: agentId(5) as UUID,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok && decision.value.outcome).toBe('QUEUED');
    expect(decision.ok && decision.value.outcome === 'QUEUED' && decision.value.reason).toContain(
      'DESIGNATED_UNAVAILABLE',
    );
  });

  gate('falls back to a named backup when the advisor is unavailable', async () => {
    const backup = agentId(6) as UUID;
    const { adapter } = await fixture({
      relationshipShaped: true,
      availabilityOf: async () => ({ ...AVAILABLE, explicitlyUnavailable: true }),
      fallbackPolicy: {
        kind: 'NAMED_BACKUP',
        backup: { principalId: backup, basis: 'NAMED_BACKUP', availability: { available: true } },
      },
    });
    const conversationId = await routable();

    const decision = await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      relationshipOwner: agentId(7) as UUID,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok && decision.value.outcome).toBe('ASSIGNED');
    expect(decision.ok && decision.value.outcome === 'ASSIGNED' && decision.value.principalId).toBe(
      backup,
    );
  });

  gate('never infers unavailability from a dropped connection', async () => {
    /**
     * §21.9, stated twice by the document: availability is declared or derived from the
     * calendar, NEVER inferred from a socket. "A phone entering a lift is not leave."
     *
     * Enforced structurally — `AvailabilityFacts` has no field for a socket, heartbeat
     * or last-seen — so the assertion here is on the TYPE'S surface: nothing this
     * adapter passes could carry presence even if someone wanted it to.
     */
    const seen: string[] = [];
    const { adapter } = await fixture({
      relationshipShaped: true,
      availabilityOf: async (principalId) => {
        seen.push(principalId);
        return AVAILABLE;
      },
    });
    const conversationId = await routable();

    await adapter.requestRouting({
      conversationId,
      intent: { category: 'renewals' },
      relationshipOwner: agentId(8) as UUID,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(seen).toEqual([agentId(8)]);
    expect(Object.keys(AVAILABLE)).not.toContain('lastSeenAt');
    expect(Object.keys(AVAILABLE)).not.toContain('connected');
  });

  gate('turns a refused assignment into a queued conversation, never an error', async () => {
    /**
     * The adapter's half of the ceiling. The RACE is proved one layer down, in
     * `claim-race.test.ts`, where twenty simultaneous assignments against a ceiling of
     * one admit exactly one — that test was verified to fail with the advisory lock
     * removed. This one is deliberately sequential, because what it checks is different:
     * how the adapter REPORTS a refusal.
     *
     * (An earlier version of this test raced two callers and passed with the lock taken
     * out. Two sequential awaits through a connection pool rarely interleave in the
     * window that matters, so it proved nothing while reading as though it proved the
     * headline guarantee. It is written honestly here instead.)
     *
     * QUEUED rather than an error, because an error would be retried and the
     * conversation is not in trouble — it is waiting, findable and claimable.
     */
    const advisor = agentId(9) as UUID;
    await setCeiling(advisor, 1);

    const { adapter } = await fixture({ relationshipShaped: true });

    const first = await adapter.requestRouting({
      conversationId: await routable(),
      intent: { category: 'renewals' },
      relationshipOwner: advisor,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });
    expect(first.ok && first.value.outcome).toBe('ASSIGNED');

    // The advisor now holds their one unit. `availabilityOf` in this fixture still says
    // "available" — a stale fact, exactly as a real reader's would be — so the refusal
    // has to come from the assigning transaction rather than from the availability
    // check that preceded it.
    const second = await adapter.requestRouting({
      conversationId: await routable(),
      intent: { category: 'renewals' },
      relationshipOwner: advisor,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(second.ok && second.value.outcome).toBe('QUEUED');
    expect(second.ok && second.value.outcome === 'QUEUED' && second.value.reason).toContain(
      'AT_CAPACITY',
    );

    const held = await pool!.query(
      `SELECT COALESCE(sum(weight),0)::int AS held FROM conversation.reservations
        WHERE principal_id = $1 AND released_at IS NULL AND expires_at > now()`,
      [advisor],
    );
    expect(held.rows[0].held).toBe(1);
  });

  gate('weights work rather than counting conversations', async () => {
    // Brief §12: never a hard-coded "5 chats". A claim costs more than a renewal
    // question, so a ceiling of two admits two renewals or one claim.
    const advisor = agentId(10) as UUID;
    await setCeiling(advisor, 2);

    const { adapter } = await fixture({
      relationshipShaped: true,
      weight: 3,
    });

    const decision = await adapter.requestRouting({
      conversationId: await routable(),
      intent: { category: 'renewals' },
      relationshipOwner: advisor,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    // Available by every other measure, and still refused: one unit of this work does
    // not fit under the ceiling.
    expect(decision.ok && decision.value.outcome).toBe('QUEUED');
    expect(decision.ok && decision.value.outcome === 'QUEUED' && decision.value.reason).toContain(
      'AT_CAPACITY',
    );
  });

  gate('treats an absent ceiling as no ceiling, not as a ceiling of zero', async () => {
    // A missing policy row is D-05 being unanswered. Reading it as zero would make
    // every employee permanently unavailable — an invented staffing policy of the worst
    // possible kind, arrived at by accident.
    const advisor = agentId(11) as UUID;
    const { adapter } = await fixture({ relationshipShaped: true });

    const decision = await adapter.requestRouting({
      conversationId: await routable(),
      intent: { category: 'renewals' },
      relationshipOwner: advisor,
      channel: 'WEBSITE',
      businessHoursState: 'OPEN',
    });

    expect(decision.ok && decision.value.outcome).toBe('ASSIGNED');
  });

  gate('reports queue depth and the age of the oldest waiting item', async () => {
    const { adapter } = await fixture();
    const snapshot = await adapter.queueSnapshot(TEAM_ID);

    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.teamId).toBe(TEAM_ID);
      expect(snapshot.value.depth).toBeGreaterThanOrEqual(0);
    }
  });
});
