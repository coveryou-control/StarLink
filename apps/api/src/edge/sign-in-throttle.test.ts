import { describe, expect, it } from 'vitest';

import { createSignInThrottle } from './sign-in-throttle.js';

/**
 * The control that did not exist until 2026-09-09.
 *
 * Ten wrong passwords for a real account went through in three seconds during the audit,
 * with no throttle and no lockout, and the correct password worked immediately afterwards.
 * These cases pin the behaviour that replaced that, including the two properties it would
 * be easy to lose in a refactor: a success returns the whole budget, and one account's
 * failures never touch another's.
 */
describe('sign-in failure throttle', () => {
  /** A clock the test drives, so nothing here waits on wall time. */
  const at = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
  };

  it('allows attempts up to the budget and refuses the one after', () => {
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 3, windowMs: 60_000, now: clock.now });

    for (let i = 0; i < 3; i++) {
      expect(throttle.blocked('archit'), `attempt ${i + 1} must be allowed`).toBe(false);
      throttle.recordFailure('archit');
    }
    expect(throttle.blocked('archit')).toBe(true);
  });

  it('a success returns the whole budget', () => {
    /* Somebody who mistypes twice and then gets it right must not carry those two into
       tomorrow — otherwise a normal week of typos eventually locks a real person out. */
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 3, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('archit');
    throttle.recordFailure('archit');
    throttle.clear('archit');

    for (let i = 0; i < 3; i++) {
      expect(throttle.blocked('archit')).toBe(false);
      throttle.recordFailure('archit');
    }
    expect(throttle.blocked('archit')).toBe(true);
  });

  it('the window rolls, so a lockout heals itself', () => {
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('archit');
    throttle.recordFailure('archit');
    expect(throttle.blocked('archit')).toBe(true);

    clock.advance(59_000);
    expect(throttle.blocked('archit'), 'still inside the window').toBe(true);

    clock.advance(2_000);
    expect(throttle.blocked('archit'), 'window has rolled past both failures').toBe(false);
  });

  it('it is a sliding window, not a fixed one', () => {
    /* A fixed window lets a caller spend the whole budget at the end of one bucket and the
       whole budget again at the start of the next. */
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('archit');
    clock.advance(50_000);
    throttle.recordFailure('archit');
    expect(throttle.blocked('archit')).toBe(true);

    /* The first failure ages out; the second has not. One slot back, not two. */
    clock.advance(11_000);
    expect(throttle.blocked('archit')).toBe(false);
    throttle.recordFailure('archit');
    expect(throttle.blocked('archit')).toBe(true);
  });

  it('one account cannot lock out another', () => {
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    throttle.recordFailure('archit');
    throttle.recordFailure('archit');

    expect(throttle.blocked('archit')).toBe(true);
    expect(throttle.blocked('rahul')).toBe(false);
  });

  it('an unknown username accrues failures exactly as a real one does', () => {
    /* The throttle must not become the enumeration oracle that §27.1 keeps the response and
       the timing from being. It never sees whether the account exists, and this pins that
       the caller cannot tell from how many attempts it takes to be refused. */
    const clock = at();
    const throttle = createSignInThrottle({ maxFailures: 2, windowMs: 60_000, now: clock.now });

    for (const who of ['archit', 'no-such-person']) {
      throttle.recordFailure(who);
      expect(throttle.blocked(who)).toBe(false);
      throttle.recordFailure(who);
      expect(throttle.blocked(who)).toBe(true);
    }
  });

  it('bounds how many keys it will remember', () => {
    /* The key comes from an unauthenticated request body, so without a ceiling a caller
       grows this map for as long as they care to type. */
    const clock = at();
    const throttle = createSignInThrottle({
      maxFailures: 1,
      windowMs: 60_000,
      now: clock.now,
      maxKeys: 3,
    });

    for (const who of ['a', 'b', 'c', 'd']) throttle.recordFailure(who);

    expect(throttle.blocked('d'), 'the newest key is kept').toBe(true);
    expect(throttle.blocked('a'), 'the oldest key was evicted').toBe(false);
  });
});
