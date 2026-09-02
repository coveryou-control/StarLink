/**
 * Regression: concurrent joins to the same channel (§20.6).
 *
 * `ensureChannelSubscription` was not single-flight. Two sockets joining one
 * conversation across the same await both found no subscription, both created one, and
 * the second OVERWROTE the first's entry — discarding the first socket's membership and
 * leaking its backplane subscription. That socket then received nothing at all, while
 * its join had acknowledged `ok: true` and every log line said it had succeeded.
 *
 * Reproducing it needs latency inside `subscribe`, which is why the in-process
 * backplane never showed it: it resolves immediately, so the two calls never interleave
 * and every sequential test passes. A Redis backplane is a network round trip, so in
 * production the window is wide open — and "two agents open the same thread at once" is
 * a queue being picked up, not an exotic race.
 *
 * The delayed backplane below is therefore not an artificial contrivance. It is the
 * realistic case; the in-process one is the unrealistically fast special case.
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
  RealtimeBackplane,
  RealtimeChannel,
  RealtimeEvent,
  RealtimeSubscriber,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import { ConnectionManager } from './connection-manager.js';
import { RealtimeGateway } from './gateway.js';

const SECRET = 'a'.repeat(40);
const OWNER = '018f2c5a-2b2b-7000-8000-00000000000a';
const CONVERSATION = '018f2c5a-2b2b-7000-8000-0000000000d1';
const logger = createLogger({ service: 'race-test', sink: () => undefined });

/** An in-process backplane with a network's worth of latency on subscribe. */
class DelayedBackplane implements RealtimeBackplane {
  subscribeCalls = 0;
  unsubscribeCalls = 0;

  constructor(
    private readonly inner: InProcessBackplane,
    private readonly delayMs: number,
  ) {}

  async subscribe(
    channel: RealtimeChannel,
    subscriber: RealtimeSubscriber,
  ): Promise<Result<() => void>> {
    this.subscribeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const result = await this.inner.subscribe(channel, subscriber);
    if (!result.ok) return result;
    const release = result.value;
    return ok(() => {
      this.unsubscribeCalls += 1;
      release();
    });
  }

  publish(event: RealtimeEvent): Promise<Result<void>> {
    return this.inner.publish(event);
  }

  localSubscriberCount(): number {
    return this.inner.localSubscriberCount();
  }

  health(): Promise<HealthReport> {
    return this.inner.health();
  }
}

const claims = (principalId: UUID): PrincipalClaims => ({
  principalId,
  employeeId: 'E-1',
  status: 'ACTIVE',
  displayName: 'Race Tester',
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
    return ok(claims(principalId));
  }
  async verifyCredential(): Promise<Result<{ principalId: UUID }>> {
    return err({
      code: 'AUTH_FAILED',
      message: 'nope',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: 'stub',
    });
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

const resource = (): ResourceContext => ({
  conversationId: CONVERSATION,
  conversationType: 'CUSTOMER_SERVICE',
  currentOwnerId: OWNER,
  customerRef: 'CCS:customer:x',
  sensitivity: 'ORDINARY',
});

let httpServer: HttpServer;
let gateway: RealtimeGateway;
let backplane: DelayedBackplane;
let sessions: SessionService;
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
  backplane = new DelayedBackplane(new InProcessBackplane(), 25);

  httpServer = createServer();
  gateway = new RealtimeGateway({
    httpServer,
    sessions,
    backplane,
    connections: new ConnectionManager({
      authz: { loadForAuthorization: async () => resource() },
      actorFor: async (principalId) => actor(principalId),
      sessionVersionFor: async () => 1,
      teamFor: async (teamId) => ({ teamId, department: 'Service' }),
    }),
    logger,
    allowedOrigins: ['http://localhost'],
    maxConnectionsPerPrincipal: 8,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await gateway.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function openSocket(): ClientSocket {
  const { token } = sessions.issue({
    principalId: OWNER,
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

const subscribe = (client: ClientSocket): Promise<{ ok: boolean }> =>
  new Promise((resolve) =>
    client.emit('subscribe', { kind: 'CONVERSATION', conversationId: CONVERSATION }, resolve),
  );

const nextEvent = (client: ClientSocket, timeoutMs = 2000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket received no event')), timeoutMs);
    client.once('event', (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const anEvent = (): RealtimeEvent => ({
  eventId: crypto.randomUUID(),
  name: 'message.created.v1',
  channel: { kind: 'CONVERSATION', conversationId: CONVERSATION },
  seq: 1,
  occurredAt: new Date().toISOString(),
  correlationId: 'c',
  payload: { messageId: crypto.randomUUID(), conversationId: CONVERSATION, seq: 1 },
  staffOnly: false,
});

describe('concurrent subscription to one channel', () => {
  it('delivers to EVERY socket that joined, not just the last one', async () => {
    const sockets = [openSocket(), openSocket(), openSocket()];
    await Promise.all(sockets.map(connected));

    const acks = await Promise.all(sockets.map(subscribe));
    expect(acks.every((ack) => ack.ok)).toBe(true);

    const arrivals = Promise.all(sockets.map((socket) => nextEvent(socket)));
    await backplane.publish(anEvent());

    // Before the single-flight fix, the first two of these timed out: their membership
    // had been discarded by the last writer, despite an `ok: true` acknowledgement.
    const received = await arrivals;
    expect(received.map((event) => event.name)).toEqual([
      'message.created.v1',
      'message.created.v1',
      'message.created.v1',
    ]);
  });

  it('opens exactly one backplane subscription for the channel', async () => {
    // The other half of the bug: each loser created a real subscription that nothing
    // ever released, so a busy gateway leaked one per concurrent join, forever.
    const sockets = [openSocket(), openSocket(), openSocket(), openSocket()];
    await Promise.all(sockets.map(connected));
    await Promise.all(sockets.map(subscribe));

    expect(backplane.subscribeCalls).toBe(1);
  });

  it('still releases the channel once the last socket leaves', async () => {
    const first = openSocket();
    const second = openSocket();
    await Promise.all([connected(first), connected(second)]);
    await Promise.all([subscribe(first), subscribe(second)]);

    first.disconnect();
    second.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(backplane.unsubscribeCalls).toBe(1);
    expect(gateway.metrics().channels).toBe(0);
  });
});
