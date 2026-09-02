/**
 * GOLDEN TEST G-14 — "Object storage down | text conversation unaffected; attachment path
 * explicitly degraded".
 *
 * §34.4 is unusually specific about what "explicitly degraded" means, and each clause is
 * asserted below:
 *
 *   * **Effect** — "Attachments cannot be uploaded or downloaded. **Conversations continue
 *     to work**"
 *   * **Upload** — "Fails explicitly, **before the message is sent**. The user keeps their
 *     message and can retry — **a message is never sent claiming an attachment that does
 *     not exist**"
 *   * **Download** — "Explicit error naming the attachment as **temporarily unavailable**,
 *     not a broken image or a silent blank"
 *   * **Metadata** — "Metadata lives in the database, so the conversation still shows
 *     *that* a file exists — its absence is legible rather than mysterious"
 *
 * ## How the outage is injected, and why not through configuration
 *
 * `AttachmentService` takes its `ObjectStorageProvider` by injection, so a provider that
 * fails is a constructor argument. No `failing` adapter mode was added: a production
 * configuration whose only purpose is to break the product is surface nobody should be
 * able to select by accident, and §65 already assigns real outage simulation to the chaos
 * lab ("compose kill/pause/latency (toxiproxy)"), which needs container infrastructure
 * this machine does not have (N-03).
 *
 * So this proves the DEGRADATION CONTRACT — what the service and the wire do when storage
 * refuses — against a real database and real attachment records. What it does not prove is
 * the behaviour of a genuinely unreachable S3, which is the chaos lab's job and is
 * recorded as such.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  assertDatabaseAllowed,
  PgAttachmentStore,
  PgMessageStore,
  resetTeamFixtures,
} from '@starlink/database';
import { createLogger } from '@starlink/observability';
import { sendMessage } from '@starlink/messaging';
import { err, type ObjectStorageProvider, type Timestamp, type UUID } from '@starlink/shared-contracts';
import { AttachmentService } from './attachments/attachment-service.js';
import { AuditWriter } from './audit/audit-writer.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** The `0b14` block belongs to this file alone. */
const AGENT = '018f2c5a-0b14-7000-8000-00000000000a';
const TEAM_ID = 'g14-storage-team';

const logger = createLogger({ service: 'g14-storage-down', level: 'error' });

let pool: pg.Pool | undefined;
let available = false;
let conversationId: UUID;
let caseId: UUID;

/**
 * Storage that is down.
 *
 * `FAIL_DEGRADED` is the classification the contract requires — "the feature disappears,
 * the conversation continues" — and it is what makes the rest of this file's claims
 * obligatory rather than optional. A provider returning FAIL_CLOSED here would be telling
 * callers to deny, which would take the conversation down with the file.
 */
const downStorage: ObjectStorageProvider = {
  async issueUploadGrant() {
    return err({
      code: 'STORAGE_UNREACHABLE',
      message: 'object storage did not respond',
      retryable: true,
      failureClass: 'FAIL_DEGRADED',
      correlationId: 'g14',
    });
  },
  async promote() {
    return err({
      code: 'STORAGE_UNREACHABLE',
      message: 'object storage did not respond',
      retryable: true,
      failureClass: 'FAIL_DEGRADED',
      correlationId: 'g14',
    });
  },
  async issueDownloadGrant() {
    return err({
      code: 'STORAGE_UNREACHABLE',
      message: 'object storage did not respond',
      retryable: true,
      failureClass: 'FAIL_DEGRADED',
      correlationId: 'g14',
    });
  },
  async delete() {
    return err({
      code: 'STORAGE_UNREACHABLE',
      message: 'object storage did not respond',
      retryable: true,
      failureClass: 'FAIL_DEGRADED',
      correlationId: 'g14',
    });
  },
  async health() {
    return { status: 'DOWN', authority: 'MOCK', checkedAt: new Date().toISOString() as Timestamp };
  },
};

const config = {
  SL_ATTACHMENT_UNBOUND_TTL_SECONDS: 900,
  SL_ATTACHMENT_DOWNLOAD_TTL_SECONDS: 120,
} as never;

const scanner = {
  async scan() {
    return { verdict: 'CLEAN' as const, scannedAt: new Date().toISOString() as Timestamp };
  },
  async health() {
    return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: new Date().toISOString() as Timestamp };
  },
} as never;

let service: AttachmentService;
let messages: PgMessageStore;
let store: PgAttachmentStore;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 4 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
    available = true;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ G-14 SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'G14 Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','G14 Agent','Service','ACTIVE')
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
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','G14 thread',$3,0)`,
    [conversationId, caseId, at],
  );
  await probe.query(
    `INSERT INTO conversation.ownership_episodes
       (episode_id, conversation_id, case_id, owner_id, effective_from, assignment_source)
     VALUES ($1,$2,$3,$4,$5,'ROUTED')`,
    [crypto.randomUUID(), conversationId, caseId, AGENT, at],
  );

  store = new PgAttachmentStore(probe);
  messages = new PgMessageStore(probe);
  service = new AttachmentService(
    store,
    downStorage,
    scanner,
    new AuditWriter(probe, logger),
    logger,
    config,
  );
}, 60_000);

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.attachments WHERE conversation_id = $1`, [conversationId]);
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
      console.warn(`  ⚠ UNPROVEN (G-14): ${name}`);
      ctx.skip();
      return;
    }
    await body();
  }, 60_000);
};

describe('G-14 — object storage down (§34.4)', () => {
  withDb('refuses the upload explicitly, and records no attachment at all', async () => {
    const outcome = await service.grantUpload({
      conversationId,
      uploaderId: AGENT,
      uploaderKind: 'EMPLOYEE',
      declaredMime: 'application/pdf',
      declaredBytes: 12_000,
      filename: 'renewal.pdf',
      correlationId: 'g14-upload',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Distinguishable from a policy refusal, which is what lets the surface say "try
    // again" rather than "you may not attach that".
    expect(outcome.refusal).toBe('STORAGE_UNAVAILABLE');

    /**
     * §34.4's load-bearing clause: "a message is never sent claiming an attachment that
     * does not exist". The grant failed BEFORE any row was written, so there is no
     * attachment id for a client to attach — the impossibility is structural rather than
     * a rule the send path has to remember.
     */
    const rows = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.attachments WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  withDb('leaves the text conversation entirely unaffected', async () => {
    /**
     * The whole point of the golden test. §34.4: "Conversations continue to work", and
     * brief §43 invariant 9 classifies storage as FAIL_DEGRADED for exactly this reason.
     * A real send through the real store, while storage is down.
     */
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
        senderDisplayName: 'G14 Agent',
        body: 'I could not attach the document — I will send it separately.',
        visibility: 'CUSTOMER_VISIBLE',
        correlationId: 'g14-send',
      },
      { store: messages, now: () => new Date(), newId: () => crypto.randomUUID() as UUID },
    );

    expect(sent.ok, 'a storage outage took the conversation down with it').toBe(true);

    const stored = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.messages WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(stored.rows[0].n).toBe(1);
  });

  withDb('refuses a download as temporarily unavailable, and keeps the metadata legible', async () => {
    /**
     * An attachment that was granted and bound BEFORE the outage. §34.4: "Metadata lives
     * in the database, so the conversation still shows *that* a file exists — its absence
     * is legible rather than mysterious."
     */
    const attachmentId = crypto.randomUUID() as UUID;
    const at = new Date().toISOString() as Timestamp;
    await pool!.query(
      `INSERT INTO conversation.attachments
         (attachment_id, conversation_id, uploader_id, uploader_kind, declared_mime,
          declared_bytes, original_filename, quarantine_key, clean_key, state, created_at)
       VALUES ($1,$2,$3,'EMPLOYEE','application/pdf',12000,'policy.pdf',
               'quarantine/g14','clean/g14','BOUND',$4)`,
      [attachmentId, conversationId, AGENT, at],
    );

    const outcome = await service.grantDownload({
      attachmentId,
      actor: { principalId: AGENT as UUID, kind: 'EMPLOYEE' },
      ports: {
        async mayReadConversation() {
          return true;
        },
        async messageVisibility() {
          return undefined;
        },
      },
      correlationId: 'g14-download',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    /**
     * Not "no such attachment". The refusal is distinguishable so the surface can say
     * "temporarily unavailable" — §34.4 forbids "a broken image or a silent blank", and a
     * 404 would produce exactly that by telling the user their file is gone.
     */
    expect(outcome.refusal).toBe('STORAGE_UNAVAILABLE');

    // The metadata survives the outage, which is what makes the absence legible.
    const record = await store.byId(attachmentId);
    expect(record?.originalFilename).toBe('policy.pdf');
    expect(record?.state).toBe('BOUND');
  });

  withDb('reports storage as DOWN rather than pretending otherwise', async () => {
    const health = await downStorage.health();
    expect(health.status).toBe('DOWN');
  });
});
