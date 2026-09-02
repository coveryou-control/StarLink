/**
 * The second tick, and everything it must refuse to claim.
 *
 * The interesting assertions here are all about NOT ticking: over-claiming is the only
 * failure mode that lies to somebody, and every ambiguous case has to resolve downward.
 */
import { describe, expect, it } from 'vitest';
import type { UUID } from './primitives.js';

import { deliveryTick, readWatermark } from './read-receipts.js';

const ME = '018f2c5a-7000-7000-8000-00000000000a' as UUID;
const THEM = '018f2c5a-7000-7000-8000-00000000000b' as UUID;
const THIRD = '018f2c5a-7000-7000-8000-00000000000c' as UUID;

describe('readWatermark', () => {
  it('is the lowest position among everybody else', () => {
    expect(
      readWatermark(
        [
          { principalId: ME, lastReadSeq: 99 },
          { principalId: THEM, lastReadSeq: 12 },
          { principalId: THIRD, lastReadSeq: 7 },
        ],
        ME,
      ),
    ).toBe(7);
  });

  it('ignores the caller, however far ahead they are', () => {
    /**
     * Marking a thread read writes a row for the READER too. Counting it would let a
     * person tick their own messages by scrolling, which is the one reading that says
     * nothing about whether anybody else saw them.
     */
    expect(readWatermark([{ principalId: ME, lastReadSeq: 500 }], ME)).toBe(0);
  });

  it('is zero when somebody has never opened the thread', () => {
    // No row reads as zero, and one person at zero holds the whole conversation at one
    // tick. That is the point: "everybody" means everybody.
    expect(
      readWatermark(
        [
          { principalId: THEM, lastReadSeq: 40 },
          { principalId: THIRD, lastReadSeq: 0 },
        ],
        ME,
      ),
    ).toBe(0);
  });

  it('is zero when there is nobody else', () => {
    // A conversation with one person in it can never reach two ticks, because there is
    // nobody whose reading could be reported.
    expect(readWatermark([{ principalId: ME, lastReadSeq: 9 }], ME)).toBe(0);
    expect(readWatermark([], ME)).toBe(0);
  });

  it('treats a negative stored position as zero rather than propagating it', () => {
    // Defensive: the column is a bigint with a zero default and nothing writes below it,
    // but a MIN that could go negative would tick nothing forever and look like a dead
    // feature rather than a bad row.
    expect(readWatermark([{ principalId: THEM, lastReadSeq: -3 }], ME)).toBe(0);
  });
});

describe('deliveryTick', () => {
  it('marks a message read once the watermark reaches its sequence', () => {
    expect(deliveryTick({ isMine: true, seq: 12, readWatermark: 12 })).toBe('READ');
    expect(deliveryTick({ isMine: true, seq: 11, readWatermark: 12 })).toBe('READ');
  });

  it('marks a message sent while the watermark is behind it', () => {
    expect(deliveryTick({ isMine: true, seq: 13, readWatermark: 12 })).toBe('SENT');
  });

  it('never ticks somebody else’s message', () => {
    /**
     * Not merely redundant — on a group it would leak, one message at a time, how closely
     * each colleague is following the thread. The watermark is per-conversation, so this
     * is the only thing standing between the data and that disclosure.
     */
    expect(deliveryTick({ isMine: false, seq: 1, readWatermark: 999 })).toBe('NONE');
  });

  it('never ticks a message the server has not sequenced', () => {
    // The optimistic row the composer appends has no sequence. It is pending, not sent,
    // and the composer draws that state itself.
    expect(deliveryTick({ isMine: true, seq: 0, readWatermark: 999 })).toBe('NONE');
    expect(deliveryTick({ isMine: true, seq: Number.NaN, readWatermark: 999 })).toBe('NONE');
  });
});
