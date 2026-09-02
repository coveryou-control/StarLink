/**
 * The gateway over REAL sockets.
 *
 * `connection-manager.test.ts` proves the authorization rules as logic. This proves
 * they survive the transport: that an unauthenticated socket is actually refused at
 * the handshake, that a staff-only event is actually withheld from a customer sharing
 * the room, and that an event actually arrives. Those are different claims, and the
 * gap between them is where realtime bugs live.
 *
 * No database: identity and conversation facts are stubbed, because what is under test
 * here is the socket lifecycle, not SQL.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { SessionService } from '@starlink/security';
import { createLogger } from '@starlink/observability';
import { InProcessBackplane } from '@starlink/adapter-realtime-backplane';
import {
  conversationChannel,
  SOCKET_EVENTS,
  toConversationEvent,
  type RealtimeFrame,
  type SubscribeAck,
} from '@starlink/shared-contracts';
import type { ActorContext, ResourceContext } from '@starlink/conversation-domain';
import type {
  HealthReport,
  IdentityAuthorizationClient,
  PrincipalClaims,
  RealtimeEvent,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import { ConnectionManager } from './connection-manager.js';
import { RealtimeGateway } from './gateway.js';

const SECRET = 'a'.repeat(40);
const OWNER = '018f2c5a-2b2b-7000-8000-00000000000a';
const CUSTOMER = '018f2c5a-2b2b-7000-8000-00000000000c';
const CONVERSATION = '018f2c5a-2b2b-7000-8000-0000000000d1';
const logger = createLogger({ service: 'gateway-test', sink: () => undefined });

const claims = (principalId: UUID, version = 1): PrincipalClaims => ({
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
  sessionVersion: version,
});

class StubIdentity implements IdentityAuthorizationClient {
  readonly versions = new Map<UUID, number>([
    [OWNER, 1],
    [CUSTOMER, 1],
  ]);

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    const version = this.versions.get(principalId);
    if (version === undefined) {
      return err({
        code: 'PRINCIPAL_NOT_FOUND',
        message: 'no such principal',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'stub',
      });
    }
    return ok(claims(principalId, version));
  }

  async verifyCredential(): Promise<Result<{ principalId: UUID }>> {
    return err({
      code: 'AUTH_FAILED',
      message: 'authentication failed',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: 'stub',
    });
  }

  async getSessionVersion(principalId: UUID): Promise<Result<number>> {
    const version = this.versions.get(principalId);
    if (version === undefined) {
      return err({
        code: 'PRINCIPAL_NOT_FOUND',
        message: 'no such principal',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'stub',
      });
    }
    return ok(version);
  }

  async revokeSessions(principalId: UUID): Promise<Result<void>> {
    this.versions.set(principalId, (this.versions.get(principalId) ?? 1) + 1);
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}

const actorFor = (principalId: UUID): ActorContext => ({
  principalId,
  kind: principalId === CUSTOMER ? 'CUSTOMER' : 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...(principalId === CUSTOMER ? { assurance: 'VERIFIED_CUSTOMER' as const } : {}),
});

const resourceFor = (principalId: UUID): ResourceContext => ({
  conversationId: CONVERSATION,
  conversationType: 'CUSTOMER_SERVICE',
  currentOwnerId: OWNER,
  customerRef: 'CCS:customer:x',
  sensitivity: 'ORDINARY',
  ...(principalId === CUSTOMER ? { belongsToActorCustomer: true } : {}),
});

interface Harness {
  readonly url: string;
  readonly gateway: RealtimeGateway;
  readonly backplane: InProcessBackplane;
  readonly identity: StubIdentity;
  readonly sessions: SessionService;
  readonly httpServer: HttpServer;
}

let harness: Harness;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  const identity = new StubIdentity();
  const sessions = new SessionService({ secret: SECRET, identity, customerSessions: {
        /**
         * Employee-focused harness: customer sessions are minted here, not revoked, so the
         * live version always matches the issued one. Present because `verify` fails CLOSED
         * without a reader — which is the point of that design, and would otherwise refuse
         * every customer socket in this file for a reason unrelated to what it tests.
         */
        sessionVersionOf: async () => 1,
      }, });
  const backplane = new InProcessBackplane();
  const connections = new ConnectionManager({
    authz: { loadForAuthorization: async (_c, principalId) => resourceFor(principalId) },
    actorFor: async (principalId) => actorFor(principalId),
    sessionVersionFor: async (principalId) => identity.versions.get(principalId),
    teamFor: async (teamId) => ({ teamId, department: 'Service' }),
  });

  const httpServer = createServer();
  const gateway = new RealtimeGateway({
    httpServer,
    sessions,
    backplane,
    connections,
    logger,
    allowedOrigins: ['http://localhost'],
    maxConnectionsPerPrincipal: 2,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  harness = { url: `http://localhost:${port}`, gateway, backplane, identity, sessions, httpServer };
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await harness.gateway.drain();
  await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
});

/** Opens a client socket carrying a real session cookie. */
function openSocket(principalId: UUID, kind: 'EMPLOYEE' | 'CUSTOMER' = 'EMPLOYEE'): ClientSocket {
  const { token } = harness.sessions.issue({
    principalId,
    kind,
    surface: kind,
    sessionVersion: harness.identity.versions.get(principalId) ?? 1,
    ...(kind === 'CUSTOMER' ? { assurance: 'VERIFIED_CUSTOMER' as const } : {}),
  });
  const cookieName = kind === 'EMPLOYEE' ? 'sl_emp_session' : 'sl_cus_session';
  const client = connect(harness.url, {
    transports: ['websocket'],
    extraHeaders: { cookie: `${cookieName}=${token}` },
    auth: { surface: kind },
    reconnection: false,
  });
  clients.push(client);
  return client;
}

const connected = (client: ClientSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', (e) => reject(e));
  });

const subscribe = (client: ClientSocket, conversationId: string): Promise<{ ok: boolean }> =>
  new Promise((resolve) =>
    client.emit('subscribe', { kind: 'CONVERSATION', conversationId }, (r: { ok: boolean }) => resolve(r)),
  );

const nextEvent = (client: ClientSocket, timeoutMs = 2000): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no event received')), timeoutMs);
    client.on('event', (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const publish = (staffOnly: boolean): RealtimeEvent => ({
  eventId: crypto.randomUUID(),
  name: 'message.created.v1',
  channel: { kind: 'CONVERSATION', conversationId: CONVERSATION },
  seq: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'c',
  payload: { messageId: crypto.randomUUID(), conversationId: CONVERSATION, seq: 1 },
  staffOnly,
});

describe('handshake', () => {
  it('refuses a socket with no session cookie', async () => {
    const client = connect(harness.url, { transports: ['websocket'], reconnection: false });
    clients.push(client);
    await expect(connected(client)).rejects.toThrow();
  });

  it('refuses a forged session cookie', async () => {
    const client = connect(harness.url, {
      transports: ['websocket'],
      extraHeaders: { cookie: 'sl_emp_session=not.a.real.token' },
      reconnection: false,
    });
    clients.push(client);
    await expect(connected(client)).rejects.toThrow();
  });

  it('accepts a valid session', async () => {
    await expect(connected(openSocket(OWNER))).resolves.toBeUndefined();
  });

  it('enforces the per-principal connection ceiling', async () => {
    // One principal opening tabs without limit is indistinguishable from one
    // principal attacking the gateway (§27.5).
    await connected(openSocket(OWNER));
    await connected(openSocket(OWNER));
    await expect(connected(openSocket(OWNER))).rejects.toThrow();
  });

  it('frees the slot when a connection closes, so the ceiling is a ceiling and not a quota', async () => {
    /**
     * The ordinary release path, asserted because everything below depends on it working.
     * The ceiling here is two (`maxConnectionsPerPrincipal: 2` in the harness).
     */
    const first = openSocket(OWNER);
    await connected(first);
    await connected(openSocket(OWNER));

    first.disconnect();
    await vi.waitFor(async () => {
      expect(harness.gateway.metrics().connections).toBe(1);
    });

    await expect(connected(openSocket(OWNER))).resolves.toBeUndefined();
  });

  it('leaves nothing behind when a client gives up before connecting', async () => {
    /**
     * NOT the leak. This test cannot reproduce it, and used to say it did.
     *
     * The docblock here read "The leak, reproduced" and it was wrong on both halves of what
     * that requires. Reproducing the leak needs the transport to close WHILE the middleware
     * is suspended mid-`await`; this harness's `StubIdentity` resolves instantly, and
     * `disconnect()` is called synchronously after `openSocket` — before the transport is
     * even up. Nothing here asserts a slot was ever claimed, so `connections === 0` is
     * indistinguishable from "the server never saw these sockets at all", which is the
     * likelier reading. It passed with the fix removed.
     *
     * The real reproduction is `handshake-abort.test.ts`, which needs its own file for
     * exactly this reason: a gated identity stub to hold the middleware open, a wait for
     * the close to cross loopback, and two positive controls proving the window was
     * entered. This case is kept because the property it DOES check is worth keeping —
     * a client that gives up early costs the gateway nothing and does not eat the
     * employee's ceiling — but it is not evidence about the abort window, and a reader
     * arriving here from the changelog should not think it is.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const aborted = openSocket(OWNER);
      aborted.disconnect();
    }

    await vi.waitFor(
      async () => {
        expect(
          harness.gateway.metrics().connections,
          'an abandoned handshake left something behind',
        ).toBe(0);
      },
      { timeout: 5_000 },
    );

    // The proof that matters to the person: they can still open a socket afterwards.
    await expect(connected(openSocket(OWNER))).resolves.toBeUndefined();
    await expect(connected(openSocket(OWNER))).resolves.toBeUndefined();
  });
});

describe('subscribe and delivery', () => {
  it('delivers an event to an authorized subscriber', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    expect((await subscribe(client, CONVERSATION)).ok).toBe(true);

    const arrival = nextEvent(client);
    await harness.backplane.publish(publish(false));
    const event = (await arrival) as Record<string, unknown>;

    expect(event.name).toBe('message.created.v1');
    expect(event.seq).toBe(1);
    // Identifiers only — never a body (FR-RT-4).
    expect(JSON.stringify(event)).not.toContain('"body"');
  });

  it('delivers nothing to a socket that never subscribed', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await harness.backplane.publish(publish(false));
    await expect(nextEvent(client, 400)).rejects.toThrow('no event received');
  });

  it('stops delivering after unsubscribe', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await subscribe(client, CONVERSATION);
    client.emit('unsubscribe', { kind: 'CONVERSATION', conversationId: CONVERSATION });
    await new Promise((r) => setTimeout(r, 100));

    await harness.backplane.publish(publish(false));
    await expect(nextEvent(client, 400)).rejects.toThrow('no event received');
  });

  it('ignores a malformed subscribe rather than crashing', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    const result = await new Promise<{ ok: boolean }>((resolve) =>
      client.emit('subscribe', { kind: 'NONSENSE' }, (r: { ok: boolean }) => resolve(r)),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a subscribe to the control channel', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    const result = await new Promise<{ ok: boolean }>((resolve) =>
      client.emit('subscribe', { kind: 'CONTROL' }, (r: { ok: boolean }) => resolve(r)),
    );
    expect(result.ok).toBe(false);
  });
});

describe('staff-only events over the wire (§27.16)', () => {
  it('withholds a staff-only event from a customer in the SAME room', async () => {
    // Both are legitimately subscribed to this conversation. Membership is correct;
    // the event is still one the customer must never see.
    const staff = openSocket(OWNER);
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await Promise.all([connected(staff), connected(customer)]);
    await Promise.all([subscribe(staff, CONVERSATION), subscribe(customer, CONVERSATION)]);

    const staffArrival = nextEvent(staff);
    const customerArrival = nextEvent(customer, 700);
    await harness.backplane.publish(publish(true));

    await expect(staffArrival).resolves.toBeDefined();
    await expect(customerArrival).rejects.toThrow('no event received');
  });

  it('delivers a customer-visible event to both', async () => {
    const staff = openSocket(OWNER);
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await Promise.all([connected(staff), connected(customer)]);
    await Promise.all([subscribe(staff, CONVERSATION), subscribe(customer, CONVERSATION)]);

    const arrivals = Promise.all([nextEvent(staff), nextEvent(customer)]);
    await harness.backplane.publish(publish(false));
    await expect(arrivals).resolves.toHaveLength(2);
  });
});

describe('revocation closes the socket (§20.10 rule 3)', () => {
  it('disconnects a live socket when the principal is revoked', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await subscribe(client, CONVERSATION);

    const closed = new Promise<void>((resolve) => client.on('disconnect', () => resolve()));
    await harness.identity.revokeSessions(OWNER);
    expect(harness.gateway.revokePrincipal(OWNER)).toBe(1);

    await expect(closed).resolves.toBeUndefined();
  });

  it('refuses a NEW subscribe on a socket whose session was revoked', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await harness.identity.revokeSessions(OWNER);

    const result = await subscribe(client, CONVERSATION);
    expect(result.ok).toBe(false);
  });
});

describe('drain', () => {
  it('reports connections and channels while live', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await subscribe(client, CONVERSATION);
    const metrics = harness.gateway.metrics();
    expect(metrics.connections).toBe(1);
    expect(metrics.channels).toBe(1);
  });
});

/**
 * THE CLIENT CONTRACT — the test that would have caught F1.
 *
 * Every assertion below drives the socket using `@starlink/shared-contracts/realtime`,
 * which is the module `apps/employee-web/src/lib/use-realtime.ts` now imports. So this is
 * not "the gateway agrees with itself": it is the gateway agreeing with the exact names,
 * payload shapes and interpretation the web client uses.
 *
 * Before 2026-08-29 the client emitted `conversation.subscribe` and listened for
 * `conversation.event` against a gateway that spoke `subscribe` and `event`, and expected
 * `{ conversationId, seq, kind }` from a frame carrying
 * `{ eventId, name, seq, occurredAt, payload }`. The employee surface had never received a
 * realtime event. The existing tests in this file all passed, because they hard-coded the
 * gateway's own names — proving the server agreed with itself and nothing more.
 *
 * The gateway cannot import the web app (the boundary law forbids it, correctly), so the
 * shared contract is what makes an honest end-to-end assertion possible.
 */
describe('the client protocol contract (F1)', () => {
  it('accepts a subscribe built by the shared helper the web client uses', async () => {
    const client = openSocket(OWNER);
    await connected(client);

    const ack = await new Promise<SubscribeAck>((resolve) =>
      client.emit(
        SOCKET_EVENTS.subscribe,
        conversationChannel(CONVERSATION as never),
        (r: SubscribeAck) => resolve(r),
      ),
    );

    expect(ack.ok, 'the channel the web client builds was refused by the gateway').toBe(true);
  });

  it('delivers a frame the shared mapper can interpret into what the thread renders', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await new Promise<SubscribeAck>((resolve) =>
      client.emit(SOCKET_EVENTS.subscribe, conversationChannel(CONVERSATION as never),
        (r: SubscribeAck) => resolve(r)),
    );

    const received = new Promise<RealtimeFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame on the client event name')), 2000);
      client.on(SOCKET_EVENTS.event, (frame: RealtimeFrame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });

    await harness.backplane.publish(publish(false));
    const frame = await received;

    /**
     * The mapper is the client's own interpretation step. If the frame cannot be read,
     * `use-realtime` ignores it — so a frame that maps to `undefined` here is a frame the
     * UI would silently drop, which is the failure this test exists to make visible.
     */
    const event = toConversationEvent(frame);
    expect(event, 'the web client could not interpret the frame the gateway sent').toBeDefined();
    expect(event!.conversationId).toBe(CONVERSATION);
    expect(event!.seq).toBe(1);
    expect(event!.kind).toBe('MESSAGE_CREATED');
  });

  it('stops delivering after an unsubscribe built by the same helper', async () => {
    const client = openSocket(OWNER);
    await connected(client);
    await new Promise<SubscribeAck>((resolve) =>
      client.emit(SOCKET_EVENTS.subscribe, conversationChannel(CONVERSATION as never),
        (r: SubscribeAck) => resolve(r)),
    );

    client.emit(SOCKET_EVENTS.unsubscribe, conversationChannel(CONVERSATION as never));
    // Give the leave a tick to apply before publishing.
    await new Promise((r) => setTimeout(r, 50));

    let delivered = false;
    client.on(SOCKET_EVENTS.event, () => {
      delivered = true;
    });
    await harness.backplane.publish(publish(false));
    await new Promise((r) => setTimeout(r, 200));

    expect(delivered, 'an unsubscribed socket still received events').toBe(false);
  });

  it('ignores a frame whose event name the client does not know', () => {
    /**
     * §10's catalogue grows. A client that applied an unrecognised event at a guessed
     * position would corrupt the thread it is rendering; ignoring it and letting the next
     * re-fetch reconcile is invariant 9 working as designed.
     */
    expect(
      toConversationEvent({
        eventId: crypto.randomUUID() as never,
        name: 'conversation.something.new.v1',
        seq: 4,
        occurredAt: new Date().toISOString() as never,
        payload: { conversationId: CONVERSATION },
      }),
    ).toBeUndefined();
  });

  it('ignores a conversation frame with no sequence — it cannot be ordered', () => {
    expect(
      toConversationEvent({
        eventId: crypto.randomUUID() as never,
        name: 'message.created.v1',
        occurredAt: new Date().toISOString() as never,
        payload: { conversationId: CONVERSATION },
      }),
    ).toBeUndefined();
  });
});
