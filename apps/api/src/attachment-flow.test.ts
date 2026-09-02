/**
 * PHASE 7: attachments end to end, against a live API.
 *
 * The pipeline's mechanics are covered by unit tests; what this adds is the parts that
 * only exist once HTTP, authorization and the sweeps are all in play:
 *
 *   * **D-07 over the wire.** A customer may attach in Claims and nowhere else, and the
 *     refusal is the same uniform 404 as everything else they may not do (§27.3).
 *   * **The full round trip.** Grant → direct upload → scan sweep → promote → bind →
 *     download grant, with nothing servable until the last step.
 *   * **§28.4 step 4 through a real session.** A customer, in their own conversation,
 *     refused an internal-note attachment — the case the ladder exists for.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { customerRoutes } from '@starlink/shared-contracts/http/customer';
import { employeeRoutes } from '@starlink/shared-contracts/http/employee';
import { SessionService, hashPassword } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const SESSION_SECRET = 'attachment-flow-session-secret-01234';
const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

/** `a77c` block — owned by this file alone. */
const TEAM_ID = 'attach-flow-team';
const CLAIMS_CATEGORY = 'attach-flow-claims';
const SALES_CATEGORY = 'attach-flow-sales';
const AGENT = '018f2c5a-a77c-7000-8000-00000000000a';
const AGENT_USER = 'attach.agent';
const AGENT_PASSWORD = 'attach-agent-password-1';

const sessions = new SessionService({
  secret: SESSION_SECRET,
  identity: {
    async resolvePrincipal() { throw new Error('not used'); },
    async verifyCredential() { throw new Error('not used'); },
    async getSessionVersion() { throw new Error('not used'); },
    async revokeSessions() { throw new Error('not used'); },
    async health() {
      return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: new Date().toISOString() };
    },
  },
});

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const customerPrincipals: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ attachment flow SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Attach Flow Team','Claims') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  // Two categories: one under the `claims` root D-07 permits, one under `sales` it does not.
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Attach Claims',$3,true,true), ($2,'Attach Sales',$3,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [`claims.${CLAIMS_CATEGORY}`, `sales.${SALES_CATEGORY}`, TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$2,'Attach Agent','Claims',$3,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE SET credential_hash = EXCLUDED.credential_hash, status = 'ACTIVE'`,
    [AGENT, AGENT_USER, await hashPassword(AGENT_PASSWORD)],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'attachment-flow-cursor-secret-01234567',
      SL_DB_MAX_CONNECTIONS: '5',
      /**
       * `local` — the DEFAULT and the driver a running system uses.
       *
       * This said `mock`, which is the other half of the defect this file now covers: the
       * whole attachment pipeline was proven end to end against a driver whose upload URL
       * is `memory://…`, a scheme no browser implements. The test passed, the pipeline was
       * correct, and no person could upload a file. Pinning a test to a driver nobody runs
       * proves the pipeline and says nothing about the product.
       */
      SL_ADAPTER_OBJECT_STORAGE: 'local',
      SL_SWEEP_ATTACHMENT_SCAN_SECONDS: '1',
      // Quiet everything this file is not about.
      SL_SWEEP_ROUTING_SECONDS: '3600',
      SL_SWEEP_SLA_SECONDS: '3600',
      SL_SWEEP_REOPEN_SECONDS: '3600',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
      SL_SWEEP_RESERVATION_SECONDS: '3600',
      SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS: '3600',
      SL_QUEUE_METRICS_SECONDS: '3600',
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) console.warn('\n  ⚠ attachment flow SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    const owned = await pool.query<{ conversation_id: string }>(
      `SELECT c.conversation_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.category_id = ANY($1::text[])`,
      [[`claims.${CLAIMS_CATEGORY}`, `sales.${SALES_CATEGORY}`]],
    );
    const ids = owned.rows.map((r) => r.conversation_id);
    await pool.query(
      `DELETE FROM conversation.attachment_scan_results WHERE attachment_id IN
         (SELECT attachment_id FROM conversation.attachments WHERE conversation_id = ANY($1::uuid[]))`,
      [ids],
    );
    for (const table of ['attachments', 'case_state_episodes', 'sla_notifications', 'business_links', 'queue_entries', 'messages', 'participants', 'read_state']) {
      await pool.query(`DELETE FROM conversation.${table} WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_type = 'conversation' AND aggregate_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE category_id = ANY($1::text[])`, [[`claims.${CLAIMS_CATEGORY}`, `sales.${SALES_CATEGORY}`]]);
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = ANY($1::text[])`, [[`claims.${CLAIMS_CATEGORY}`, `sales.${SALES_CATEGORY}`]]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [AGENT]);
    await pool.query(`DELETE FROM identity.principals WHERE kind = 'CUSTOMER' AND principal_id = ANY($1::uuid[])`, [customerPrincipals]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

let arrivals = 0;

/** A verified customer with a conversation in the given category. */
async function customerWith(categoryId: string): Promise<{ conversationId: string; cookie: string }> {
  arrivals += 1;
  const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: `+9196666${String(arrivals).padStart(5, '0')}` }),
  });
  const { principalId } = (await started.json()) as { principalId: string };
  customerPrincipals.push(principalId);
  const { token } = sessions.issue({
    principalId: principalId as never,
    kind: 'CUSTOMER',
    surface: 'CUSTOMER',
    sessionVersion: 1,
    assurance: 'PSEUDONYMOUS',
  });
  const cookie = `sl_cus_session=${token}`;

  const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ categoryId, message: 'about my claim' }),
  });
  const body = (await created.json()) as { conversationId: string };
  if (created.status >= 400) throw new Error(`intake failed: ${JSON.stringify(body)}`);
  return { conversationId: body.conversationId, cookie };
}

const requestUpload = (
  base: string,
  conversationId: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  fetch(`${BASE}${base}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('attachments end to end', () => {
  const gate = (name: string, body: () => Promise<void>, timeout = 90_000): void =>
    void it(
      name,
      async (ctx) => {
        if (!ready) {
          console.warn(`  ⚠ UNPROVEN: ${name}`);
          ctx.skip();
          return;
        }
        await body();
      },
      timeout,
    );

  gate('D-07 — a customer may request an upload in a Claims conversation', async () => {
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);

    const response = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'claim-form.pdf', declaredMime: 'application/pdf', declaredBytes: 2048 },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { attachmentId: string; uploadUrl: string };
    expect(body.attachmentId).toBeDefined();
    /**
     * The grant is for an upload, and nothing servable exists yet (§28.1).
     *
     * This used to assert the URL contained `quarantine/`, which pinned the in-memory
     * driver's `memory://upload/quarantine/<uuid>` — and pinned the wrong property. §28.3
     * requires the key to be opaque and never echoed into a path, so a URL that names it
     * is the defect, not the guarantee. What is asserted instead: the upload endpoint is
     * not the download endpoint, and the record is in a pre-upload state.
     */
    expect(body.uploadUrl).not.toContain('download');
    const state = await pool!.query(
      `SELECT state FROM conversation.attachments WHERE attachment_id = $1`,
      [body.attachmentId],
    );
    expect(state.rows[0].state).toBe('UPLOAD_GRANTED');
  });

  gate('D-07 — the same customer may NOT upload outside Claims', async () => {
    /**
     * The whole of D-07's "claims only", over the wire. Refused with the uniform 404
     * every other customer refusal uses (§27.3) — the reason lives in the audit ledger,
     * not in the response.
     */
    const { conversationId, cookie } = await customerWith(`sales.${SALES_CATEGORY}`);

    const response = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'quote.pdf', declaredMime: 'application/pdf', declaredBytes: 2048 },
    );

    expect(response.status).toBe(404);

    // And nothing was written: §28.1's "reject → no bytes stored" extends to metadata.
    const rows = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.attachments WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  gate('refuses a type outside the customer allow-list, in Claims', async () => {
    // §28.2: an allow-list, never a deny-list. A ZIP is refused even in Claims.
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);

    const response = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'documents.zip', declaredMime: 'application/zip', declaredBytes: 2048 },
    );

    expect(response.status).toBe(404);
  });

  gate('refuses an oversized upload before any bytes exist', async () => {
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);

    const response = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'huge.pdf', declaredMime: 'application/pdf', declaredBytes: 500 * 1024 * 1024 },
    );

    expect(response.status).toBe(404);
  });

  gate('records a refused upload in the audit ledger', async () => {
    /**
     * The refusal is invisible on the wire by design, so it has to be visible somewhere.
     * D-07's boundary in particular is worth being able to count — "how often do
     * customers try to attach outside Claims" is a product question.
     */
    const { conversationId, cookie } = await customerWith(`sales.${SALES_CATEGORY}`);
    await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'x.pdf', declaredMime: 'application/pdf', declaredBytes: 1024 },
    );

    const audited = await pool!.query(
      `SELECT reason FROM audit.ledger
        WHERE action = 'attachment.upload.refused' AND target_id = $1`,
      [conversationId],
    );
    expect(audited.rowCount).toBeGreaterThan(0);
    expect(audited.rows[0].reason).toBe('UPLOADS_NOT_PERMITTED_FOR_CATEGORY');
  });

  gate('nothing is downloadable before it is bound (§28.1)', async () => {
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
    const granted = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'claim.pdf', declaredMime: 'application/pdf', declaredBytes: 1024 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };

    // Granted, not uploaded, not scanned, not bound — and therefore reachable by nobody,
    // including the person who asked for the grant.
    const download = await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie },
    });
    expect(download.status).toBe(404);
  });

  gate('an employee may request an upload without a category restriction', async () => {
    // §28.5: employees have the broader allow-list and no D-07 restriction. The same
    // sales conversation that refused the customer accepts the agent.
    const { conversationId } = await customerWith(`sales.${SALES_CATEGORY}`);

    const signIn = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASSWORD }),
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    // The agent must be a participant to read the conversation at all — the object check
    // is the same one every other employee read path runs.
    /**
     * Stamped from the APPLICATION clock, not SQL `now()` — ADR-025.
     *
     * This machine's clock runs about a minute behind Neon, so a participation stamped
     * `now() - interval '1 minute'` in database time is still in the FUTURE to a
     * `decide()` reading the application clock, and the agent gets a 404 on a
     * conversation they were just added to. That is the exact failure CLAUDE.md records,
     * and it caught this test on its first run.
     */
    const addedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool!.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, effective_from)
       VALUES ($1,$2,'EMPLOYEE','OWNER',$3)
       ON CONFLICT (conversation_id, principal_id) DO NOTHING`,
      [conversationId, AGENT, addedAt],
    );

    const response = await requestUpload(
      employeeRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'notes.txt', declaredMime: 'text/plain', declaredBytes: 512 },
    );

    expect(response.status).toBe(201);
  });

  gate('a stranger cannot request an upload against someone else’s conversation', async () => {
    // §28.4 step 3 at the grant end: the right to attach is the right to write here, and
    // the object check runs before anything is granted.
    const owner = await customerWith(`claims.${CLAIMS_CATEGORY}`);
    const stranger = await customerWith(`claims.${CLAIMS_CATEGORY}`);

    const response = await requestUpload(
      customerRoutes.conversations.attachments(owner.conversationId),
      owner.conversationId,
      stranger.cookie,
      { filename: 'nosy.pdf', declaredMime: 'application/pdf', declaredBytes: 1024 },
    );

    expect(response.status).toBe(404);
  });

  /** Uploads bytes through the dev endpoint, then announces the upload. */
  const uploadBytes = async (
    attachmentId: string,
    bytes: Uint8Array,
    surface: 'customer' | 'employee',
    cookie: string,
  ): Promise<void> => {
    const put = await fetch(`${BASE}/v1/dev/attachments/${attachmentId}/bytes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: Buffer.from(bytes).toString('base64') }),
    });
    expect(put.status, 'the dev endpoint should accept bytes for a granted key').toBe(201);

    const announced = await fetch(
      `${BASE}${
        surface === 'customer'
          ? customerRoutes.attachments.uploaded(attachmentId)
          : employeeRoutes.attachments.uploaded(attachmentId)
      }`,
      { method: 'POST', headers: { cookie } },
    );
    expect(announced.status).toBe(201);
  };

  /** Polls until the scan sweep settles the attachment. */
  const waitForState = async (attachmentId: string, want: string, ms = 25_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const row = await pool!.query(
        `SELECT state FROM conversation.attachments WHERE attachment_id = $1`,
        [attachmentId],
      );
      const state = row.rows[0]?.state as string;
      if (state === want || Date.now() > deadline) return state;
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  /** A signed-in agent's cookie header. */
  const signInAgent = async (): Promise<string> => {
    const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASSWORD }),
    });
    expect(response.status, 'the agent should be able to sign in').toBe(200);
    return (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  };

  /**
   * Makes the agent the owner of a customer's conversation.
   *
   * `effective_from` is app-clocked and backdated, per ADR-025: `decide()` evaluates the
   * period against the application clock, and a row stamped by the database's `now()` on a
   * machine running behind it is "not yet effective" to the very next request.
   */
  const addAgentToConversation = async (conversationId: string): Promise<void> => {
    await pool!.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, effective_from)
       VALUES ($1,$2,'EMPLOYEE','OWNER',$3)
       ON CONFLICT (conversation_id, principal_id) DO NOTHING`,
      [conversationId, AGENT, new Date(Date.now() - 10 * 60_000).toISOString()],
    );
  };

  const pdfBytes = (tail: string): Uint8Array =>
    Uint8Array.from([0x25, 0x50, 0x44, 0x46, ...tail.split('').map((c) => c.charCodeAt(0))]);

  gate('the whole round trip: grant, upload, scan, bind, download', async () => {
    /**
     * Every state before the last one is a state in which the file is NOT reachable.
     * §28.1: "binding to a message is what grants access."
     */
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);

    const granted = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'claim.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };

    await uploadBytes(attachmentId, pdfBytes('-1.7 claim'), 'customer', cookie);
    expect(await waitForState(attachmentId, 'CLEAN')).toBe('CLEAN');

    // Scanned and promoted is still not reachable. Only binding is.
    const early = await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie },
    });
    expect(early.status).toBe(404);

    const sent = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'here is my claim form', attachmentIds: [attachmentId] }),
    });
    expect(sent.status).toBe(201);
    const sentBody = (await sent.json()) as { attachedIds: string[]; notAttachedIds: string[] };
    expect(sentBody.attachedIds).toEqual([attachmentId]);
    expect(sentBody.notAttachedIds).toEqual([]);

    const download = await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    const grant = (await download.json()) as { url: string; filename: string };
    expect(grant.filename).toBe('claim.pdf');
    /**
     * The URL names no storage key at all.
     *
     * It used to be asserted to contain `clean/` — true of the in-memory driver's
     * `memory://download/clean/<uuid>`, and the wrong property to pin: a URL that carries
     * the storage key is a permanent, guessable link to a customer's document, and §28.3
     * is explicit that keys are opaque and never echoed into a path. What matters is that
     * the link is a short-lived grant, and that nothing about quarantine leaks into it.
     */
    expect(grant.url).not.toContain('quarantine');
    expect(grant.url).not.toContain('clean/');
    expect(grant.url, 'a download must go through a grant, not a key').toContain(
      '/v1/dev/objects/download/',
    );
  });

  gate('an infected upload never binds, and the message still sends', async () => {
    /**
     * Both halves matter. The malware must not attach, and the MESSAGE must still go
     * through: §34 and brief §43 invariant 9 say an attachment problem never takes the
     * conversation with it.
     */
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
    const granted = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'invoice.pdf', declaredMime: 'application/pdf', declaredBytes: 68 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };

    const eicar = Uint8Array.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'.split('').map((c) => c.charCodeAt(0)),
    );
    await uploadBytes(attachmentId, eicar, 'customer', cookie);
    expect(await waitForState(attachmentId, 'INFECTED')).toBe('INFECTED');

    const sent = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'attaching my invoice', attachmentIds: [attachmentId] }),
    });

    // The message lands.
    expect(sent.status).toBe(201);
    const body = (await sent.json()) as {
      messageId: string;
      attachedIds: string[];
      notAttachedIds: string[];
    };
    expect(body.messageId).toBeDefined();
    // The malware does not.
    expect(body.attachedIds).toEqual([]);
    expect(body.notAttachedIds).toEqual([attachmentId]);
  });

  /**
   * The path a BROWSER takes, which is the one that was broken.
   *
   * Everything above uploads through `/v1/dev/attachments/:id/bytes` — a base64 JSON
   * envelope addressed by attachment id, referenced by this file and by no frontend. It
   * proves the pipeline. It cannot prove that a person can attach a document, and a person
   * could not: the URL in the grant was `memory://upload/…`, so `api.uploadBytes` — which
   * does exactly what ADR-012 says and fetches the grant URL directly — failed on a scheme
   * no browser implements.
   *
   * These use ONLY what the client uses: the URL the grant returned, resolved against the
   * API origin, with a raw body and no session cookie.
   */
  describe('the upload path a browser actually uses (ADR-012)', () => {
    /** What `api.uploadBytes` does, including the relative-URL resolution. */
    const putToGrantUrl = (uploadUrl: string, bytes: Uint8Array, mime: string): Promise<Response> =>
      fetch(new URL(uploadUrl, BASE).toString(), {
        method: 'POST',
        headers: { 'content-type': mime },
        // Deliberately no cookie: the grant is the authorization (§28.1), and sending
        // credentials to a storage origin would hand them to a host with no business
        // holding them.
        body: bytes,
      });

    gate('the grant carries a URL a browser can fetch', async () => {
      const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
      const granted = await requestUpload(
        customerRoutes.conversations.attachments(conversationId),
        conversationId,
        cookie,
        { filename: 'form.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { uploadUrl } = (await granted.json()) as { uploadUrl: string };

      expect(
        uploadUrl.startsWith('memory:'),
        'the grant URL is a scheme no browser implements — nobody can upload anything',
      ).toBe(false);
      // Relative is fine and deliberate; what matters is that it resolves to something
      // fetchable. `new URL` accepts either, which is what lets a real S3 driver drop in.
      expect(() => new URL(uploadUrl, BASE)).not.toThrow();
      expect(new URL(uploadUrl, BASE).protocol).toMatch(/^https?:$/);
    });

    gate('bytes POSTed to the grant URL reach the pipeline, and the file downloads', async () => {
      /**
       * The whole journey with no dev-only shortcut in it: grant → POST to the grant's own
       * URL → announce → scan → bind → download grant → GET the file and compare bytes.
       */
      const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
      const content = pdfBytes('-1.7 browser upload');

      const granted = await requestUpload(
        customerRoutes.conversations.attachments(conversationId),
        conversationId,
        cookie,
        { filename: 'browser.pdf', declaredMime: 'application/pdf', declaredBytes: content.byteLength },
      );
      const { attachmentId, uploadUrl } = (await granted.json()) as {
        attachmentId: string;
        uploadUrl: string;
      };

      const put = await putToGrantUrl(uploadUrl, content, 'application/pdf');
      expect(put.status, 'the grant URL must accept the bytes').toBe(201);

      const announced = await fetch(`${BASE}${customerRoutes.attachments.uploaded(attachmentId)}`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(announced.status).toBe(201);
      expect(await waitForState(attachmentId, 'CLEAN')).toBe('CLEAN');

      const sent = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ message: 'uploaded from a browser', attachmentIds: [attachmentId] }),
      });
      expect(((await sent.json()) as { attachedIds: string[] }).attachedIds).toEqual([attachmentId]);

      const grant = (await (
        await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
          headers: { cookie },
        })
      ).json()) as { url: string };

      const fetched = await fetch(new URL(grant.url, BASE).toString());
      expect(fetched.status, 'the download URL must serve the object').toBe(200);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(content);
    });

    gate('the served object is never renderable in the browser', async () => {
      /**
       * A customer-supplied file served inline from the API's own origin is stored XSS in
       * the one place a session cookie lives. §27.11's posture, applied to the one route
       * that returns something other than JSON.
       */
      const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
      const granted = await requestUpload(
        customerRoutes.conversations.attachments(conversationId),
        conversationId,
        cookie,
        { filename: 'x.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { attachmentId, uploadUrl } = (await granted.json()) as {
        attachmentId: string;
        uploadUrl: string;
      };
      // Exactly `declaredBytes`: the scanner REJECTS a size that disagrees with the grant,
      // which is correct and is what the first version of this case tripped over.
      await putToGrantUrl(uploadUrl, pdfBytes('-1.7 claim'), 'application/pdf');
      await fetch(`${BASE}${customerRoutes.attachments.uploaded(attachmentId)}`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(await waitForState(attachmentId, 'CLEAN')).toBe('CLEAN');
      await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ message: 'see attached', attachmentIds: [attachmentId] }),
      });

      const grant = (await (
        await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
          headers: { cookie },
        })
      ).json()) as { url: string };
      const fetched = await fetch(new URL(grant.url, BASE).toString());

      expect(fetched.headers.get('content-type')).toBe('application/octet-stream');
      expect(fetched.headers.get('content-disposition')).toContain('attachment');
      expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
    });

    gate('an object id nobody granted is refused', async () => {
      // The stand-in for a pre-signed URL's authority: bytes are accepted only against a
      // key this adapter itself issued, so the endpoint cannot write to arbitrary storage.
      const response = await putToGrantUrl(
        `/v1/dev/objects/${crypto.randomUUID()}`,
        pdfBytes('-1.7 nope'),
        'application/pdf',
      );
      expect(response.status).toBe(404);
    });

    gate('a download token nobody was issued is refused', async () => {
      const response = await fetch(`${BASE}/v1/dev/objects/download/${crypto.randomUUID()}`);
      expect(response.status).toBe(404);
    });
  });

  /**
   * "Is my file ready to send yet?" (§28.1).
   *
   * The composer had no way to ask, so it called a file "ready to send" the moment the
   * bytes landed. §28.1 binds only a CLEAN attachment, so sending at that point produced a
   * message with no document, the id came back in `notAttachedIds`, and no surface read
   * that field. This is the signal that closes the gap.
   */
  describe('the uploader can see their own scan state', () => {
    const statusFor = (attachmentId: string, cookie: string): Promise<Response> =>
      fetch(`${BASE}${employeeRoutes.attachments.status(attachmentId)}`, { headers: { cookie } });

    gate('reports the state through the pipeline, ending CLEAN', async () => {
      const { conversationId, cookie: customerCookie } = await customerWith(
        `claims.${CLAIMS_CATEGORY}`,
      );
      const agentCookie = await signInAgent();
      await addAgentToConversation(conversationId);

      const granted = await requestUpload(
        employeeRoutes.conversations.attachments(conversationId),
        conversationId,
        agentCookie,
        { filename: 'status.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { attachmentId } = (await granted.json()) as { attachmentId: string };

      // Before any bytes: granted, and emphatically not sendable.
      const beforeUpload = await statusFor(attachmentId, agentCookie);
      expect(beforeUpload.status).toBe(200);
      expect((await beforeUpload.json()) as { state: string }).toMatchObject({
        state: 'UPLOAD_GRANTED',
      });

      await uploadBytes(attachmentId, pdfBytes('-1.7 claim'), 'employee', agentCookie);
      expect(await waitForState(attachmentId, 'CLEAN')).toBe('CLEAN');

      const afterScan = await statusFor(attachmentId, agentCookie);
      expect((await afterScan.json()) as { state: string }).toMatchObject({ state: 'CLEAN' });

      /**
       * A customer session gets 401, not the uniform 404 — and that is correct.
       *
       * `@RequireSurface('EMPLOYEE')` runs at the edge, before any handler: the caller has
       * no employee session at all, which is the same answer they would get with no cookie
       * whatsoever. §27.3's indistinguishability is about AUTHORIZATION — "you may not" vs
       * "it does not exist" — and it is preserved below, where an employee who is not the
       * uploader gets the same 404 as a nonexistent attachment.
       */
      expect((await statusFor(attachmentId, customerCookie)).status).toBe(401);
    });

    gate('refuses somebody else\'s upload', async () => {
      /**
       * Uploader-only, the same rule `markUploaded` applies. An unbound attachment has no
       * participants to authorise against — it is reachable by nobody until it is bound —
       * so the uploader is the only person with a relationship to it.
       */
      const { conversationId, cookie: customerCookie } = await customerWith(
        `claims.${CLAIMS_CATEGORY}`,
      );
      const agentCookie = await signInAgent();
      await addAgentToConversation(conversationId);

      const granted = await requestUpload(
        customerRoutes.conversations.attachments(conversationId),
        conversationId,
        customerCookie,
        { filename: 'theirs.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { attachmentId } = (await granted.json()) as { attachmentId: string };

      // The agent is an owner of this very conversation, and still may not see the scan
      // state of a file the customer has not sent yet.
      expect((await statusFor(attachmentId, agentCookie)).status).toBe(404);
    });

    gate('refuses an attachment that does not exist, identically', async () => {
      const agentCookie = await signInAgent();
      const missing = await statusFor(crypto.randomUUID(), agentCookie);
      expect(missing.status).toBe(404);
    });
  });

  /**
   * The information panel's "Shared files" list.
   *
   * Three properties, and each is one somebody could reasonably get wrong:
   *
   *   1. A bound file is listed. The obvious one, and the only one a demo would catch.
   *   2. An UNBOUND upload is not. §28.1 makes binding the moment a file becomes reachable;
   *      an upload that has been granted but never sent is reachable by nobody, and listing
   *      it would show every participant that somebody started to share something.
   *   3. Somebody who is not in the conversation gets the same 404 as a missing one. The
   *      list is message content by another name — knowing a file called `theirs.pdf` was
   *      shared in a thread is knowing something about that thread.
   */
  describe('the files shared in a conversation', () => {
    const sharedFiles = (conversationId: string, cookie: string): Promise<Response> =>
      fetch(`${BASE}${employeeRoutes.conversations.attachments(conversationId)}`, {
        headers: { cookie },
      });

    gate('lists what has been sent, and nothing that has not', async () => {
      const { conversationId } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
      const agentCookie = await signInAgent();
      await addAgentToConversation(conversationId);

      // One file all the way through to a message.
      const sentGrant = await requestUpload(
        employeeRoutes.conversations.attachments(conversationId),
        conversationId,
        agentCookie,
        { filename: 'shared.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { attachmentId: sentId } = (await sentGrant.json()) as { attachmentId: string };
      await uploadBytes(sentId, pdfBytes('-1.7 claim'), 'employee', agentCookie);
      expect(await waitForState(sentId, 'CLEAN')).toBe('CLEAN');
      await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: agentCookie },
        body: JSON.stringify({
          body: 'the deck',
          visibility: 'INTERNAL',
          attachmentIds: [sentId],
        }),
      });

      // And one that was granted and abandoned.
      const abandoned = await requestUpload(
        employeeRoutes.conversations.attachments(conversationId),
        conversationId,
        agentCookie,
        { filename: 'never-sent.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
      );
      const { attachmentId: abandonedId } = (await abandoned.json()) as { attachmentId: string };

      const listed = await sharedFiles(conversationId, agentCookie);
      expect(listed.status).toBe(200);
      const { files } = (await listed.json()) as {
        files: { attachmentId: string; filename: string; declaredBytes: number }[];
      };

      expect(files.map((file) => file.attachmentId)).toContain(sentId);
      expect(
        files.map((file) => file.attachmentId),
        'an upload nobody sent is reachable by nobody and must not be listed',
      ).not.toContain(abandonedId);
      expect(files.find((file) => file.attachmentId === sentId)).toMatchObject({
        filename: 'shared.pdf',
        declaredBytes: 14,
      });
      expect(
        JSON.stringify(files),
        'the list is metadata only — a key here would be a durable link nobody audited',
      ).not.toMatch(/clean_key|quarantine_key|"url"/);
    });

    gate('refuses a conversation the caller is not in, as a 404', async () => {
      // Deliberately NOT calling `addAgentToConversation`: the agent has no relationship to
      // this thread at all.
      const { conversationId } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
      const agentCookie = await signInAgent();

      const refused = await sharedFiles(conversationId, agentCookie);
      expect(refused.status).toBe(404);

      const missing = await sharedFiles(crypto.randomUUID(), agentCookie);
      expect(
        missing.status,
        'a thread you may not see and a thread that does not exist must answer identically',
      ).toBe(refused.status);
    });
  });

  gate('step 4 — a customer cannot download an internal-note attachment', async () => {
    /**
     * The case §28.4's ladder exists for, over real sessions. An agent attaches a
     * document to an INTERNAL note in a conversation the customer owns. Steps 2 and 3
     * both pass for that customer — the record exists and the conversation is theirs —
     * and step 4 is the only thing that refuses.
     */
    const { conversationId, cookie: customerCookie } = await customerWith(
      `claims.${CLAIMS_CATEGORY}`,
    );

    const signIn = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASSWORD }),
    });
    const agentCookie = (signIn.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    // App-clocked, per ADR-025 — see the note in the employee upload test.
    const addedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool!.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, effective_from)
       VALUES ($1,$2,'EMPLOYEE','OWNER',$3)
       ON CONFLICT (conversation_id, principal_id) DO NOTHING`,
      [conversationId, AGENT, addedAt],
    );

    const granted = await requestUpload(
      employeeRoutes.conversations.attachments(conversationId),
      conversationId,
      agentCookie,
      { filename: 'assessor-notes.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };
    await uploadBytes(attachmentId, pdfBytes('-1.7 notes'), 'employee', agentCookie);
    expect(await waitForState(attachmentId, 'CLEAN')).toBe('CLEAN');

    const noted = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: agentCookie },
      body: JSON.stringify({
        body: 'assessor says the claim is weak',
        visibility: 'INTERNAL',
        attachmentIds: [attachmentId],
      }),
    });
    expect(noted.status).toBe(201);
    expect(((await noted.json()) as { attachedIds: string[] }).attachedIds).toEqual([attachmentId]);

    // The agent may fetch it.
    const byAgent = await fetch(`${BASE}${employeeRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie: agentCookie },
    });
    expect(byAgent.status).toBe(200);

    // The customer, whose conversation this is, may not.
    const byCustomer = await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie: customerCookie },
    });
    expect(byCustomer.status).toBe(404);

    // Recorded as what it was, not as a generic miss.
    const audited = await pool!.query(
      `SELECT reason FROM audit.ledger
        WHERE action = 'attachment.download.refused' AND target_id = $1`,
      [attachmentId],
    );
    expect(audited.rows[0]?.reason).toBe('INTERNAL_NOTE_ATTACHMENT');
  });

  gate('a successful download is audited (FR-ATT-5)', async () => {
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
    const granted = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'proof.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };
    await uploadBytes(attachmentId, pdfBytes('-1.7 proof'), 'customer', cookie);
    await waitForState(attachmentId, 'CLEAN');

    await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'proof attached', attachmentIds: [attachmentId] }),
    });
    await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie },
    });

    /**
     * ADR-012 accepts that a signed URL audits the ISSUANCE rather than the fetch, and
     * §28.4 records that as the trade it is. The record must exist either way.
     */
    const audited = await pool!.query(
      `SELECT outcome FROM audit.ledger WHERE action = 'attachment.download' AND target_id = $1`,
      [attachmentId],
    );
    expect(audited.rowCount).toBeGreaterThan(0);
    expect(audited.rows[0].outcome).toBe('SUCCEEDED');
  });

  gate('the download audit carries inherited sensitivity and the DLP verdict (§58)', async () => {
    /**
     * §58: "Attachments inherit conversation/object sensitivity but also get their own
     * classification, malware/DLP result, retention and download policy."
     *
     * The inheritance is a JOIN, not a copied column, so reclassifying a CONVERSATION
     * reclassifies its attachments with no migration — asserted below by changing the
     * conversation after the attachment already exists.
     *
     * `dlpClassification` reads NONE because the dev scanner produces none and a real
     * DLP provider is N-06. That absence is visible in the ledger rather than hidden,
     * which is the honest state to be in.
     */
    const { conversationId, cookie } = await customerWith(`claims.${CLAIMS_CATEGORY}`);
    const granted = await requestUpload(
      customerRoutes.conversations.attachments(conversationId),
      conversationId,
      cookie,
      { filename: 'scan.pdf', declaredMime: 'application/pdf', declaredBytes: 14 },
    );
    const { attachmentId } = (await granted.json()) as { attachmentId: string };
    await uploadBytes(attachmentId, pdfBytes('-1.7 medic'), 'customer', cookie);
    await waitForState(attachmentId, 'CLEAN');

    await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'my medical report', attachmentIds: [attachmentId] }),
    });

    // Reclassified AFTER the attachment was created and bound.
    await pool!.query(
      `UPDATE conversation.conversations SET sensitivity = 'MEDICAL' WHERE conversation_id = $1`,
      [conversationId],
    );

    await fetch(`${BASE}${customerRoutes.attachments.download(attachmentId)}`, {
      headers: { cookie },
    });

    const audited = await pool!.query(
      `SELECT detail FROM audit.ledger
        WHERE action = 'attachment.download' AND target_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [attachmentId],
    );
    const detail = audited.rows[0].detail as Record<string, unknown>;
    expect(detail.sensitivity).toBe('MEDICAL');
    expect(detail.dlpClassification).toBe('NONE');
  });
});
