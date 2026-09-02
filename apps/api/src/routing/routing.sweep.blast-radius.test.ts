/**
 * One poison item costs its own placement, not the batch's.
 *
 * ## The regression this exists to catch
 *
 * The participation ledger write moved INSIDE `assignFromRouting`'s transaction, which is
 * where §31.1 requires it: the grant and the audit row for the grant are one fact, and a
 * ledger write on a second connection can commit the grant and lose the record of it.
 *
 * That was correct in isolation and wrong in composition. It put a write that can fail
 * onto a path with no exception handling anywhere along it — `LocalWorkOrchestrator`
 * contains no `try`/`catch` at all, and `RoutingSweep.run()` had none either. So a single
 * rejected INSERT propagated out of `requestRouting`, out of `run()`, and took every
 * remaining item of a batch of 100 with it for that tick.
 *
 * **A correction, because the first version of this header overstated it.** It claimed the
 * next tick would "hit the same item in the same position and abort in the same place…
 * indefinitely", so that one bad conversation stopped routing for the whole product. That
 * is false. `requestRouting` commits the queue entry in its OWN transaction before
 * reaching `assignFromRouting`, and `RoutingSweep`'s selection excludes any conversation
 * that already holds a non-CANCELLED queue entry — so the failing item removes itself from
 * the sweep's scope, and the following tick picks up the rest of the batch normally. The
 * real cost was one tick's remaining placements, plus a rejected promise in a timer
 * callback (which `schedule()` does catch and log).
 *
 * The scope of THIS file is therefore exactly one property: a failure costs one item, not
 * the rest of the loop. It proves nothing about recovery, and it cannot — the stub pool
 * below returns the same rows on every call and does not model the committed queue entry
 * that takes a failed item out of scope. That gap is named here rather than left for a
 * reader to infer from a comment that sounded like it covered more.
 *
 * ## Why this test has no database
 *
 * The property is about control flow, not about SQL. A stub pool and a stub orchestrator
 * make the failure injectable at exactly the point where it really occurs, and let the
 * batch be big enough for "the rest of the batch" to be a meaningful phrase. An
 * integration test would need a way to make one specific ledger INSERT fail and no other,
 * which is harder to write and proves less.
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Result, RoutingDecision, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { RoutingSweep, type RoutingPort } from './routing.sweep.js';
import type { BusinessHours } from './business-hours.js';

const id = (n: number): UUID =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID;

/**
 * A pool that answers the sweep's two reads and nothing else.
 *
 * Deliberately strict: an unrecognised query throws rather than returning an empty result,
 * so a future edit that adds a third read fails loudly here instead of silently reading
 * nothing and making every assertion below pass over an empty batch.
 */
function stubPool(count: number): pg.Pool {
  return {
    query: async (text: string) => {
      if (text.includes('FROM conversation.conversations')) {
        return {
          rows: Array.from({ length: count }, (_, i) => ({
            conversation_id: id(i),
            case_id: null,
            category_id: 'CLAIMS',
            designated_employee_id: null,
          })),
        };
      }
      if (text.includes('FROM conversation.categories')) {
        return { rows: [{ category_id: 'CLAIMS', owning_team_id: 'team-claims' }] };
      }
      throw new Error(`unstubbed query: ${text.slice(0, 60)}`);
    },
  } as unknown as pg.Pool;
}

const hours = {
  stateFor: async () => ({ state: 'OPEN' as const, basis: 'CALENDAR', provisional: false }),
} as unknown as BusinessHours;

const silent = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

/**
 * An orchestrator that places everything except the conversations named in `poison`,
 * which throw the way a rejected ledger INSERT throws — out of `requestRouting`, not as a
 * returned refusal.
 *
 * The distinction is the whole point. A refusal is already handled: the sweep logs it and
 * moves on, and always did. It is the THROW that had no handler, and the two must not be
 * conflated by a stub that returns `err()` instead.
 */
function orchestrator(poison: ReadonlySet<string>): RoutingPort & { placed: string[] } {
  const placed: string[] = [];
  return {
    placed,
    async requestRouting(context): Promise<Result<RoutingDecision>> {
      if (poison.has(context.conversationId)) {
        throw new Error('new row for relation "ledger" violates append-only policy');
      }
      placed.push(context.conversationId);
      return {
        ok: true,
        value: { outcome: 'QUEUED', queueEntryId: id(900) },
      } as Result<RoutingDecision>;
    },
  };
}

describe('a placement that throws', () => {
  it('costs one item, and the rest of the batch is still placed', async () => {
    // Position 3 of 20: far enough in that "the rest" is most of the batch, which is what
    // makes the count below discriminating rather than incidental.
    const poison = new Set([id(3)]);
    const port = orchestrator(poison);

    const result = await new RoutingSweep({
      pool: stubPool(20),
      orchestrator: port,
      businessHours: hours,
      logger: silent(),
    }).run();

    expect(result.examined).toBe(20);
    /**
     * Nineteen, not one and not zero.
     *
     * Before the fix this was 3 — the items ahead of the poison — and `run()` rejected, so
     * the caller saw an exception rather than a result at all. Asserting the exact number
     * rather than `toBeGreaterThan(0)` is deliberate: a fix that caught the throw and then
     * broke out of the loop would satisfy any loose assertion while leaving the defect.
     */
    expect(result.acted).toBe(19);
    expect(result.failed).toBe(1);
    expect(port.placed).not.toContain(id(3));
    // The items AFTER the poison are the ones that were being lost.
    expect(port.placed).toContain(id(4));
    expect(port.placed).toContain(id(19));
  });

  it('does not reject, so the tick completes and the timer keeps running', async () => {
    /**
     * Separate from the count above because it is a separate failure. `sweeps.host.ts`
     * awaits `run()`; a rejection there is an unhandled failure in a timer callback, which
     * is a different and worse outcome than a low `acted`.
     */
    const port = orchestrator(new Set([id(0)]));
    const sweep = new RoutingSweep({
      pool: stubPool(3),
      orchestrator: port,
      businessHours: hours,
      logger: silent(),
    });

    await expect(sweep.run()).resolves.toEqual({ examined: 3, acted: 2, failed: 1 });
  });

  it('reports every failure when they all fail, rather than the first', async () => {
    /**
     * The degenerate case, and a control on `failed` being a counter rather than a flag.
     * It also pins `acted` at zero: a catch that incremented `acted` before rethrowing —
     * or after catching — would report a batch of successful placements that never
     * happened, and the queue would look healthy while nothing moved.
     */
    const all = new Set([id(0), id(1), id(2), id(3), id(4)]);
    const result = await new RoutingSweep({
      pool: stubPool(5),
      orchestrator: orchestrator(all),
      businessHours: hours,
      logger: silent(),
    }).run();

    expect(result).toEqual({ examined: 5, acted: 0, failed: 5 });
  });

  it('logs each failure with the conversation it lost', async () => {
    /**
     * A caught exception with no log is a silent failure, which is the thing this sweep
     * exists to prevent one level up (§21.8). An operator must be able to name the item.
     */
    const logger = silent();
    await new RoutingSweep({
      pool: stubPool(4),
      orchestrator: orchestrator(new Set([id(2)])),
      businessHours: hours,
      logger,
    }).run();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = vi.mocked(logger.error).mock.calls[0]!;
    expect(message).toBe('placement failed');
    expect(fields).toMatchObject({
      operation: 'sweep.routing',
      outcome: 'FAILED',
      detail: { conversationId: id(2) },
    });
  });

  it('places the whole batch when nothing throws', async () => {
    /**
     * The positive control. Without it, every assertion above would pass against a sweep
     * that placed nothing at all — and `acted: 19` would be indistinguishable from a
     * coincidence.
     */
    const port = orchestrator(new Set());
    const result = await new RoutingSweep({
      pool: stubPool(20),
      orchestrator: port,
      businessHours: hours,
      logger: silent(),
    }).run();

    expect(result).toEqual({ examined: 20, acted: 20, failed: 0 });
    expect(port.placed).toHaveLength(20);
  });
});
