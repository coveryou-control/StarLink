import { describe, expect, it } from 'vitest';

import {
  declaredMimeFor,
  elapsedMs,
  extensionFor,
  formatDuration,
  microphoneProblem,
  nameForRecording,
  pickRecordingMime,
  toBars,
} from './voice-recording';

describe('choosing a container', () => {
  it('prefers Opus, which is what makes a long note viable', () => {
    /* Around 6 KB/s: twenty minutes is roughly 7 MB. Picking bare WebM when Opus is on
       offer costs nothing visible and multiplies the size of every recording. */
    expect(pickRecordingMime(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to MP4 on Safari, which records nothing else', () => {
    expect(pickRecordingMime((mime) => mime === 'audio/mp4')).toBe('audio/mp4');
  });

  it('returns undefined when the browser records none of them', () => {
    /* Not an error to throw past. The caller uses this to keep the microphone button out
       of the composer, rather than to offer a control that fails when pressed. */
    expect(pickRecordingMime(() => false)).toBe(undefined);
  });
});

describe('what gets declared to the server', () => {
  it('strips the codec parameters the policy does not match on', () => {
    /* `MediaRecorder` reports `audio/webm;codecs=opus`; the attachment policy allows
       `audio/webm`. Declaring the parameterised string is a refused grant for a file that
       is perfectly acceptable. */
    expect(declaredMimeFor('audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('leaves a bare type alone', () => {
    expect(declaredMimeFor('audio/mp4')).toBe('audio/mp4');
  });

  it('every container we would record declares a type the server allows', () => {
    /* The list the server accepts, from `packages/attachments/src/policy.ts`. A candidate
       added to the recorder without being added there records fine, uploads fine, and is
       refused at the grant. */
    const allowed = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']);
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const mime of candidates) {
      expect(allowed.has(declaredMimeFor(mime)), mime).toBe(true);
    }
  });

  it('names the file with the extension that matches its container', () => {
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('audio/ogg;codecs=opus')).toBe('ogg');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
  });
});

describe('how long the recording actually is', () => {
  it('counts a single unfinished run up to now', () => {
    expect(elapsedMs([{ from: 1000 }], 4000)).toBe(3000);
  });

  it('does NOT count the time spent paused', () => {
    /*
       The defect this is really about. Elapsed as `now - start` counts the pauses, so a
       note paused for a minute claims a minute of audio it does not have — and that number
       is what goes into `duration_ms`, what a bubble renders beside the play button, and
       what gets checked against the ceiling.

       Recorded 0-2s, paused until 10s, recording again from 10s to now (13s). Eight
       seconds of silence in the middle are not part of the recording: five, not thirteen.
    */
    expect(elapsedMs([{ from: 0, until: 2000 }, { from: 10_000 }], 13_000)).toBe(5000);
  });

  it('adds up several pauses', () => {
    const segments = [
      { from: 0, until: 1000 },
      { from: 5000, until: 6500 },
      { from: 9000, until: 9250 },
    ];
    expect(elapsedMs(segments, 20_000)).toBe(2750);
  });

  it('is zero before anything has been recorded', () => {
    expect(elapsedMs([], 5000)).toBe(0);
  });
});

describe('the label on the timer', () => {
  it('always shows a minute digit, so the width does not jump at ten seconds', () => {
    /* A label that goes "9" then "0:10" reads as a glitch in something that is being
       watched the whole time it runs. */
    expect(formatDuration(9000)).toBe('0:09');
    expect(formatDuration(10_000)).toBe('0:10');
  });

  it('reads minutes and seconds', () => {
    expect(formatDuration(7 * 60_000 + 34_000)).toBe('7:34');
  });

  it('grows an hours field rather than showing 90 minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1:30:00');
  });

  it('floors rather than rounds, so a note never claims a second it does not have', () => {
    expect(formatDuration(1999)).toBe('0:01');
  });

  it('shows zero rather than a negative for a nonsense value', () => {
    expect(formatDuration(-5000)).toBe('0:00');
  });
});

describe('naming a recording', () => {
  it('stamps it, because a thread of identical names tells nobody which is which', () => {
    const at = new Date(2026, 8, 9, 14, 5, 3);
    expect(nameForRecording('audio/webm;codecs=opus', at)).toBe(
      'Voice note 2026-09-09 140503.webm',
    );
  });

  it('uses the container it was actually recorded in', () => {
    const at = new Date(2026, 8, 9, 14, 5, 3);
    expect(nameForRecording('audio/mp4', at)).toBe('Voice note 2026-09-09 140503.m4a');
  });
});

describe('reducing levels to bars', () => {
  it('keeps the peak of each bucket, not the mean', () => {
    /*
       An average over a long bucket converges on the room tone, and the waveform flattens
       into a grey band as the recording goes on — exactly when it should still be showing
       that somebody is talking.
    */
    expect(toBars([0, 1, 0, 0, 0, 0.5], 2)).toEqual([1, 0.5]);
  });

  it('returns what it was given when there is less than one reading per bar', () => {
    expect(toBars([0.2, 0.4], 8)).toEqual([0.2, 0.4]);
  });

  it('produces exactly the number of bars asked for', () => {
    const levels = Array.from({ length: 977 }, (_, i) => i / 977);
    expect(toBars(levels, 40)).toHaveLength(40);
  });

  it('never loses the last reading to a rounding gap', () => {
    /* Bucket boundaries computed with floats leave the tail unread if the final bucket
       stops short, and the waveform then freezes a moment before the recording does. */
    const levels = [...Array.from({ length: 20 }, () => 0.1), 1];
    expect(Math.max(...toBars(levels, 7))).toBe(1);
  });

  it('handles the empty and degenerate cases without throwing', () => {
    expect(toBars([], 30)).toEqual([]);
    expect(toBars([0.5], 0)).toEqual([]);
  });
});

describe('what to say when the microphone will not start', () => {
  it('covers both a denied prompt and a system-level block in one sentence', () => {
    /* A browser reports these with the same error name, and telling somebody to allow it
       in the address bar is useless advice if the block is a system privacy setting. */
    const said = microphoneProblem({ name: 'NotAllowedError' });
    expect(said).toMatch(/browser/i);
    expect(said).toMatch(/system/i);
  });

  it('says there is no microphone rather than blaming permission', () => {
    expect(microphoneProblem({ name: 'NotFoundError' })).toMatch(/no microphone/i);
  });

  it('says another application has it', () => {
    expect(microphoneProblem({ name: 'NotReadableError' })).toMatch(/another application/i);
  });

  it('still says something for an error it has never seen', () => {
    expect(microphoneProblem(new Error('boom'))).toMatch(/could not be started/i);
    expect(microphoneProblem(undefined)).toMatch(/could not be started/i);
  });
});
