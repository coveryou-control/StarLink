/**
 * Slowing down credential guessing on one account (§27.5).
 *
 * ## What was there before
 *
 * Nothing. The only rate limiter in the product guards search. Ten wrong passwords for a
 * real account went through in three seconds during the 2026-09-08 audit — no throttle, no
 * lockout, no growing delay — and the correct password worked immediately afterwards.
 *
 * That is worse than it first looks, because verification is deliberately expensive:
 * scrypt at N=2^16 allocates about 64 MB per attempt. Unlimited attempts are therefore also
 * a memory-amplification vector, where a few hundred concurrent guesses cost the attacker
 * almost nothing and cost this process gigabytes.
 *
 * ## Why FAILURES are counted, not attempts
 *
 * Counting every attempt would throttle a busy morning. A successful sign-in costs one
 * attempt and should cost nothing at all, so the budget is spent only by failures and is
 * returned in full the moment the right password arrives.
 *
 * ## Why the key is the USERNAME and not the address
 *
 * The address is the more obvious key and it is currently the more dangerous one: the API
 * does not set `trust proxy`, so behind a load balancer every request carries the
 * balancer's address and one throttle would be shared by the whole company. An office
 * arriving at nine o'clock would lock itself out.
 *
 * Per-username stops the attack this exists to stop — someone working through a password
 * list against one account — and cannot take out a bystander. Adding the address as a
 * second dimension is worth doing once `trust proxy` is configured, and only then; it is
 * recorded in the audit rather than half-built here.
 *
 * ## Why a lockout is not an oracle
 *
 * The caller gets the same 401 and the same body as any other failure, through the same
 * refusal funnel — so "this account is being guessed at" is not observable from outside,
 * and neither is "this account exists". A username that was never real accrues failures
 * exactly as a real one does.
 */

export interface SignInThrottle {
  /** Has this key spent its failure budget for the current window? */
  blocked(key: string): boolean;
  /** Record one failed attempt. */
  recordFailure(key: string): void;
  /** Give the budget back. Called when the right password arrives. */
  clear(key: string): void;
}

export interface SignInThrottleOptions {
  /** Failures allowed inside the window before the key is refused outright. */
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /**
   * How many distinct keys to track.
   *
   * The keys come from an unauthenticated request body, so without a ceiling a caller can
   * grow this map for as long as they care to type. When it is reached the oldest key is
   * dropped, which costs that key its accumulated failures — acceptable, because filling
   * the map takes far more requests than guessing one password would.
   */
  readonly maxKeys?: number;
}

export function createSignInThrottle(options: SignInThrottleOptions): SignInThrottle {
  /* Insertion-ordered, which is what makes "drop the oldest" a single `keys().next()`. */
  const failures = new Map<string, number[]>();
  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxKeys ?? 10_000;

  const recent = (key: string): number[] => {
    const cutoff = now() - options.windowMs;
    return (failures.get(key) ?? []).filter((at) => at > cutoff);
  };

  return {
    blocked(key: string): boolean {
      const within = recent(key);
      if (within.length === 0) {
        /* Nothing left in the window: forget the key rather than keeping an empty array
           for every username ever mistyped. */
        failures.delete(key);
        return false;
      }
      failures.set(key, within);
      return within.length >= options.maxFailures;
    },

    recordFailure(key: string): void {
      const within = recent(key);
      within.push(now());
      failures.delete(key);
      failures.set(key, within);

      while (failures.size > maxKeys) {
        const oldest = failures.keys().next();
        if (oldest.done === true) break;
        failures.delete(oldest.value);
      }
    },

    clear(key: string): void {
      failures.delete(key);
    },
  };
}
