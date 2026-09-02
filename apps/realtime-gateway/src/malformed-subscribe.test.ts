/**
 * A malformed `subscribe` must not reach the database, and must not kill the node.
 *
 * ## The defect
 *
 * `parseChannel` accepted ANY string as a conversation id. The value went to
 * `PgConversationAuthzReader`, whose predicate is `WHERE c.conversation_id = $1` against a
 * `uuid` primary key, so Postgres raised a type error. The `subscribe` listener started the
 * handler as `void this.onSubscribe(...)` — a floating promise — and the repository had no
 * `unhandledRejection` handler anywhere, so Node's default action ran and the process
 * exited. `{"kind":"CONVERSATION","conversationId":"x"}` was a remote kill switch, usable
 * by anyone holding a session, and a customer session is obtainable anonymously.
 *
 * ## What is asserted, and why in this order
 *
 * Two independent defences, tested independently, because either one alone leaves the
 * product broken in a different way:
 *
 *   1. **The id never reaches the reader.** Asserted by counting reader calls, not by
 *      inspecting the ack — a version that queried and then failed gracefully would return
 *      the same `{ok:false}`.
 *   2. **A handler that throws anyway does not become process death.** Asserted by making
 *      the reader throw the way `pg` does, and watching for a real `unhandledRejection`.
 *      This is the one that matters for the NEXT unvalidated input, which is the actual
 *      lesson: validating one field fixes one packet.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { SessionService } from '@starlink/security';
import { createLogger } from '@starlink/observability';
import { InProcessBackplane } from '@starlink/adapter-realtime-backplane';
import type { ActorContext, ResourceContext } from '@starlink/conversation-domain';
import type {
  HealthReport,
  IdentityAuthorizationClient,
  PrincipalClaims,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import { ConnectionManager } from './connection-manager.js';
import { RealtimeGateway } from './gateway.js';

const SECRET = 'b'.repeat(40);
/** This file owns the `3c3c` id block. */
const EMPLOYEE = '018f2c5a-3c3c-7000-8000-00000000000a';
const CONVERSATION = '018f2c5a-3c3c-7000-8000-0000000000d1';
const logger = createLogger({ service: 'malformed-subscribe-test', sink: () => undefined });

const claims = (principalId: UUID): PrincipalClaims => ({
  principalId,
  employeeId: 'E-1',
  status: 'ACTIVE',
  displayName: 'Socket Tester',
  roles: [],
  teams: [],
  department: 'Service',
  managerChain: [],
  skills: [],
  products: [],
  languages: [],
  delegations: [],
  privilegedCapabilities: [],
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  authority: 'TEMPORARY_AUTHORITY',
  sessionVersion: 1,
});

class StubIdentity implements IdentityAuthorizationClient {
  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    if (principalId !== EMPLOYEE) {
      return err({ code: 'PRINCIPAL_NOT_FOUND', message: 'no', retryable: false, failureClass: 'FAIL_CLOSED', correlationId: 's' });
    }
    return ok(claims(principalId));
  }
  async verifyCredential(): Promise<Result<{ principalId: UUID }>> {
    return err({ code: 'AUTH_FAILED', message: 'no', retryable: false, failureClass: 'FAIL_CLOSED', correlationId: 's' });
  }
  async getSessionVersion(): Promise<Result<number>> {
    return ok(1);
  }
  async revokeSessions(): Promise<Result<void>> {
    return ok(undefined);
  }
  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}

const actor = (principalId: UUID): ActorContext => ({
  principalId,
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [],
  delegations: [],
  temporaryGrants: [],
});

const resource: ResourceContext = {
  conversationId: CONVERSATION,
  conversationType: 'CUSTOMER_SERVICE',
  currentOwnerId: EMPLOYEE,
  customerRef: 'CCS:customer:x',
  sensitivity: 'ORDINARY',
};

/** Records every id the gateway tried to look up, and can fail the way `pg` does. */
class RecordingAuthzReader {
  readonly seen: string[] = [];
  throwOnNext = false;

  async loadForAuthorization(conversationId: string): Promise<ResourceContext | undefined> {
    this.seen.push(conversationId);
    if (this.throwOnNext) {
      // The shape `pg` actually produces for a malformed uuid literal.
      const error = new Error('invalid input syntax for type uuid: "not-a-uuid"');
      error.name = 'error';
      throw error;
    }
    return conversationId === CONVERSATION ? resource : undefined;
  }
}

let httpServer: HttpServer;
let gateway: RealtimeGateway;
let sessions: SessionService;
let authz: RecordingAuthzReader;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  const identity = new StubIdentity();
  sessions = new SessionService({ secret: SECRET, identity, customerSessions: {
        /**
         * Employee-focused harness: customer sessions are minted here, not revoked, so the
         * live version always matches the issued one. Present because `verify` fails CLOSED
         * without a reader — which is the point of that design, and would otherwise refuse
         * every customer socket in this file for a reason unrelated to what it tests.
         */
        sessionVersionOf: async () => 1,
      }, });
  authz = new RecordingAuthzReader();

  httpServer = createServer();
  gateway = new RealtimeGateway({
    httpServer,
    sessions,
    backplane: new InProcessBackplane(),
    connections: new ConnectionManager({
      authz,
      actorFor: async (principalId) => actor(principalId),
      sessionVersionFor: async () => 1,
      teamFor: async (teamId) => ({ teamId, department: 'Service' }),
    }),
    logger,
    allowedOrigins: ['http://localhost'],
    maxConnectionsPerPrincipal: 4,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await gateway.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function open(): ClientSocket {
  const { token } = sessions.issue({
    principalId: EMPLOYEE,
    kind: 'EMPLOYEE',
    surface: 'EMPLOYEE',
    sessionVersion: 1,
  });
  const client = connect(url, {
    transports: ['websocket'],
    extraHeaders: { cookie: `sl_emp_session=${token}` },
    auth: { surface: 'EMPLOYEE' },
    reconnection: false,
  });
  clients.push(client);
  return client;
}

const connected = (client: ClientSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
  });

/** Emits `subscribe` with an arbitrary payload and waits for the acknowledgement. */
const subscribeRaw = (client: ClientSocket, payload: unknown, timeoutMs = 2_000): Promise<{ ok: boolean }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no acknowledgement — the client would hang')), timeoutMs);
    client.emit('subscribe', payload, (response: { ok: boolean }) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

describe('a malformed subscribe', () => {
  /**
   * Every shape that used to be accepted as a conversation id. `'x'` is the one that
   * killed the process; the rest are the neighbouring inputs a fix that special-cased a
   * single string would let through.
   */
  const MALFORMED = [
    'x',
    '',
    'not-a-uuid',
    '018f2c5a-3c3c-7000-8000',
    "'; DROP TABLE conversation.conversations; --",
    '018f2c5a-3c3c-7000-8000-0000000000d1 OR 1=1',
    ' 018f2c5a-3c3c-7000-8000-0000000000d1',
    'x'.repeat(10_000),
  ];

  it.each(MALFORMED)('is refused without reaching the database: %j', async (conversationId) => {
    const client = open();
    await connected(client);

    const ack = await subscribeRaw(client, { kind: 'CONVERSATION', conversationId });

    expect(ack.ok).toBe(false);
    expect(
      authz.seen,
      'the id must be rejected at the parse boundary — a uuid column is not a validator',
    ).toEqual([]);
  });

  it('refuses a malformed principal id too', async () => {
    // The same parse function, the same column type, and it was equally unvalidated.
    const client = open();
    await connected(client);

    expect((await subscribeRaw(client, { kind: 'PRINCIPAL', principalId: 'nope' })).ok).toBe(false);
    expect(authz.seen).toEqual([]);
  });

  it('still admits a well-formed id, so the guard is not simply refusing everything', async () => {
    /**
     * The control. Without it this file would pass over a `parseChannel` that returned
     * `undefined` unconditionally — which would "fix" the crash by breaking realtime.
     */
    const client = open();
    await connected(client);

    expect((await subscribeRaw(client, { kind: 'CONVERSATION', conversationId: CONVERSATION })).ok).toBe(true);
    expect(authz.seen).toEqual([CONVERSATION]);
  });

  it('leaves the connection usable, rather than dropping it', async () => {
    // A refusal is not a reason to disconnect: an ordinary client bug would otherwise cost
    // the user their live thread.
    const client = open();
    await connected(client);

    await subscribeRaw(client, { kind: 'CONVERSATION', conversationId: 'garbage' });
    expect(client.connected).toBe(true);
    expect((await subscribeRaw(client, { kind: 'CONVERSATION', conversationId: CONVERSATION })).ok).toBe(true);
  });
});

describe('a handler that throws anyway', () => {
  it('does not produce an unhandled rejection', async () => {
    /**
     * The general defence, and the one that matters for the next unvalidated field.
     *
     * A real `unhandledRejection` is what terminated the process. This listens for the
     * genuine process event rather than for a log line, because a log line would also be
     * emitted by a version that logs and then lets the rejection escape.
     */
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', capture);

    try {
      const client = open();
      await connected(client);

      authz.throwOnNext = true;
      const ack = await subscribeRaw(client, { kind: 'CONVERSATION', conversationId: CONVERSATION });

      // The client is told, rather than left waiting for a callback that never comes.
      expect(ack.ok).toBe(false);
      expect(authz.seen).toEqual([CONVERSATION]);

      // Give the platform a turn to deliver a rejection if one escaped.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        rejections,
        'an async socket handler threw and the rejection escaped — this is the crash',
      ).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  });

  it('keeps the gateway serving other sockets afterwards', async () => {
    const first = open();
    await connected(first);
    authz.throwOnNext = true;
    await subscribeRaw(first, { kind: 'CONVERSATION', conversationId: CONVERSATION });

    authz.throwOnNext = false;
    const second = open();
    await connected(second);
    expect((await subscribeRaw(second, { kind: 'CONVERSATION', conversationId: CONVERSATION })).ok).toBe(true);
  });
});
