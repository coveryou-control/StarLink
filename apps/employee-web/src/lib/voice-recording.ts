'use client';

/**
 * The parts of recording a voice note that are decisions rather than plumbing.
 *
 * `MediaRecorder` cannot be exercised in a unit test — there is no microphone and no
 * implementation in jsdom — so everything that could be got wrong lives here as ordinary
 * functions, and the hook in `use-voice-recorder.ts` is left holding only the browser
 * calls. What is here is what has a right answer: which container to ask for, how long the
 * recording has actually been running once somebody has paused twice, and how to say that
 * in a label.
 */

/**
 * Containers, in the order we would like them.
 *
 * Opus first because it is what makes a long voice note viable at all: around 6 KB/s, so
 * twenty minutes is roughly 7 MB. Then bare WebM, then MP4 — which is not a preference but
 * Safari, whose `MediaRecorder` supports nothing else. Ogg last for older Firefox.
 *
 * Every entry here is a type the server accepts (`packages/attachments/policy.ts`) and the
 * scanner can sniff (`dev-scanner.ts`). Adding one without adding it there produces a
 * recording that uploads, fails its scan, and never reaches the thread.
 */
const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const;

/**
 * The best container this browser will actually record.
 *
 * `undefined` means it will record none of them, which is a real outcome and not an error
 * to throw past: the caller uses it to keep the microphone button out of the composer
 * rather than to offer a control that fails when pressed.
 */
export function pickRecordingMime(
  isSupported: (mime: string) => boolean = (mime) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
): string | undefined {
  return CANDIDATES.find((candidate) => isSupported(candidate));
}

/**
 * The MIME to DECLARE for a recording made in `recordedAs`.
 *
 * `MediaRecorder` hands back a type with codec parameters attached
 * (`audio/webm;codecs=opus`), and the attachment policy matches on the bare type. Sending
 * the parameterised string is a grant refused for a file that is perfectly acceptable —
 * the sort of mismatch that only shows up on the one browser that formats it differently.
 */
export function declaredMimeFor(recordedAs: string): string {
  return (recordedAs.split(';')[0] ?? recordedAs).trim().toLowerCase();
}

/** The file extension that goes with a container, for a name a person will read. */
export function extensionFor(recordedAs: string): string {
  const bare = declaredMimeFor(recordedAs);
  if (bare === 'audio/mp4') return 'm4a';
  if (bare === 'audio/mpeg') return 'mp3';
  if (bare === 'audio/ogg') return 'ogg';
  return 'webm';
}

/**
 * A run of recording. `until` is absent while it is the one in progress.
 *
 * Modelled as segments rather than as a single start time because pause exists. Elapsed
 * time computed as `now - start` counts the pauses, so a recording paused for a minute
 * would claim to be a minute longer than the audio it produced — and that number goes into
 * `duration_ms`, gets rendered beside a play button, and is checked against the ceiling.
 */
export interface RecordingSegment {
  readonly from: number;
  readonly until?: number;
}

/** Milliseconds of audio actually captured, pauses excluded. */
export function elapsedMs(segments: readonly RecordingSegment[], now: number): number {
  return segments.reduce((total, segment) => total + ((segment.until ?? now) - segment.from), 0);
}

/**
 * `m:ss`, and `h:mm:ss` once there is an hour to show.
 *
 * Always at least one minute digit, so the timer does not jump from "9" to "0:10" as it
 * passes ten seconds — a label whose width changes while you watch it reads as a glitch.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A name for a recording, built from when it was made.
 *
 * Voice notes have no filename of their own, and "recording.webm" repeated down a thread
 * tells nobody which is which — the same problem `nameForPastedImage` solves for
 * screenshots, and solved the same way.
 */
export function nameForRecording(recordedAs: string, at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    ` ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `Voice note ${stamp}.${extensionFor(recordedAs)}`;
}

/**
 * Amplitudes reduced to the number of bars a waveform has room for.
 *
 * A recording produces a level reading every animation frame — thousands of them for a
 * long note — and the bar strip shows a few dozen. Bucketing by PEAK rather than by mean
 * on purpose: an average over a long bucket converges on the room tone and the waveform
 * flattens into a grey band as the recording goes on, which is exactly when it should
 * still be showing that somebody is talking.
 */
export function toBars(levels: readonly number[], bars: number): number[] {
  if (bars <= 0) return [];
  if (levels.length === 0) return [];
  if (levels.length <= bars) return [...levels];

  const size = levels.length / bars;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor(i * size);
    const until = Math.max(from + 1, Math.floor((i + 1) * size));
    let peak = 0;
    for (let j = from; j < until && j < levels.length; j++) peak = Math.max(peak, levels[j] ?? 0);
    out.push(peak);
  }
  return out;
}

/**
 * What to tell somebody when `getUserMedia` says no.
 *
 * The distinction that matters is the first one: a browser reports a permission the person
 * denied and a permission an administrator denied with the same error name, but "allow it
 * in the address bar" is useless advice if the block is a system setting. Both are covered
 * in one sentence rather than guessed between.
 */
export function microphoneProblem(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'StarLink cannot use the microphone. Allow it for this site in your browser, and check your system privacy settings if it stays blocked.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The microphone is in use by another application.';
  }
  return 'The microphone could not be started.';
}
