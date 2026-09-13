import { describe, expect, it } from 'vitest';

import { ceilingFor, DEFAULT_POLICY } from '@starlink/attachments';

import { apiConfigSchema } from '../config.js';
import { refuseVoiceNote, type VoiceNoteLimits } from './voice-note-limits.js';

/**
 * The ceilings, and — as much as anything — the recordings they must NOT refuse.
 *
 * The brief was explicit that there is to be no hard five-minute limit, and a test suite
 * that only checks the refusals would pass just as happily with one. So the cases below
 * lead with the long recordings that have to get through: seven and a half minutes, and
 * twenty-nine of them under a thirty-minute ceiling. Those are the assertions that fail if
 * somebody later "tidies" the configurable limit into a constant.
 */
describe('voice-note ceilings', () => {
  const limits: VoiceNoteLimits = { maxSeconds: 30 * 60, maxBytes: 16 * 1024 * 1024 };
  const audio = (durationMs: number, declaredBytes = 2048) => ({
    declaredMime: 'audio/webm',
    declaredBytes,
    durationMs,
  });

  describe('lets a long recording through', () => {
    it('accepts 7:34, which a five-minute cap would have refused', () => {
      expect(refuseVoiceNote(audio(7 * 60_000 + 34_000), limits)).toBe(undefined);
    });

    it('accepts 29 minutes under a 30-minute ceiling', () => {
      expect(refuseVoiceNote(audio(29 * 60_000), limits)).toBe(undefined);
    });

    it('accepts exactly the ceiling', () => {
      /* The boundary belongs to the caller. A limit advertised as thirty minutes that
         refuses a thirty-minute recording is a twenty-nine-minute limit that lies. */
      expect(refuseVoiceNote(audio(30 * 60_000), limits)).toBe(undefined);
    });
  });

  describe('refuses what is over', () => {
    it('refuses one second past the ceiling, and says what the ceiling is', () => {
      expect(refuseVoiceNote(audio(30 * 60_000 + 1000), limits)).toEqual({
        error: 'voice_note_too_long',
        maxSeconds: 1800,
      });
    });

    it('refuses a file over the byte ceiling even when it is short', () => {
      /* Duration does not bound bytes: a recorder at a higher rate reaches the same
         minutes in more megabytes, so the two limits are not redundant. */
      expect(refuseVoiceNote(audio(30_000, 20 * 1024 * 1024), limits)).toEqual({
        error: 'voice_note_too_large',
        maxBytes: 16777216,
      });
    });

    it('reports the length first when a recording breaks both', () => {
      expect(refuseVoiceNote(audio(60 * 60_000, 99 * 1024 * 1024), limits)?.error).toBe(
        'voice_note_too_long',
      );
    });
  });

  describe('the ceilings belong to the operator, not to the code', () => {
    it('follows a raised limit', () => {
      const generous: VoiceNoteLimits = { maxSeconds: 2 * 60 * 60, maxBytes: 64 * 1024 * 1024 };
      expect(refuseVoiceNote(audio(90 * 60_000, 40 * 1024 * 1024), generous)).toBe(undefined);
    });

    it('follows a lowered one', () => {
      const strict: VoiceNoteLimits = { maxSeconds: 60, maxBytes: 1024 * 1024 };
      expect(refuseVoiceNote(audio(61_000), strict)?.error).toBe('voice_note_too_long');
    });
  });

  describe('what it does not touch', () => {
    it('ignores a document, whatever its size', () => {
      /* A PDF is bounded by the general attachment policy. Running it past a voice-note
         ceiling would be a second size limit on documents that nothing documents. */
      expect(
        refuseVoiceNote(
          { declaredMime: 'application/pdf', declaredBytes: 50 * 1024 * 1024 },
          limits,
        ),
      ).toBe(undefined);
    });

    it('ignores an image with a duration attached to it', () => {
      expect(
        refuseVoiceNote(
          { declaredMime: 'image/png', declaredBytes: 4096, durationMs: 99 * 60_000 },
          limits,
        ),
      ).toBe(undefined);
    });

    it('covers every audio container a browser records, not just webm', () => {
      /* Safari records MP4/AAC. A check written against `audio/webm` would have left the
         ceiling unenforced on every iPhone. */
      for (const mime of ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']) {
        expect(
          refuseVoiceNote({ declaredMime: mime, declaredBytes: 2048, durationMs: 99 * 60_000 }, limits)
            ?.error,
          mime,
        ).toBe('voice_note_too_long');
      }
    });
  });

  describe('a recorder that says nothing', () => {
    it('treats an absent duration as zero, not as unbounded', () => {
      /* The bypass this closes: omit `durationMs` and the length ceiling never applies.
         Silence from the client is not permission. */
      expect(refuseVoiceNote({ declaredMime: 'audio/webm', declaredBytes: 2048 }, limits)).toBe(
        undefined,
      );
      expect(
        refuseVoiceNote(
          { declaredMime: 'audio/webm', declaredBytes: 99 * 1024 * 1024 },
          limits,
        )?.error,
      ).toBe('voice_note_too_large');
    });
  });
});

/**
 * The two ceilings a voice note passes, and the order that keeps them honest.
 *
 * A recording meets `SL_VOICE_NOTE_MAX_BYTES` in the controller — configuration, checked
 * before a grant exists, and allowed to say what it refused (§27.3 makes most refusals
 * uniform; this one is not an authorization decision). It then meets the general attachment
 * policy, whose `audio` family ceiling is the backstop behind it.
 *
 * The failure this prevents is quiet: raise the configured ceiling past the backstop and a
 * long recording passes the check that can explain itself, then fails the one that cannot —
 * the person is told "that file cannot be attached here" about a recording the product
 * invited them to make and accepted the length of.
 */
describe('the configured voice-note ceiling stays under the policy backstop', () => {
  const backstop = ceilingFor(DEFAULT_POLICY.employee, 'audio/webm');

  it('is reachable: the configured default is the one a person meets', () => {
    /* The one field's default, not a whole parsed config: the schema requires a database
       URL and two secrets, and none of them are this question. */
    const configured = apiConfigSchema.shape.SL_VOICE_NOTE_MAX_BYTES.parse(undefined);
    expect(configured).toBeLessThanOrEqual(backstop);
  });

  it('leaves room for the full recording length the product offers', () => {
    /* Opus at the rate browsers record is roughly 6 KB/s, so the thirty minutes
       `SL_VOICE_NOTE_MAX_SECONDS` defaults to is about 11MB. Asserted against the BACKSTOP,
       because that is the ceiling nobody is watching — the configured one announces itself
       in the refusal, and this one does not. */
    const thirtyMinutesOfOpus = 30 * 60 * 6 * 1024;
    expect(backstop).toBeGreaterThan(thirtyMinutesOfOpus);
  });

  it('does not put the document ceiling on a recording', () => {
    // 10MB would refuse a recording of about twenty-seven minutes against a limit the
    // product advertises as thirty.
    expect(backstop).toBeGreaterThan(DEFAULT_POLICY.employee.maxBytes);
  });
});
