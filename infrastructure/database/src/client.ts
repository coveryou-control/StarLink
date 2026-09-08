/**
 * Database client construction.
 *
 * The only place a connection pool is created, so three properties hold everywhere
 * rather than being remembered per call site:
 *
 *   1. The §35.4 namespace guard runs BEFORE the pool exists, so a misconfigured
 *      StarLink never opens another product's database — not even briefly.
 *   2. TLS is required for any non-local host. A managed provider reached over the
 *      public internet without it would put message content on the wire in clear
 *      (NFR-SEC-4).
 *   3. `search_path` is pinned to the three declared schemas.
 *
 * A note on (3): every query in this codebase is schema-qualified
 * (`conversation.messages`, `identity.principals`, `audit.ledger`), so the search_path
 * is DEFENCE IN DEPTH, not load-bearing. It is applied with a `SET` on each new
 * connection rather than the `options` startup parameter, because PgBouncer-style
 * poolers — which every managed Postgres puts in front of you — reject unknown startup
 * parameters. Depending on it would make the app work locally and fail on the provider.
 */
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ALLOWED_SCHEMAS, assertDatabaseAllowed } from './guard.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Pool ceiling. Realtime and worker processes want fewer, longer-lived connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
  /** Statement timeout in ms. A query with no ceiling is an outage waiting for load. */
  readonly statementTimeoutMillis?: number;
  /**
   * Force TLS on or off. Normally inferred: required for any remote host, optional for
   * localhost. Set explicitly only for a deliberate exception.
   */
  readonly ssl?: boolean;
  /**
   * Called when the pool reports an error on an IDLE connection.
   *
   * The listener is always registered — see the comment at the registration — and this is
   * only how an app gets to log it with its own service context. It must not throw.
   */
  readonly onPoolError?: (error: Error) => void;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * A database reached over a network needs TLS; a loopback one does not.
 *
 * Inferred rather than configured so that pointing `SL_DATABASE_URL` at a managed
 * provider cannot silently downgrade to plaintext because someone forgot a flag.
 */
export function requiresTls(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'disable') return false;
    return !['localhost', '127.0.0.1', '::1', ''].includes(url.hostname);
  } catch {
    return true;
  }
}

/**
 * Wraps an EXISTING pool as a typed database handle.
 *
 * Exists so an app can share one pool across adapters without importing the ORM
 * itself: which query builder the database package uses is its own business, and an
 * app that imported drizzle directly would be coupled to that choice.
 */
export function databaseFromPool(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  // Before the pool, not after (§35.4, ARCHITECTURAL REQUIREMENT).
  assertDatabaseAllowed(options.connectionString);

  const useTls = options.ssl ?? requiresTls(options.connectionString);
  const statementTimeout = options.statementTimeoutMillis ?? 15_000;

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    /**
     * `search_path` and `statement_timeout`, applied by the SERVER as the connection is
     * established.
     *
     * These used to be two `SET` statements fired from a `pool.on('connect')` handler.
     * `pg` does not await that handler, so the statements raced the caller's first query
     * ON THE SAME CLIENT — pg's own warning says it plainly: "Calling client.query() when
     * the client is already executing a query". Under any concurrency the loser errors,
     * and the caller sees its first query fail on a connection that had just been handed
     * to it as ready.
     *
     * That is not theoretical. It is why opening a conversation could fail to establish
     * the thread's realtime socket: the gateway runs a five-connection pool, three sockets
     * authorise at once on page load, and the socket whose authorisation lost the race was
     * closed before its handshake completed. The thread then never received an event and
     * went on displaying LIVE, because the status is set from the transport.
     *
     * As a connection parameter there is no second statement, no race, and no extra round
     * trip. It also closes the hole the old comment admitted to — a "best-effort" statement
     * timeout is absent on exactly the connections created under load, which is when a
     * runaway query matters most.
     *
     * The trade is that a connection pooler which refuses the `options` parameter now fails
     * the connection rather than quietly running without these settings. That is the right
     * failure here, and it is not a configuration this product supports anyway: CLAUDE.md
     * requires the DIRECT endpoint, because the pooled one breaks the session-level
     * advisory locks and LISTEN/NOTIFY the outbox relay depends on.
     */
    options: `-c search_path=${ALLOWED_SCHEMAS.join(',')} -c statement_timeout=${statementTimeout}`,
    // Verify the provider's certificate. `rejectUnauthorized: false` would make TLS
    // theatre — it encrypts, but authenticates nothing.
    ...(useTls ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  /**
   * An idle connection dying must not take the process with it.
   *
   * `pg.Pool` is an EventEmitter, and it emits `'error'` from its listener on IDLE
   * clients — connections nobody is currently using. An EventEmitter that emits `'error'`
   * with no registered handler THROWS, and that throw is not inside anyone's try/catch
   * because it belongs to no request. So until 2026-08-30 the ordinary lifecycle events of
   * a managed database — Neon autosuspend, an RDS failover, a NAT idle reap, a single
   * `pg_terminate_backend` — terminated the API and the gateway mid-conversation.
   *
   * Surviving is correct here, not merely convenient: the pool's own job is to replace a
   * dead connection on the next checkout, and every in-flight request on a HEALTHY
   * connection is unaffected. If the database is genuinely gone, queries fail and
   * `/readyz` says so — which is a diagnosis, where a process exiting is a mystery.
   *
   * `onPoolError` lets an app log it with its own service context. The listener is
   * registered whether or not one is supplied, because the registration is the fix.
   */
  pool.on('error', (error: Error) => {
    try {
      options.onPoolError?.(error);
    } catch {
      // This listener is the last frame before an uncaught exception. A reporter that
      // throws — a logger failing to serialise something, say — must not restore the crash
      // the listener exists to prevent. Swallowed deliberately and without a second
      // reporting attempt, because the reporter is what just failed.
    }
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
