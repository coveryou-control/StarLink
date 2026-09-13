import { describe, expect, it } from 'vitest';

import { ceilingFor, triage, type AttachmentLimits } from './attachment-limits';

/**
 * Sorting a batch of chosen files into what goes and what does not.
 *
 * The server is what actually refuses — §28.2 calls a browser-side size check "a courtesy"
 * and the grant is rejected before any bytes move. What is under test here is the SENTENCE:
 * whether somebody who picks eleven files, one of them a 40MB video, is told which files
 * did not go, why, and what to do instead. A refusal that arrives one file at a time from
 * the server cannot say any of that.
 */
const limits: AttachmentLimits = {
  maxPerMessage: 10,
  maxBytes: 10 * 1024 * 1024,
  maxBytesByFamily: { video: 25 * 1024 * 1024 },
};

/** A file of a given size without allocating it — `size` is what triage reads. */
const file = (name: string, bytes: number, type: string): File =>
  ({ name, size: bytes, type }) as File;

const MB = 1024 * 1024;

describe('which ceiling applies', () => {
  it('gives a video its family ceiling and a document the general one', () => {
    expect(ceilingFor(limits, 'video/mp4')).toBe(25 * MB);
    expect(ceilingFor(limits, 'application/pdf')).toBe(10 * MB);
  });

  it('falls back to the general ceiling for a family nobody configured', () => {
    // A type the policy allows but has no row for must not become unbounded. The fallback
    // is the general figure, which is the conservative direction.
    expect(ceilingFor(limits, 'image/png')).toBe(10 * MB);
    expect(ceilingFor(limits, 'nonsense')).toBe(10 * MB);
  });
});

describe('sorting a batch', () => {
  it('accepts what is within both limits and says nothing', () => {
    const result = triage([file('a.pdf', 2 * MB, 'application/pdf')], 0, limits);
    expect(result.accepted).toHaveLength(1);
    expect(result.refusals).toHaveLength(0);
  });

  it('refuses an oversized file by name, with its limit and where to put it instead', () => {
    const result = triage([file('survey.mp4', 40 * MB, 'video/mp4')], 0, limits);
    expect(result.accepted).toHaveLength(0);
    expect(result.refusals).toHaveLength(1);
    // The three things the sentence has to carry: which file, which limit, what to do.
    expect(result.refusals[0]).toContain('survey.mp4');
    expect(result.refusals[0]).toContain('25 MB');
    expect(result.refusals[0]).toContain('Drive');
  });

  it('holds a video to 25 MB and a document to 10 MB in the same batch', () => {
    const result = triage(
      [
        file('clip.mp4', 20 * MB, 'video/mp4'),
        file('scan.pdf', 20 * MB, 'application/pdf'),
      ],
      0,
      limits,
    );
    expect(result.accepted.map((f) => f.name)).toEqual(['clip.mp4']);
    expect(result.refusals[0]).toContain('scan.pdf');
    expect(result.refusals[0]).toContain('10 MB');
  });

  it('counts what is ALREADY staged, not just this batch', () => {
    /**
     * The limit is per MESSAGE. Attaching six and then six more is the same eleven-file
     * message as attaching twelve at once, and counting only the batch would let the second
     * route through — which is the version of this bug that ships, because nobody tests the
     * second gesture.
     */
    const batch = Array.from({ length: 6 }, (_, i) => file(`p${i}.pdf`, MB, 'application/pdf'));
    const result = triage(batch, 6, limits);
    expect(result.accepted).toHaveLength(4);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('10 files');
  });

  it('does not let a file refused for SIZE consume one of the ten slots', () => {
    /**
     * Eleven files, one of them oversized. The oversized one is refused for its size, so
     * ten remain and all ten fit — the person should get ten attachments and one complaint,
     * not nine and two. Slicing to `maxPerMessage` before checking sizes produces the
     * wrong answer here, which is why the order is what it is.
     */
    const batch = [
      file('huge.pdf', 40 * MB, 'application/pdf'),
      ...Array.from({ length: 10 }, (_, i) => file(`ok${i}.pdf`, MB, 'application/pdf')),
    ];
    const result = triage(batch, 0, limits);
    expect(result.accepted).toHaveLength(10);
    expect(result.accepted.map((f) => f.name)).not.toContain('huge.pdf');
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('huge.pdf');
  });

  it('reports the overflow once, not once per file', () => {
    // Twelve lines saying "a message can carry ten files" is not twelve times as useful.
    const batch = Array.from({ length: 13 }, (_, i) => file(`p${i}.pdf`, MB, 'application/pdf'));
    const result = triage(batch, 0, limits);
    expect(result.accepted).toHaveLength(10);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('3 were');
  });

  it('names the single overflowing file rather than counting to one', () => {
    const batch = Array.from({ length: 11 }, (_, i) => file(`p${i}.pdf`, MB, 'application/pdf'));
    const result = triage(batch, 0, limits);
    expect(result.refusals[0]).toContain('p10.pdf');
  });

  it('keeps the order files were picked in', () => {
    // The chips appear in this order and so does the message. A batch that arrives shuffled
    // is a set of photographs that arrives shuffled.
    const batch = ['c', 'a', 'b'].map((n) => file(`${n}.pdf`, MB, 'application/pdf'));
    expect(triage(batch, 0, limits).accepted.map((f) => f.name)).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
  });

  it('refuses everything once the message is already full', () => {
    const result = triage([file('one-more.pdf', MB, 'application/pdf')], 10, limits);
    expect(result.accepted).toHaveLength(0);
    expect(result.refusals[0]).toContain('one-more.pdf');
  });
});
