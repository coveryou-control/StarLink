/**
 * A handshake that aborts must not hold a connection slot for ever.
 *
 * ## The defect, and how it was nearly missed
 *
 * The per-principal slot is taken inside the connect middleware, because the ceiling must
 * be enforced before a connection is admitted (§27.5). socket.io 4.8.3 checks
 * `client.conn.readyState` on the tick after the middleware calls `next()`
 * (`dist/namespace.js:221-227`) and, if the transport closed meanwhile, calls
 * `socket._cleanup()` and returns — `_doConnect` never runs, so neither `connection` nor
 * `disconnect` is emitted. A client that navigated away or lost its network during the
 * session lookup therefore left the slot held for the life of the process; after
 * `maxConnectionsPerPrincipal` such aborts, that employee could open no socket at all.
 *
 * An earlier version of this file concluded the opposite — "it does not reproduce" — and
 * that conclusion was wrong because THIS FILE was wrong: it released the gate in the same
 * tick as the close, so the close had not crossed the loopback socket by the time the
 * middleware resumed, the server still saw an open transport, and the benign
 * connection-then-disconnect path ran. The test passed with the fix removed and was read as
 * evidence there was nothing to fix.
 *
 * Two things follow, and both are in the file now: the helper waits for the close to reach
 * the server, and two positive controls assert that the window was actually entered — a
 * wrapped `register` proving a slot was claimed, and the absence of the `realtime
 * connected` log proving socket.io never emitted `connection`. A future version that races
 * past the window fails on those instead of passing vacuously.
 *
 * They replaced a `peakConnections` gauge sample, which could not work: the fix claims and
 * releases the slot inside one synchronous stretch of `authenticate`, so there is no turn
 * of the event loop on which a test can observe it held.
 *
 * ## Why this needs its own file
 *
 * Reproducing it requires the transport to close WHILE the middleware is awaiting, and the
 * shared harness resolves identity instantly — an abort there simply completes the
 * handshake and then disconnects normally, which is the path that always worked. This
 * gateway is built with an identity lookup the test can hold open, so the abort lands
 * exactly where it did in production.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { SessionService } from '@starlink/security';
import { createLogger } from '@starlink/observability';
import { InProcessBackplane } from '@starlink/adapter-realtime-backplane';
import type { ActorContext } from '@starlink/conversation-domain';
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

const SECRET = 'c'.repeat(40);
/** This file owns the `4d4d` id block. */
const EMPLOYEE = '018f2c5a-4d4d-7000-8000-00000000000a';
/**
 * Captured rather than discarded, because one of the two positive controls is a log line.
 *
 * `onConnection` is the ONLY thing that writes `realtime connected`, and it runs only when
 * socket.io emitted `connection` — that is, only on the benign connect-then-disconnect
 * path. Its absence is therefore direct evidence that the abort window was exercised, and
 * an earlier version of this test failed precisely because nothing checked that.
 *
 * The field is `msg`, not `message` — `StarlinkLogger.emit` writes `{ level, msg, ...ctx }`.
 * Getting that wrong makes the filter below match nothing, which is a control that passes
 * unconditionally; it was written wrong first time and caught only because the control
 * itself has a control (`the capture works at all`, below).
 */
let logged: Record<string, unknown>[] = [];
const logger = createLogger({
  service: 'handshake-abort-test',
  sink: (record) => {
    logged.push(record);
  },
});

const connectionLogs = (): Record<string, unknown>[] =>
  logged.filter((r) => r['msg'] === 'realtime connected');

const claims = (principalId: UUID): PrincipalClaims => ({
  principalId,
  employeeId: 'E-1',
  status: 'ACTIVE',
  displayName: 'Handshake Tester',
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

/** An identity adapter the test can hold open, standing in for a slow database. */
class GatedIdentity implements IdentityAuthorizationClient {
  /** When set, `resolvePrincipal` waits on it — that is the handshake window. */
  gate: Promise<void> | undefined;
  /**
   * How many times the handshake reached the identity lookup.
   *
   * This is how the tests prove they exercised the abort WINDOW rather than racing past it,
   * and it is an observation of the code under test rather than of a timer. An earlier
   * version inferred it from a connection count, which the fix then made unobservable —
   * the slot is now taken and released inside one synchronous block.
   */
  resolveCalls = 0;
  /** When set, `resolvePrincipal` THROWS — a database blip, not a refusal. */
  throwOnResolve = false;

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    this.resolveCalls += 1;
    if (this.throwOnResolve) throw new Error('database is down');
    if (this.gate !== undefined) await this.gate;
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

/** Small, so "the ceiling was consumed by phantoms" is reachable in a test. */
const CEILING = 2;

let httpServer: HttpServer;
let gateway: RealtimeGateway;
let sessions: SessionService;
let identity: GatedIdentity;
let url: string;
/** How many times a slot was actually claimed. See the wrapper in `beforeEach`. */
let registrations = 0;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  identity = new GatedIdentity();
  sessions = new SessionService({ secret: SECRET, identity, customerSessions: {
        /**
         * Employee-focused harness: customer sessions are minted here, not revoked, so the
         * live version always matches the issued one. Present because `verify` fails CLOSED
         * without a reader — which is the point of that design, and would otherwise refuse
         * every customer socket in this file for a reason unrelated to what it tests.
         */
        sessionVersionOf: async () => 1,
      }, });
  logged = [];

  /**
   * `register` is where the slot is CLAIMED, so counting it is the direct observation of
   * "this handshake took a slot" — the thing the deleted `peakConnections` control was
   * reaching for and could not see.
   *
   * It could not see it because the fix made the intermediate state unobservable from
   * outside: the slot is now claimed and given back inside one synchronous stretch of
   * `authenticate`, so no sampling of `metrics().connections` from the test's turn of the
   * event loop can ever catch it held. Wrapping the call is how the claim stays visible
   * without the test depending on a race it cannot win.
   */
  const manager = new ConnectionManager({
    authz: { loadForAuthorization: async () => undefined },
    actorFor: async (principalId) => actor(principalId),
    sessionVersionFor: async () => 1,
    teamFor: async (teamId) => ({ teamId, department: 'Service' }),
  });
  registrations = 0;
  const register = manager.register.bind(manager);
  manager.register = (input) => {
    registrations += 1;
    return register(input);
  };

  httpServer = createServer();
  gateway = new RealtimeGateway({
    httpServer,
    sessions,
    backplane: new InProcessBackplane(),
    connections: manager,
    logger,
    allowedOrigins: ['http://localhost'],
    maxConnectionsPerPrincipal: CEILING,
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

/**
 * Opens a socket, waits until the server is inside the middleware, kills the transport,
 * then lets the middleware finish.
 */
async function abortDuringHandshake(): Promise<void> {
  let release!: () => void;
  identity.gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client = open();
  // Wait for the transport to be established — the middleware runs after that, and it is
  // now parked on the gate.
  await vi.waitFor(() => expect(client.io.engine).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Kill the underlying transport, not the namespace socket: this is a network drop, not
  // a polite disconnect, and it is what socket.io handles by skipping `connection`.
  client.io.engine.close();

  /**
   * Let the close actually REACH the server before the handshake resumes.
   *
   * The first version of this helper called `release()` on the next statement. The close had
   * not yet crossed the loopback socket, so the server's `conn.readyState` was still "open"
   * when the middleware woke: socket.io took the ordinary path, emitted `connection` and then
   * `disconnect`, and the slot was released by the handler that always worked. The test
   * passed with the fix removed — and was read as evidence that the defect did not exist.
   *
   * This wait IS load-bearing. Remove it and the suite fails 3 runs out of 3, on control 2:
   * `connection` is emitted, the `realtime connected` log appears, and the test says so.
   *
   * ## A correction, and how the wrong answer was reached
   *
   * An earlier version of this comment stated the opposite — "NOT load-bearing on this
   * machine, deleting it the suite still passes 3/3" — and cited a measurement. The
   * measurement was real and the instrument was broken: it was taken while control 2 was
   * still filtering on `r.message` against a sink that writes `msg`, so the control matched
   * nothing and passed unconditionally. Removing the wait moved the test onto the benign
   * connect-then-disconnect path, exactly as it should have, and the only assertion that
   * could have noticed was inert. The reading was "3/3 green" and the conclusion drawn from
   * it was false.
   *
   * That is the same mistake this file was created to document, one level up: round 3
   * concluded "the leak does not reproduce" from a test that could not reproduce it. Here
   * the conclusion was "the sleep does not matter" from a control that could not fail. Both
   * times the number was true and meant nothing.
   *
   * ## What the wait does and does not buy
   *
   * A sleep can only make the right ordering LIKELY, and 150ms is a guess about a machine.
   * What makes the test HONEST is control 2: if the middleware ever resumes before the
   * close lands — on a loaded CI box, or with this line removed — the test fails loudly
   * instead of passing on the path that always worked. So the ordering is probabilistic and
   * the verdict is not, which is the right way round.
   */
  await new Promise((resolve) => setTimeout(resolve, 150));

  release();
  identity.gate = undefined;
  // Sampled on the very next turn, before any cleanup the platform performs later: this is
  // how the test knows the slot was actually TAKEN, and therefore that it is exercising the
  // window rather than racing past it.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('a handshake that aborts mid-authentication', () => {
  it('the capture works at all, and an ordinary connection is visible in it', async () => {
    /**
     * The control for control 2, and it is not ceremony — control 2 shipped BROKEN.
     *
     * It filtered on `r.message`, and the sink writes `msg`. Nothing matched, ever, so the
     * assertion "no connection was logged" was true of every possible run including the
     * ones it existed to reject. A vacuous control is worse than no control, because the
     * file then reads as though the window is guarded.
     *
     * This case fails if the field name drifts again, if the sink stops being wired, or if
     * `onConnection` stops logging — any of which would silently re-empty the filter.
     */
    await connected(open());

    expect(logged.length, 'nothing reached the sink — the capture is not wired').toBeGreaterThan(0);
    expect(
      connectionLogs().length,
      'an ordinary connection produced no `realtime connected` record, so an ABSENCE of ' +
        'one proves nothing about the abort path',
    ).toBe(1);
  });

  it('takes a slot, and then gives it back', async () => {
    /**
     * Three assertions, and the first two are the reason the third means anything.
     *
     * The history matters here. The first version of this test asserted only that the
     * count came back to zero, and PASSED with the fix removed — because it raced past the
     * abort window and exercised the benign connect-then-disconnect path, where the count
     * also comes back to zero. "Connections is 0" is true of a leak-free gateway and
     * equally true of a test that never took a slot at all. Without a control that
     * separates those, the assertion is decoration.
     *
     * So: `registrations` proves a slot was CLAIMED (control 1), and the absence of
     * `realtime connected` proves socket.io never emitted `connection` — i.e. this really
     * is the abort path and not the benign one (control 2). A future edit that resumes the
     * middleware before the close lands fails on control 2, loudly, instead of passing.
     *
     * `resolveCalls` used to stand in for control 1 and does not: it is incremented by any
     * handshake that reaches the identity lookup, benign or aborted, and the lookup happens
     * BEFORE the slot is claimed.
     */
    const before = registrations;
    await abortDuringHandshake();

    expect(
      registrations,
      'no slot was ever claimed — this test is not exercising the abort window, and would ' +
        'pass against the defect',
    ).toBe(before + 1);

    expect(
      connectionLogs(),
      'socket.io emitted `connection`, so this took the benign path that always worked. ' +
        'The close did not reach the server before the middleware resumed.',
    ).toEqual([]);

    await vi.waitFor(
      () => {
        expect(
          gateway.metrics().connections,
          'the aborted handshake kept its slot',
        ).toBe(0);
      },
      { timeout: 5_000 },
    );
  });

  it('refuses promptly when the identity adapter THROWS, instead of hanging', async () => {
    /**
     * A rejection out of `authenticate` used to be discarded by `void`, so `next()` was
     * never called: the client got no `connect_error` and socket.io held the connection
     * until `connectTimeout` — 45 seconds — expired.
     *
     * That path is also unbudgeted. The per-principal ceiling is enforced further down
     * this method, so nothing counts these sockets; during a database blip every
     * reconnecting client parks one for 45 seconds, which is the reconnect storm §32.4
     * exists to catch, produced by the outage it is meant to report.
     *
     * The timeout below is the assertion. A refusal arrives in milliseconds; the defect
     * takes 45 seconds, so anything under a second distinguishes them decisively without
     * making the test slow.
     */
    identity.throwOnResolve = true;

    await expect(
      Promise.race([
        connected(open()).then(
          () => 'connected',
          () => 'refused',
        ),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000)),
      ]),
      'the handshake neither connected nor refused — it is holding the socket until ' +
        'socket.io times it out 45 seconds from now, with nothing counting it',
    ).resolves.toBe('refused');

    // And the slot did not survive the throw.
    await vi.waitFor(() => {
      expect(gateway.metrics().connections, 'a thrown handshake kept its slot').toBe(0);
    });
  });

  it('does not consume the per-principal ceiling', async () => {
    /**
     * The assertion that matters to the person. With the leak, `CEILING` aborts exhausted
     * the employee's allowance permanently: every later socket was refused
     * `too_many_connections` until the gateway restarted, and no amount of closing tabs
     * helped because nothing was ever released.
     */
    for (let i = 0; i < CEILING; i += 1) await abortDuringHandshake();

    await expect(
      connected(open()),
      'the ceiling was consumed by handshakes that never became connections',
    ).resolves.toBeUndefined();
    await expect(connected(open())).resolves.toBeUndefined();
  });

  it('still enforces the ceiling for connections that DID succeed', async () => {
    // The control: the fix must not turn the ceiling off. Two real sockets fill it, and
    // the third is refused exactly as before.
    await connected(open());
    await connected(open());
    await expect(connected(open())).rejects.toThrow();
  });
});
