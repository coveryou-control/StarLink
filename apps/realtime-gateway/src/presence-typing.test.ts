/**
 * Presence and typing over REAL sockets (§21.9, §27.16).
 *
 * Typing is the only client-originated message the gateway fans out to other people,
 * which makes it the only place a client can put something on a colleague's — or a
 * customer's — screen. The tests that matter here are therefore the negative ones: what
 * a client CANNOT cause. In particular, an internal-note typing indicator reaching a
 * customer would tell them someone is writing them a reply that does not exist, and
 * leak the timing of internal activity.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { SessionService } from '@starlink/security';
import { createLogger } from '@starlink/observability';
import { InProcessBackplane, InProcessPresence } from '@starlink/adapter-realtime-backplane';
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

const SECRET = 'a'.repeat(40);
const AGENT_A = '018f2c5a-2b2b-7000-8000-00000000000a';
const AGENT_B = '018f2c5a-2b2b-7000-8000-00000000000b';
const CUSTOMER = '018f2c5a-2b2b-7000-8000-00000000000c';
const CONVERSATION = '018f2c5a-2b2b-7000-8000-0000000000d1';
const OTHER_CONVERSATION = '018f2c5a-2b2b-7000-8000-0000000000d2';
const logger = createLogger({ service: 'presence-test', sink: () => undefined });

const claims = (principalId: UUID, version = 1): PrincipalClaims => ({
  principalId,
  employeeId: 'E-1',
  status: 'ACTIVE',
  displayName: 'Presence Tester',
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
    [AGENT_A, 1],
    [AGENT_B, 1],
    [CUSTOMER, 1],
  ]);

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    const version = this.versions.get(principalId);
    if (version === undefined) return notFound();
    return ok(claims(principalId, version));
  }

  async verifyCredential(): Promise<Result<{ principalId: UUID }>> {
    return notFound();
  }

  async getSessionVersion(principalId: UUID): Promise<Result<number>> {
    const version = this.versions.get(principalId);
    if (version === undefined) return notFound();
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

function notFound(): Result<never> {
  return err({
    code: 'PRINCIPAL_NOT_FOUND',
    message: 'no such principal',
    retryable: false,
    failureClass: 'FAIL_CLOSED',
    correlationId: 'stub',
  });
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

const resourceFor = (conversationId: UUID, principalId: UUID): ResourceContext => ({
  conversationId,
  conversationType: 'CUSTOMER_SERVICE',
  currentOwnerId: AGENT_A,
  customerRef: 'CCS:customer:x',
  sensitivity: 'ORDINARY',
  // AGENT_B is a colleague pulled into the thread: a participant, not the owner. Say so
  // explicitly — an employee with no ownership, participation, team or grant has no read
  // path at all, and `decide()` refuses the join. That refusal would then make every
  // negative test in this file pass for entirely the wrong reason.
  ...(principalId === AGENT_B
    ? {
        participant: {
          role: 'COLLABORATOR',
          replyAuthority: false,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
      }
    : {}),
  ...(principalId === CUSTOMER ? { belongsToActorCustomer: true } : {}),
});

interface Harness {
  readonly url: string;
  readonly gateway: RealtimeGateway;
  readonly presence: InProcessPresence;
  readonly identity: StubIdentity;
  readonly sessions: SessionService;
  readonly httpServer: HttpServer;
}

let harness: Harness;
const clients: ClientSocket[] = [];

async function build(options: { withPresence?: boolean; typingMinIntervalMs?: number } = {}): Promise<void> {
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
  const presence = new InProcessPresence();
  const connections = new ConnectionManager({
    authz: {
      loadForAuthorization: async (conversationId, principalId) =>
        resourceFor(conversationId, principalId),
    },
    actorFor: async (principalId) => actorFor(principalId),
    sessionVersionFor: async (principalId) => identity.versions.get(principalId),
    teamFor: async (teamId) => ({ teamId, department: 'Service' }),
  });

  const httpServer = createServer();
  const gateway = new RealtimeGateway({
    httpServer,
    sessions,
    backplane: new InProcessBackplane(),
    connections,
    logger,
    allowedOrigins: ['http://localhost'],
    maxConnectionsPerPrincipal: 4,
    typingMinIntervalMs: options.typingMinIntervalMs ?? 0,
    ...(options.withPresence === false ? {} : { presence }),
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  harness = { url: `http://localhost:${port}`, gateway, presence, identity, sessions, httpServer };
}

beforeEach(() => build());

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await harness.gateway.drain();
  await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
});

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
    client.on('connect_error', reject);
  });

/**
 * Subscribe, ASSERTING the join succeeded.
 *
 * A refused join is silent from the client's point of view — it simply never receives
 * anything — which is indistinguishable from "the server correctly withheld this". That
 * ambiguity turned every negative test in this file green while nothing worked at all.
 * Assert here so a broken fixture fails loudly at the setup line instead.
 */
const subscribe = async (
  client: ClientSocket,
  conversationId: string,
): Promise<{ ok: boolean; typing?: string[] }> => {
  const ack = await new Promise<{ ok: boolean; typing?: string[] }>((resolve) =>
    client.emit('subscribe', { kind: 'CONVERSATION', conversationId }, resolve),
  );
  expect(ack.ok, 'join was refused — check the authorization fixture, not the assertion').toBe(
    true,
  );
  return ack;
};

const nextTyping = (client: ClientSocket, timeoutMs = 2000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no typing signal received')), timeoutMs);
    client.once('typing', (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

/** Resolves true if NOTHING arrived in the window — the shape most of these tests need. */
const noTyping = (client: ClientSocket, windowMs = 300): Promise<boolean> =>
  new Promise((resolve) => {
    let seen = false;
    const onTyping = (): void => {
      seen = true;
    };
    client.on('typing', onTyping);
    setTimeout(() => {
      client.off('typing', onTyping);
      resolve(!seen);
    }, windowMs);
  });

describe('typing signals', () => {
  it('reaches another employee in the same conversation', async () => {
    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    await Promise.all([subscribe(a, CONVERSATION), subscribe(b, CONVERSATION)]);

    const received = nextTyping(b);
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });

    expect(await received).toMatchObject({
      conversationId: CONVERSATION,
      principalId: AGENT_A,
      visibility: 'CUSTOMER_VISIBLE',
    });
  });

  it('is never echoed back to the sender', async () => {
    const a = openSocket(AGENT_A);
    await connected(a);
    await subscribe(a, CONVERSATION);

    const quiet = noTyping(a);
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });

    expect(await quiet).toBe(true);
  });

  it('WITHHOLDS an internal-note signal from a customer in the same room', async () => {
    // The leak this whole file exists to prevent: a customer must not learn that an
    // agent is composing something, when what they are composing is a note the
    // customer will never see.
    const agent = openSocket(AGENT_A);
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await Promise.all([connected(agent), connected(customer)]);
    await Promise.all([subscribe(agent, CONVERSATION), subscribe(customer, CONVERSATION)]);

    const quiet = noTyping(customer);
    agent.emit('typing', { conversationId: CONVERSATION, visibility: 'INTERNAL' });

    expect(await quiet).toBe(true);
  });

  it('delivers a customer-visible signal to that same customer', async () => {
    // The counterpart to the test above: withholding must be specific to INTERNAL, not
    // a blanket mute that would make the previous test pass for the wrong reason.
    const agent = openSocket(AGENT_A);
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await Promise.all([connected(agent), connected(customer)]);
    await Promise.all([subscribe(agent, CONVERSATION), subscribe(customer, CONVERSATION)]);

    const received = nextTyping(customer);
    agent.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });

    expect(await received).toMatchObject({ principalId: AGENT_A, visibility: 'CUSTOMER_VISIBLE' });
  });

  it('drops a signal for a conversation the socket never joined', async () => {
    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    // b is listening on the other conversation; a joined neither.
    await subscribe(b, OTHER_CONVERSATION);

    const quiet = noTyping(b);
    a.emit('typing', { conversationId: OTHER_CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });

    expect(await quiet).toBe(true);
    // And nothing was recorded, so it cannot surface later via a join snapshot either.
    const typists = await harness.presence.getTyping(OTHER_CONVERSATION);
    expect(typists.ok && typists.value).toEqual([]);
  });

  it('refuses a customer claiming to compose an internal note', async () => {
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    const agent = openSocket(AGENT_A);
    await Promise.all([connected(customer), connected(agent)]);
    await Promise.all([subscribe(customer, CONVERSATION), subscribe(agent, CONVERSATION)]);

    const quiet = noTyping(agent);
    customer.emit('typing', { conversationId: CONVERSATION, visibility: 'INTERNAL' });

    expect(await quiet).toBe(true);
  });

  it('drops malformed payloads instead of guessing a visibility', async () => {
    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    await Promise.all([subscribe(a, CONVERSATION), subscribe(b, CONVERSATION)]);

    const quiet = noTyping(b, 400);
    // Defaulting any of these to CUSTOMER_VISIBLE would be the fail-open direction.
    a.emit('typing', { conversationId: CONVERSATION });
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'SECRET' });
    a.emit('typing', { visibility: 'CUSTOMER_VISIBLE' });
    a.emit('typing', 'not-an-object');
    a.emit('typing', null);

    expect(await quiet).toBe(true);
  });

  it('throttles a keystroke storm to one broadcast per interval', async () => {
    await harness.gateway.drain();
    await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
    await build({ typingMinIntervalMs: 10_000 });

    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    await Promise.all([subscribe(a, CONVERSATION), subscribe(b, CONVERSATION)]);

    let count = 0;
    b.on('typing', () => {
      count += 1;
    });
    for (let i = 0; i < 25; i += 1) {
      a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(count).toBe(1);
  });

  it('hands a joining employee whoever is already typing', async () => {
    const a = openSocket(AGENT_A);
    await connected(a);
    await subscribe(a, CONVERSATION);
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const b = openSocket(AGENT_B);
    await connected(b);
    const ack = await subscribe(b, CONVERSATION);

    // Without this, opening a thread shows nothing until the next keystroke and a
    // colleague mid-sentence looks idle.
    expect(ack.typing).toEqual([AGENT_A]);
  });

  it('does not hand the typing snapshot to a customer', async () => {
    // The store records WHO is typing but not at which visibility, so the only safe
    // reading for a customer is that any of them might be writing an internal note.
    const a = openSocket(AGENT_A);
    await connected(a);
    await subscribe(a, CONVERSATION);
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await connected(customer);
    const ack = await subscribe(customer, CONVERSATION);

    expect(ack.ok).toBe(true);
    expect(ack.typing).toBeUndefined();
  });

  it('works with no presence store configured at all', async () => {
    // Presence is decoration; a gateway without it must still carry messages (§21.9).
    await harness.gateway.drain();
    await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
    await build({ withPresence: false });

    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    const ack = await subscribe(a, CONVERSATION);
    await subscribe(b, CONVERSATION);

    expect(ack.ok).toBe(true);
    const quiet = noTyping(b);
    a.emit('typing', { conversationId: CONVERSATION, visibility: 'CUSTOMER_VISIBLE' });
    expect(await quiet).toBe(true);
  });
});

describe('presence leases', () => {
  it('takes a lease when a connection is established', async () => {
    const a = openSocket(AGENT_A);
    await connected(a);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const records = await harness.presence.get([AGENT_A]);
    expect(records.ok && records.value[0]?.state).toBe('ONLINE');
  });

  it('reads OFFLINE for someone who never connected', async () => {
    const records = await harness.presence.get([AGENT_B]);
    expect(records.ok && records.value[0]?.state).toBe('OFFLINE');
  });

  it('releases the lease when the last connection closes', async () => {
    const a = openSocket(AGENT_A);
    await connected(a);
    await new Promise((resolve) => setTimeout(resolve, 50));

    a.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const records = await harness.presence.get([AGENT_A]);
    expect(records.ok && records.value[0]?.state).toBe('OFFLINE');
  });

  it('keeps the lease while another tab is still open', async () => {
    // Closing one of three tabs must not show a colleague as offline while they are
    // still working — the bug every naive per-socket presence implementation ships.
    const tabOne = openSocket(AGENT_A);
    const tabTwo = openSocket(AGENT_A);
    await Promise.all([connected(tabOne), connected(tabTwo)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    tabOne.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const records = await harness.presence.get([AGENT_A]);
    expect(records.ok && records.value[0]?.state).toBe('ONLINE');
  });

  it('releases every lease this node holds when it drains', async () => {
    // A rolling deploy should not blank the team's presence until the TTL lapses.
    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await harness.gateway.drain();

    const records = await harness.presence.get([AGENT_A, AGENT_B]);
    expect(records.ok && records.value.map((r) => r.state)).toEqual(['OFFLINE', 'OFFLINE']);
  });
});

/**
 * The presence READ path.
 *
 * The lease was written from the moment the gateway existed and nothing could read it —
 * `presence.get()` was called only from this file. Every avatar in the employee surface
 * was therefore stateless, not because presence was unavailable but because there was no
 * way to ask. These cover the query that closes that gap.
 */
describe('presence query', () => {
  const query = (client: ClientSocket, principalIds: readonly string[]): Promise<{ online: string[] }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack')), 3_000);
      client.emit('presence.query', { principalIds }, (response: { online: string[] }) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

  it('reports a connected colleague as online and an absent one as not', async () => {
    const a = openSocket(AGENT_A);
    await connected(a);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const answer = await query(a, [AGENT_A, AGENT_B]);
    expect(answer.online).toContain(AGENT_A);
    // AGENT_B has never connected, so there is no lease to find.
    expect(answer.online).not.toContain(AGENT_B);
  });

  it('stops reporting somebody once their last socket closes', async () => {
    /**
     * The property that makes this presence rather than a login record. The lease is
     * released on the last disconnect, and the very next query must reflect it — a dot
     * that stays green after somebody closes their laptop is worse than no dot.
     */
    const a = openSocket(AGENT_A);
    const b = openSocket(AGENT_B);
    await Promise.all([connected(a), connected(b)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await query(a, [AGENT_B])).online).toContain(AGENT_B);

    b.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await query(a, [AGENT_B])).online).not.toContain(AGENT_B);
  });

  it('tells a customer nothing about staff connectivity', async () => {
    /**
     * Enumerating which employees are at their desks is not a customer's business, and the
     * check is on the AUTHENTICATED principal kind rather than on anything in the payload —
     * a client that asks nicely must not be able to change the answer.
     */
    const staff = openSocket(AGENT_A);
    const customer = openSocket(CUSTOMER, 'CUSTOMER');
    await Promise.all([connected(staff), connected(customer)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await query(customer, [AGENT_A])).online).toEqual([]);
    // The control: the same question from an employee is answered.
    expect((await query(staff, [AGENT_A])).online).toContain(AGENT_A);
  });

  it('answers rather than hanging when the payload is malformed', async () => {
    /**
     * The ack is what the client waits on. A handler that returns without acking leaves
     * every presence poll to time out, and presence going quiet must never be
     * indistinguishable from the socket going quiet.
     */
    const a = openSocket(AGENT_A);
    await connected(a);

    for (const payload of [null, {}, { principalIds: 'nope' }, { principalIds: [] }]) {
      const answer = await new Promise<{ online: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ack')), 3_000);
        a.emit('presence.query', payload, (response: { online: string[] }) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
      expect(answer.online).toEqual([]);
    }
  });

  it('bounds how many principals one query may ask about', async () => {
    /**
     * The caller is a browser asking about what is on its screen. Without a bound, one
     * socket could ask the lease store about every principal in the company on a timer.
     */
    const a = openSocket(AGENT_A);
    await connected(a);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const many = Array.from({ length: 200 }, (_, i) => `018f2c5a-2b2b-7000-8000-${String(i).padStart(12, '0')}`);
    const answer = await query(a, [...many, AGENT_A]);
    // AGENT_A is beyond the cap, so it is dropped along with the padding — the point is
    // that the query is truncated rather than served in full.
    expect(answer.online).toEqual([]);
  });
});
