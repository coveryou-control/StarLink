/**
 * Realtime gateway bootstrap.
 *
 * Composition root for the gateway, mirroring the API's: configuration validated
 * before anything binds, and every dependency chosen here rather than reached for
 * deeper in.
 */
import { createServer } from 'node:http';
import { z } from 'zod';
import { InProcessBackplane, InProcessPresence } from '@starlink/adapter-realtime-backplane';
import { LocalIamAdapter } from '@starlink/adapter-iam';
import {
  PgConversationAuthzReader,
  PgCustomerStore,
  PgTeamLoadReader,
  createDatabase,
  databaseFromPool,
  validateStartupConfiguration,
} from '@starlink/database';
import { SessionService, verifyPassword } from '@starlink/security';
import { createLogger, installProcessSafetyNet, METRICS, metrics } from '@starlink/observability';
import { toActorContext } from '@starlink/conversation-domain';
import { MockEventPublisher } from '@starlink/adapter-event-bus';
import { OutboxRelay } from '@starlink/outbox-relay';
import { ConnectionManager } from './connection-manager.js';
import { RealtimeGateway } from './gateway.js';

const schema = z.object({
  SL_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
  SL_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SL_REALTIME_PORT: z.coerce.number().int().positive().default(3100),
  SL_DATABASE_URL: z.string().min(1),
  SL_SESSION_SECRET: z.string().min(32),
  SL_CURSOR_SECRET: z.string().min(32),
  SL_WEB_EMPLOYEE_ORIGIN: z.string().url().default('http://localhost:3010'),
  SL_WEB_CUSTOMER_ORIGIN: z.string().url().default('http://localhost:3020'),
  SL_RT_MAX_CONN_PER_PRINCIPAL: z.coerce.number().int().positive().default(8),
  SL_RELAY_POLL_MS: z.coerce.number().int().positive().default(1000),
  /**
   * Exists so NFR-AVL-2 is testable rather than asserted: the product must remain
   * fully usable with realtime switched off, and a flag is how that gets exercised.
   */
  SL_REALTIME_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

async function bootstrap(): Promise<void> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`StarLink realtime gateway refused to start:\n  - ${problems.join('\n  - ')}`);
  }
  const config = parsed.data;

  validateStartupConfiguration({
    SL_ENV: config.SL_ENV,
    SL_DATABASE_URL: config.SL_DATABASE_URL,
    SL_SESSION_SECRET: config.SL_SESSION_SECRET,
    SL_CURSOR_SECRET: config.SL_CURSOR_SECRET,
  });

  const logger = createLogger({ service: 'realtime-gateway', level: config.SL_LOG_LEVEL });

  if (!config.SL_REALTIME_ENABLED) {
    logger.warn('realtime disabled by configuration; exiting', {
      operation: 'realtime.bootstrap',
      outcome: 'SUCCEEDED',
    });
    return;
  }

  const { pool } = createDatabase({
    connectionString: config.SL_DATABASE_URL,
    maxConnections: 5,
    onPoolError: (error) =>
      logger.error('database pool error on an idle connection', {
        operation: 'realtime.database',
        outcome: 'FAILED',
        errorCode: error.name,
      }),
  });
  const identity = new LocalIamAdapter({ db: databaseFromPool(pool), verifySecret: verifyPassword });

  const teams = new PgTeamLoadReader(pool);
  /**
   * Customer session versions, so a revoked customer cookie cannot open a socket.
   *
   * `SessionService.verify` fails CLOSED without this — it would refuse every customer
   * session rather than waving it through, which is the right direction, but this process
   * is meant to serve customer sockets and a silent refusal is not what anyone wants to
   * debug. Supplied explicitly so the gateway agrees with the API about whether a session
   * is still valid; one column giving two surfaces different answers is the §38 divergence
   * this codebase keeps re-learning.
   */
  const customerSessions = new PgCustomerStore(pool);

  const connections = new ConnectionManager({
    authz: new PgConversationAuthzReader(pool),
    // The same reader the HTTP queue routes use, so a socket join and a queue read answer
    // the same question with the same data.
    teamFor: async (teamId) => teams.contextFor(teamId),
    actorFor: async (principalId) => {
      const claims = await identity.resolvePrincipal(principalId);
      return claims.ok ? toActorContext(claims.value) : undefined;
    },
    sessionVersionFor: async (principalId) => {
      const version = await identity.getSessionVersion(principalId);
      return version.ok ? version.value : undefined;
    },
  });

  const httpServer = createServer((request, response) => {
    // Liveness only. Readiness for the gateway is "can it accept sockets", which the
    // load balancer learns from the upgrade itself.
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    /**
     * The scrape endpoint, added 2026-08-29.
     *
     * `prometheus.yml` has scraped `starlink-realtime` at this port since Phase 3 and
     * this process answered 404 to every request. So the socket metrics §32.4 alerts on
     * -- reconnect storms -- and Part IV §68 gate 7's "dashboards/alerts exist for
     * sockets" had no source at all: not a missing dashboard, a missing endpoint.
     *
     * Same posture as the API's: text exposition, no session (a scraper carries none),
     * and reachable only from the deployment's internal network -- metric labels
     * describe internal structure, which §25.3 keeps away from customers.
     */
    if (request.url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });

  const backplane = new InProcessBackplane({
    onSubscriberError: (_error, channel) =>
      logger.warn('realtime subscriber threw', { operation: 'realtime.fanout', errorCode: channel }),
  });

  const gateway = new RealtimeGateway({
    httpServer,
    sessions: new SessionService({ secret: config.SL_SESSION_SECRET, identity, customerSessions }),
    backplane,
    connections,
    logger,
    allowedOrigins: [config.SL_WEB_EMPLOYEE_ORIGIN, config.SL_WEB_CUSTOMER_ORIGIN],
    maxConnectionsPerPrincipal: config.SL_RT_MAX_CONN_PER_PRINCIPAL,
    /**
     * In-process, so presence is per-NODE: two gateways each see only their own
     * connections, and a colleague on the other node reads as OFFLINE. That is wrong
     * but safe — presence never grants anything (§21.9) — and it is exactly what the
     * shared Redis store fixes. Single-node development is honest today; a multi-node
     * deploy needs the shared store before presence means anything.
     */
    presence: new InProcessPresence(),
  });
  gateway.start();

  /**
   * With an IN-PROCESS backplane the relay has to live here.
   *
   * Not a convenience — a consequence. An in-process backplane can only be reached
   * from inside this process, so a relay running in `apps/workers` would publish into
   * a backplane no gateway is listening to, and realtime would be silently dead while
   * every test still passed.
   *
   * With a shared backplane (Redis) this block goes away and the relay returns to
   * `apps/workers` where it belongs. That difference is exactly the Part IV §52
   * baseline, made visible rather than assumed.
   */
  const relay = new OutboxRelay({
    pool,
    backplane,
    publisher: new MockEventPublisher(),
    logger,
  });
  const relayTimer = setInterval(() => {
    void relay
      .drainOnce()
      .then(async (drained) => {
        /**
         * §32.4: "Outbox depth growing without draining — Sustained — Provider outage or
         * a stuck worker." `OutboxNotDraining` reads BOTH of these series and neither
         * existed before 2026-08-29, so the alert that watches for events silently
         * failing to publish was itself silent.
         *
         * The counter and the gauge are published together and after the drain, because
         * the alert's whole shape is `depth > 100 AND rate(published) == 0`. Publishing
         * the depth without the counter would make a healthy busy queue look stuck.
         */
        metrics.increment(METRICS.outboxPublished, drained.published);
        const state = await relay.metrics();
        metrics.set(METRICS.outboxDepth, state.depth);
        metrics.set(METRICS.outboxOldestAgeSeconds, state.oldestAgeSeconds);
      })
      .catch((error: unknown) => {
        logger.error('outbox drain failed', {
          operation: 'outbox.drain',
          outcome: 'FAILED',
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        });
      });
  }, config.SL_RELAY_POLL_MS);
  relayTimer.unref?.();
  logger.info('outbox relay running in-process (in-process backplane)', {
    operation: 'realtime.bootstrap',
    outcome: 'SUCCEEDED',
  });

  httpServer.listen(config.SL_REALTIME_PORT, () => {
    // eslint-disable-next-line no-console -- bind confirmation, before any request context exists
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'realtime-gateway',
        msg: 'listening',
        port: config.SL_REALTIME_PORT,
        backplane: 'in-process (single node)',
      }),
    );
  });

  /**
   * Drain before exit, so a rolling deploy sheds connections rather than dropping them.
   *
   * Idempotent, because it is reachable from two places at once — a signal handler and the
   * safety net's `onFatal` — and draining twice would call `unsubscribe` on subscriptions
   * that have already gone.
   */
  let shuttingDown: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shuttingDown ??= (async () => {
      clearInterval(relayTimer);
      await gateway.drain();
      await pool.end().catch(() => undefined);
    })();
    return shuttingDown;
  };

  /**
   * The process MUST exit, whether or not the drain succeeds.
   *
   * This was `void shutdown().then(() => process.exit(0))` — no `catch`. `gateway.drain()`
   * can reject (it calls `unsubscribe()` in a loop with no guard), and before the safety
   * net was installed below, that rejection killed the process, which accidentally
   * satisfied SIGTERM. Adding the net made the rejection survivable and therefore made
   * `process.exit(0)` unreachable: a rolling deploy would hang until SIGKILL.
   *
   * Two independent fixes: the rejection is caught here, and a timer guarantees the exit
   * even if the drain never settles. A shutdown that hangs must not prevent the shutdown.
   */
  const exitAfterDraining = (): void => {
    const hardStop = setTimeout(() => process.exit(0), 10_000);
    void shutdown()
      .catch((error: unknown) => {
        logger.error('drain failed during shutdown; exiting anyway', {
          operation: 'realtime.shutdown',
          outcome: 'FAILED',
          errorCode: error instanceof Error ? `${error.name}: ${error.message}` : 'UNKNOWN',
        });
      })
      .finally(() => {
        clearTimeout(hardStop);
        process.exit(0);
      });
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, exitAfterDraining);
  }

  /**
   * The last line of defence, and the reason it is last: everything above it is a specific
   * fix. `parseChannel` rejects the packet that was killing this process, `detach` catches
   * what a socket handler throws, and `onPoolError` handles a dropped idle connection.
   * This catches the ones nobody has thought of yet — in a process that holds every
   * employee's live socket, where one unhandled rejection was the whole outage.
   */
  installProcessSafetyNet({ logger, service: 'realtime-gateway', onFatal: shutdown });
}

void bootstrap();
