/**
 * The process safety net (council findings C1 and H1).
 *
 * These are behavioural, not structural: each case actually emits the process event and
 * asserts what happened. A test that only checked `process.listenerCount` would pass over
 * a handler that rethrows, which is the failure being guarded against.
 *
 * The asymmetry between the two events is the property under test, and it is easy to get
 * wrong in either direction — a net that swallows everything serves corrupt state, and one
 * that exits on everything turns one socket's bad packet into a company-wide outage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installProcessSafetyNet, type ProcessSafetyNet } from './process-safety.js';
import type { Logger } from './logger.js';

interface Line {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const record = (message: string, fields?: Record<string, unknown>): void => {
    lines.push({ message, fields: fields ?? {} });
  };
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

let net: ProcessSafetyNet | undefined;
afterEach(() => {
  net?.dispose();
  net = undefined;
});

/**
 * Emits directly rather than creating a real unhandled rejection.
 *
 * A genuine `Promise.reject()` is delivered by the platform on a later turn, and Vitest
 * installs its own listeners around the test — so a real one would race the runner and
 * report against whichever handler won. Emitting the event is the same input the process
 * delivers, at a moment the test controls.
 */
const emit = (event: 'unhandledRejection' | 'uncaughtException', payload: unknown): void => {
  process.emit(event as 'uncaughtException', payload as Error);
};

describe('installProcessSafetyNet', () => {
  describe('an unhandled rejection', () => {
    it('is survived, not fatal', () => {
      const { logger, lines } = recorder();
      const exit = vi.fn();
      net = installProcessSafetyNet({ logger, service: 'test-service', exit });

      emit('unhandledRejection', new Error('a socket handler threw'));

      expect(
        exit,
        'One request failing is not a reason to drop every other connection on the node.',
      ).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.fields.operation).toBe('test-service.unhandledRejection');
      expect(lines[0]?.fields.outcome).toBe('FAILED');
    });

    it('survives a rejection whose reason is not an Error', () => {
      // `Promise.reject('nope')` and `Promise.reject(undefined)` are both legal and both
      // reached this handler in the wild. Neither may throw from inside the net.
      const { logger, lines } = recorder();
      const exit = vi.fn();
      net = installProcessSafetyNet({ logger, service: 'test-service', exit });

      for (const reason of ['a string', undefined, null, 42, { code: 'X' }]) {
        expect(() => emit('unhandledRejection', reason)).not.toThrow();
      }
      expect(lines).toHaveLength(5);
      expect(exit).not.toHaveBeenCalled();
    });

    it('does not run the fatal shutdown', async () => {
      const { logger } = recorder();
      const onFatal = vi.fn(async () => undefined);
      net = installProcessSafetyNet({ logger, service: 'test-service', exit: vi.fn(), onFatal });

      emit('unhandledRejection', new Error('transient'));
      await Promise.resolve();

      expect(onFatal).not.toHaveBeenCalled();
    });
  });

  describe('an uncaught exception', () => {
    it('shuts down and exits non-zero', async () => {
      /**
       * The opposite decision, for the opposite reason: a throw that escaped every frame
       * leaves the process in a state nobody can describe, and continuing risks serving
       * wrong data — which is worse than being briefly absent.
       */
      const { logger, lines } = recorder();
      const exit = vi.fn();
      const onFatal = vi.fn(async () => undefined);
      net = installProcessSafetyNet({ logger, service: 'test-service', exit, onFatal });

      emit('uncaughtException', new Error('state is unknown'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

      expect(onFatal, 'the server must be given the chance to close').toHaveBeenCalled();
      expect(lines[0]?.fields.operation).toBe('test-service.uncaughtException');
    });

    it('still exits when the shutdown itself throws', async () => {
      // Already fatal. A cleanup failure must not turn "exiting" into "hung forever".
      const { logger } = recorder();
      const exit = vi.fn();
      net = installProcessSafetyNet({
        logger,
        service: 'test-service',
        exit,
        onFatal: () => {
          throw new Error('close failed too');
        },
      });

      emit('uncaughtException', new Error('boom'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    });

    it('exits anyway if the shutdown never finishes', async () => {
      const { logger } = recorder();
      const exit = vi.fn();
      net = installProcessSafetyNet({
        logger,
        service: 'test-service',
        exit,
        fatalGraceMs: 20,
        // Never resolves. A drain that hangs is the case the grace window exists for.
        onFatal: () => new Promise<void>(() => undefined),
      });

      emit('uncaughtException', new Error('boom'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 2_000 });
    });

    it('does not restart the shutdown on a second exception', async () => {
      const { logger } = recorder();
      const exit = vi.fn();
      const onFatal = vi.fn(async () => undefined);
      net = installProcessSafetyNet({ logger, service: 'test-service', exit, onFatal });

      emit('uncaughtException', new Error('first'));
      emit('uncaughtException', new Error('second'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());

      expect(onFatal).toHaveBeenCalledTimes(1);
    });
  });

  it('removes its listeners on dispose', () => {
    // Not housekeeping: a test file that leaked one of these would silently change how
    // every later test in the same process handles a rejection.
    const before = process.listenerCount('unhandledRejection');
    const installed = installProcessSafetyNet({ logger: recorder().logger, service: 's', exit: vi.fn() });
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    installed.dispose();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
