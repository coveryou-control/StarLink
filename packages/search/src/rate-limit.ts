/**
 * In-process rate limiting for search (§27.5).
 *
 * Doc §14.2 sanctions in-process counters for V1 — "rate-limit counters fit in
 * process" — with the explicit trigger that they must move to a shared store the
 * moment a second instance exists. This is that V1 implementation, and it is written
 * so the move is a swap rather than a rewrite: the interface is `allowRequest`, which
 * a Redis-backed limiter satisfies identically.
 *
 * Search is limited specifically because it is the natural bulk-extraction surface
 * (§27.5) — cheap for the caller, expensive for us, and the fastest way to pull a
 * corpus through a legitimate interface.
 */
import type { UUID } from '@starlink/shared-contracts';

export interface RateLimitOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export interface RateLimiter {
  allow(key: UUID): boolean;
  reset(key?: UUID): void;
}

/**
 * Sliding window over recent timestamps.
 *
 * A fixed window would let a caller take double the allowance across a boundary; for a
 * limit whose purpose is to slow bulk extraction, that is exactly the gap worth closing.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const hits = new Map<UUID, number[]>();
  const now = options.now ?? (() => Date.now());

  return {
    allow(key: UUID): boolean {
      const at = now();
      const cutoff = at - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= options.maxRequests) {
        // Keep the pruned list so a caller who keeps hammering does not also grow
        // memory without bound.
        hits.set(key, recent);
        return false;
      }

      recent.push(at);
      hits.set(key, recent);
      return true;
    },

    reset(key?: UUID): void {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
