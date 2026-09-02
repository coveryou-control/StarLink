import { describe, expect, it } from 'vitest';

import { SequenceTracker, reconnectDelayMs } from './sequence';

const CONVERSATION = 'conv-1';

describe('SequenceTracker (FR-RT-4 gap detection)', () => {
  it('applies the next contiguous event', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 5);

    expect(tracker.classify(CONVERSATION, 6)).toEqual({ kind: 'APPLY' });
  });

  it('discards a duplicate', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 5);

    expect(tracker.classify(CONVERSATION, 5)).toEqual({
      kind: 'DISCARD',
      reason: 'DUPLICATE_OR_REORDER',
    });
  });

  it('discards an event that arrives out of order behind the watermark', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 9);

    expect(tracker.classify(CONVERSATION, 4)).toEqual({
      kind: 'DISCARD',
      reason: 'DUPLICATE_OR_REORDER',
    });
  });

  it('demands a re-fetch of exactly the missing range on a gap', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 5);

    // 6 and 7 never arrived. We must not render 8 on top of 5.
    expect(tracker.classify(CONVERSATION, 8)).toEqual({ kind: 'REFETCH', from: 6, to: 8 });
  });

  it('re-fetches rather than guessing when it has no baseline', () => {
    const tracker = new SequenceTracker();

    // Joining a conversation at seq 43 is not a 42-event gap — it is a cold start, and
    // the client cannot tell the difference. Refusing to guess is the whole point.
    expect(tracker.classify(CONVERSATION, 43)).toEqual({ kind: 'REFETCH', from: 0, to: 43 });
  });

  it('does not advance the watermark until the event is committed', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 5);

    tracker.classify(CONVERSATION, 6);
    // classify() is pure — a render that threw must not leave the client believing it
    // showed an event the user never saw.
    expect(tracker.highWaterMark(CONVERSATION)).toBe(5);

    tracker.commit(CONVERSATION, 6);
    expect(tracker.highWaterMark(CONVERSATION)).toBe(6);
  });

  it('never moves the watermark backwards', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 10);

    tracker.commit(CONVERSATION, 3);

    expect(tracker.highWaterMark(CONVERSATION)).toBe(10);
  });

  it('resolves a gap once the authoritative fetch resets the baseline', () => {
    const tracker = new SequenceTracker();
    tracker.reset(CONVERSATION, 5);

    expect(tracker.classify(CONVERSATION, 8).kind).toBe('REFETCH');
    tracker.reset(CONVERSATION, 8); // the REST fetch returned through 8

    expect(tracker.classify(CONVERSATION, 9)).toEqual({ kind: 'APPLY' });
  });

  it('tracks conversations independently', () => {
    const tracker = new SequenceTracker();
    tracker.reset('a', 5);
    tracker.reset('b', 100);

    expect(tracker.classify('a', 6)).toEqual({ kind: 'APPLY' });
    expect(tracker.classify('b', 101)).toEqual({ kind: 'APPLY' });
    // 'b' being far ahead must not make 'a' look gapped.
    expect(tracker.classify('a', 7)).toEqual({ kind: 'REFETCH', from: 6, to: 7 });
  });
});

describe('reconnectDelayMs (NFR-REL-4 thundering-herd defence)', () => {
  it('grows exponentially in its ceiling', () => {
    const atMax = (attempt: number): number => reconnectDelayMs(attempt, { random: () => 0.999999 });

    expect(atMax(1)).toBeLessThan(500);
    expect(atMax(2)).toBeLessThan(1000);
    expect(atMax(3)).toBeLessThan(2000);
    expect(atMax(2)).toBeGreaterThan(atMax(1));
    expect(atMax(4)).toBeGreaterThan(atMax(3));
  });

  it('caps the ceiling so a long outage does not back off into next week', () => {
    expect(reconnectDelayMs(50, { random: () => 0.999999 })).toBeLessThanOrEqual(30_000);
  });

  it('uses FULL jitter — the spread covers the whole interval, not base ± a wiggle', () => {
    // This is the property that actually disperses a herd. A "base ± 10%" scheme still
    // has every client retrying within a narrow band, which is what kills the
    // replacement instance.
    const attempt = 6;
    expect(reconnectDelayMs(attempt, { random: () => 0 })).toBe(0);
    expect(reconnectDelayMs(attempt, { random: () => 0.5 })).toBeCloseTo(16_000 / 2, -2);
    expect(reconnectDelayMs(attempt, { random: () => 0.999999 })).toBeGreaterThan(15_000);
  });

  it('spreads a herd of 500 sockets across the interval rather than bunching them', () => {
    // 500 employees (the stated scale) all reconnecting after one gateway dies.
    let seed = 12345;
    const lcg = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const delays = Array.from({ length: 500 }, () => reconnectDelayMs(5, { random: lcg }));
    const ceiling = 8000;
    const buckets = new Array(8).fill(0) as number[];
    for (const delay of delays) {
      const index = Math.min(7, Math.floor((delay / ceiling) * 8));
      buckets[index] = (buckets[index] ?? 0) + 1;
    }

    // Every octile occupied, none holding more than a quarter of the herd.
    expect(buckets.every((count) => count > 0)).toBe(true);
    expect(Math.max(...buckets)).toBeLessThan(125);
  });

  it('treats attempt 0 and 1 alike rather than producing a negative exponent', () => {
    expect(reconnectDelayMs(0, { random: () => 0.999999 })).toBeLessThan(500);
    expect(reconnectDelayMs(0)).toBeGreaterThanOrEqual(0);
  });
});
