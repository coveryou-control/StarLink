/**
 * Keeping a long-lived process alive through the failures it is allowed to survive —
 * and stopping cleanly through the ones it is not.
 *
 * ## Why this exists
 *
 * Neither the API nor the realtime gateway registered a single process-level error
 * handler, and neither registered `pool.on('error')`. Two consequences, both verified:
 *
 *   * **One packet killed the gateway.** An async socket handler was started with
 *     `void handler(...)`; a malformed `subscribe` reached a `uuid` column, Postgres
 *     raised, and the rejection had nowhere to go. Node's default action for an unhandled
 *     rejection is to terminate. Any session — a customer one is obtainable anonymously —
 *     could do it in a loop.
 *   * **An ordinary database blip killed both.** `pg.Pool` emits `'error'` from its IDLE
 *     client listener. With no handler, an EventEmitter `'error'` is thrown. Neon
 *     autosuspend, an RDS failover, a NAT idle reap or one `pg_terminate_backend` was
 *     enough, mid-conversation, with no shutdown path.
 *
 * ## The distinction this file draws
 *
 * `unhandledRejection` and `uncaughtException` are NOT the same event and must not get the
 * same treatment.
 *
 * An **unhandled rejection** is nearly always one request's failure that nobody awaited.
 * The process is still coherent: other sockets are fine, the pool is fine, in-flight work
 * is unaffected. Taking the whole node down for it converts one user's error into everyone
 * else's outage, and §34's degradation posture is explicit that a partial failure must stay
 * partial. So it is logged loudly and survived.
 *
 * It is NOT counted, and that is a gap rather than a decision: a process quietly absorbing
 * rejections has no alertable series, so the failure mode this file creates — surviving
 * something that used to be loud — is invisible to monitoring. An earlier version of this
 * comment claimed a counter that was never written; the claim is removed rather than the
 * gap papered over. Wiring it needs a metric name, which is `packages/observability`'s
 * registry to decide.
 *
 * An **uncaught exception** is a throw that escaped every frame. The process's state is
 * unknown by definition — a half-applied mutation, a released-twice client, a listener
 * that will never fire. Continuing risks serving wrong data, which is worse than being
 * down. So it is logged and the process exits non-zero for the supervisor to replace.
 *
 * The asymmetry is the point. "Never crash" and "always crash" are both wrong.
 */
import type { Logger } from './logger.js';

export interface ProcessSafetyOptions {
  readonly logger: Logger;
  /** Named in the log line, so a shared log stream says which process it was. */
  readonly service: string;
  /**
   * Run before exiting on a fatal error — close the server, drain sockets. Given a short
   * bounded window; a shutdown that hangs must not stop the process from dying.
   */
  readonly onFatal?: () => Promise<void> | void;
  /** How long `onFatal` gets before the process exits anyway. */
  readonly fatalGraceMs?: number;
  /** Injected in tests. Nothing else should pass this. */
  readonly exit?: (code: number) => void;
}

export interface ProcessSafetyNet {
  /** Removes the listeners. For tests — a real process keeps them for its lifetime. */
  readonly dispose: () => void;
}

export function installProcessSafetyNet(options: ProcessSafetyOptions): ProcessSafetyNet {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.fatalGraceMs ?? 5_000;

  const describe = (reason: unknown): string => {
    if (reason instanceof Error) return reason.name;
    if (typeof reason === 'string') return reason.slice(0, 120);
    return 'UNKNOWN';
  };

  const onRejection = (reason: unknown): void => {
    options.logger.error('unhandled promise rejection — survived', {
      operation: `${options.service}.unhandledRejection`,
      outcome: 'FAILED',
      errorCode: describe(reason),
    });
  };

  let exiting = false;
  const onException = (error: unknown): void => {
    // A second throw while shutting down must not restart the shutdown or block the exit.
    if (exiting) return;
    exiting = true;

    options.logger.error('uncaught exception — shutting down', {
      operation: `${options.service}.uncaughtException`,
      outcome: 'FAILED',
      errorCode: describe(error),
    });

    /**
     * The grace timer is deliberately NOT unref'd.
     *
     * It was, on the reasoning that a timer should not hold the loop open. The consequence
     * was the opposite of this file's stated intent: if `onFatal` never settled and the
     * remaining handles were closed or unref'd, Node drained the event loop and exited
     * **0** — reporting a clean shutdown to the supervisor for a fatal error, which is
     * exactly the signal that stops it replacing the process.
     *
     * A ref'd timer keeps the process alive for at most `graceMs` and then exits non-zero,
     * which is the outcome described above. It is cleared as soon as `onFatal` settles, so
     * it cannot delay a clean stop.
     */
    const timer = setTimeout(() => exit(1), graceMs);

    void (async () => {
      try {
        await options.onFatal?.();
      } catch {
        // Already fatal. A failure to clean up changes nothing about the outcome.
      } finally {
        clearTimeout(timer);
        exit(1);
      }
    })();
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return {
    dispose: () => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}
