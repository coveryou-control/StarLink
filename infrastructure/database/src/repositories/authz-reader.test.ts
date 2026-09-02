/**
 * `PgConversationAuthzReader`, against real PostgreSQL.
 *
 * This reader feeds the realtime gateway's subscribe decision, and it was missing
 * `belongsToActorCustomer` entirely. `decide()` refuses a customer principal without it,
 * so every customer subscribe was denied — including to a conversation they had just
 * created. The failure was closed and therefore invisible: no leak, no error, just a
 * customer surface with no working socket, which would have stayed broken after Redis
 * arrived and been blamed on Redis.
 *
 * The gateway's own tests could not catch it: they stub this reader, so the stub
 * supplied the field the real one omitted. That is the general hazard with a stubbed
 * boundary — the stub encodes what you believe, and the belief is the bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgConversationAuthzReader } from './authz-reader.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `4c4c` block — owned by this file alone. */
const AGENT = '018f2c5a-4c4c-7000-8000-00000000000a';
const CUSTOMER = '018f2c5a-4c4c-7000-8000-00000000000b';
const OUTSIDER = '018f2c5a-4c4c-7000-8000-00000000000c';
const EX_CUSTOMER = '018f2c5a-4c4c-7000-8000-00000000000d';
const TEAM_ID = 'authz-reader-team';

let pool: pg.Pool | undefined;
let reader: PgConversationAuthzReader;
let available = false;
let conversationId: string;
let caseId: string;

const AT = '2026-08-26T12:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
/** Participation that has already ended, for the "no longer live" case. */
const ENDED = '2026-08-10T00:00:00.000Z';

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    reader = new PgConversationAuthzReader(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ authz reader tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Authz Reader Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ($1,'EMPLOYEE','Reader Agent','Service'),
            ($2,'CUSTOMER','Reader Customer',NULL),
            ($3,'CUSTOMER','Reader Outsider',NULL),
            ($4,'CUSTOMER','Reader Ex-Customer',NULL)
     ON CONFLICT (principal_id) DO NOTHING`,
    [AGENT, CUSTOMER, OUTSIDER, EX_CUSTOMER],
  );

  caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await probe.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id, customer_ref)
     VALUES ($1,'ACTIVE',$2,$3,'CCS:customer:reader-1')`,
    [caseId, TEAM_ID, AGENT],
  );
  await probe.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, customer_ref, state, title)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'CCS:customer:reader-1','ACTIVE','Reader thread')`,
    [conversationId, caseId],
  );
  await probe.query(
    `INSERT INTO conversation.participants
       (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
        effective_from, added_at, effective_to)
     VALUES ($1,$2,'EMPLOYEE','OWNER',true,$2,$5,$5,NULL),
            ($1,$3,'CUSTOMER','CUSTOMER',true,$2,$5,$5,NULL),
            ($1,$4,'CUSTOMER','CUSTOMER',true,$2,$5,$5,$6)`,
    [conversationId, AGENT, CUSTOMER, EX_CUSTOMER, PAST, ENDED],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query('DELETE FROM conversation.participants WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM conversation.service_cases WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
      [AGENT, CUSTOMER, OUTSIDER, EX_CUSTOMER],
    ]);
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

describe('customer ownership', () => {
  withDb('reports the conversation as the customer’s own when they participate', async () => {
    // The regression. Without this the gateway refuses a customer their own thread.
    const resource = await reader.loadForAuthorization(conversationId, CUSTOMER, AT);

    expect(resource?.belongsToActorCustomer).toBe(true);
  });

  withDb('does NOT report ownership for a customer who never participated', async () => {
    const resource = await reader.loadForAuthorization(conversationId, OUTSIDER, AT);

    // The conversation exists and is returned — the DECISION is `decide()`'s job — but
    // it must not carry an ownership claim for someone with no participation.
    expect(resource).toBeDefined();
    expect(resource?.belongsToActorCustomer).not.toBe(true);
  });

  withDb('does NOT report ownership once participation has ended', async () => {
    // BR-09 dates participation rather than deleting it, so the row still exists. An
    // ended period must not keep granting access, or removal would be cosmetic.
    const resource = await reader.loadForAuthorization(conversationId, EX_CUSTOMER, AT);

    expect(resource?.participant).toBeDefined();
    expect(resource?.belongsToActorCustomer).toBe(false);
  });

  withDb('reports ownership at an instant when the participation WAS live', async () => {
    // The same person, evaluated before their participation ended. Proves the check is
    // against the supplied clock rather than an implicit "now".
    const resource = await reader.loadForAuthorization(conversationId, EX_CUSTOMER, PAST);

    expect(resource?.belongsToActorCustomer).toBe(true);
  });

  withDb('omits the ownership key entirely for an EMPLOYEE participant', async () => {
    // `decide()` never reads it on the employee path, and an absent value must mean
    // absent — not `false`, which would read as a decision that was made.
    const resource = await reader.loadForAuthorization(conversationId, AGENT, AT);

    expect(resource?.participant?.role).toBe('OWNER');
    expect(Object.hasOwn(resource ?? {}, 'belongsToActorCustomer')).toBe(false);
  });

  withDb('does not infer ownership from customer_ref', async () => {
    // The write path once derived ownership from `customer_ref !== undefined`, which let
    // any customer write into any customer's thread. This conversation HAS a customer
    // reference; the outsider still must not own it.
    const resource = await reader.loadForAuthorization(conversationId, OUTSIDER, AT);

    expect(resource?.customerRef).toBe('CCS:customer:reader-1');
    expect(resource?.belongsToActorCustomer).not.toBe(true);
  });

  withDb('returns undefined for a conversation that does not exist', async () => {
    expect(await reader.loadForAuthorization(crypto.randomUUID(), CUSTOMER, AT)).toBeUndefined();
  });
});
