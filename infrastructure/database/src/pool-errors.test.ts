/**
 * An error on an IDLE pooled connection must not take the process down.
 *
 * ## Why this file exists
 *
 * `pool.on('error')` was added to close the council finding "an ordinary database blip
 * killed both processes" — and shipped with no test at all. That is the shape of defect the
 * whole exercise is about: a control that is present, correct, and unevidenced, so nothing
 * would notice its removal.
 *
 * ## What is actually being asserted
 *
 * `pg.Pool` is an EventEmitter, and Node's EventEmitter **throws** when `'error'` is emitted
 * with no registered listener. That throw belongs to no request — the connection is idle by
 * definition — so it is inside nobody's try/catch and terminates the process. Registering
 * any listener is what converts it into an ordinary event.
 *
 * So the property is: after `createDatabase`, the pool has a handler, that handler does not
 * rethrow, and the caller's `onPoolError` is told. Asserting `listenerCount > 0` alone would
 * pass over a handler that rethrows; emitting the event and surviving is the real test.
 *
 * No database is required or opened. `createDatabase` builds the pool lazily — `pg.Pool`
 * connects on first checkout — so this runs anywhere.
 */
import { describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';

/** In the starlink namespace, so the §35.4 guard admits it. Never connected to. */
const CONNECTION = 'postgres://starlink:unused@localhost:59999/starlink';

describe('pool error handling', () => {
  it('registers a listener, so an idle-connection error is not an uncaught throw', () => {
    const { pool } = createDatabase({ connectionString: CONNECTION });
    try {
      expect(
        pool.listenerCount('error'),
        'with no listener, EventEmitter throws on emit and the process dies',
      ).toBeGreaterThan(0);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it('survives the emit rather than rethrowing', () => {
    /**
     * The assertion that a listener-count check cannot make. `emit('error', …)` on an
     * EventEmitter with a handler returns true and does not throw — unless the handler
     * itself throws, which is exactly the mistake a careless implementation makes.
     */
    const { pool } = createDatabase({ connectionString: CONNECTION });
    try {
      expect(() =>
        pool.emit('error', new Error('Connection terminated unexpectedly'), undefined as never),
      ).not.toThrow();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it('reports the error to the caller', () => {
    // What lets an app log it with its own service context. Both composition roots pass
    // one; without this the event would be silently swallowed instead of silently fatal,
    // which is a different and quieter failure.
    const seen: Error[] = [];
    const { pool } = createDatabase({
      connectionString: CONNECTION,
      onPoolError: (error) => seen.push(error),
    });

    try {
      const raised = new Error('terminating connection due to administrator command');
      raised.name = 'error';
      pool.emit('error', raised, undefined as never);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.message).toContain('administrator command');
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it('survives a callback that throws', () => {
    /**
     * The handler is the last line before an uncaught exception, so it must hold even when
     * the thing it calls misbehaves. A logger that throws — a serialisation failure on a
     * circular field, say — must not restore the crash this listener exists to prevent.
     */
    const { pool } = createDatabase({
      connectionString: CONNECTION,
      onPoolError: () => {
        throw new Error('the logger itself failed');
      },
    });

    try {
      expect(() => pool.emit('error', new Error('blip'), undefined as never)).not.toThrow();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });
});
