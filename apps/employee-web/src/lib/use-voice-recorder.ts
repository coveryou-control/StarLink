'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  elapsedMs,
  microphoneProblem,
  pickRecordingMime,
  type RecordingSegment,
} from './voice-recording';

/**
 * The browser half of recording: `getUserMedia`, `MediaRecorder`, and an analyser for the
 * live waveform.
 *
 * Everything with a right answer lives in `voice-recording.ts` and is tested there. What
 * is here is the part that can only be exercised against a real microphone, kept as thin
 * as it can be made.
 *
 * ## The rule this file exists to keep
 *
 * A recording is never silently discarded. Every path that ends recording — stop, cancel,
 * an error mid-flight, the tab being closed — either produces a blob the caller is handed
 * or tells the caller why there is none. Losing four minutes of somebody talking because a
 * promise rejected without a listener is the worst thing this feature can do, and it is
 * the easy thing to let happen.
 */

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/**
 * How many windows to reduce a decoded recording to.
 *
 * Comfortably more than any strip draws, so the review can resample it down without
 * inventing detail, and small enough that the reduction is a few passes over the samples.
 */
const SHAPE_WINDOWS = 240;

/**
 * What a finished recording actually contains: its loudest sample, and its shape.
 *
 * Decoding a few seconds of Opus costs single-digit milliseconds and happens once, at
 * stop — it is not on any hot path. The context is closed immediately: leaving one open
 * per recording is how a long session ends up at the browser's limit and the NEXT
 * recording gets no analyser at all.
 *
 * `undefined` when the audio cannot be read, which is not the same answer as silence.
 */
async function analyse(
  blob: Blob,
  windows: number,
): Promise<{ peak: number; shape: readonly number[] } | undefined> {
  if (typeof AudioContext === 'undefined') return undefined;
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    /* Channel zero alone. A voice note is mono in practice, and where it is not the two
       channels carry the same speech — a second pass would double the work to redraw the
       same line. */
    const samples = decoded.getChannelData(0);
    const per = Math.max(1, Math.floor(samples.length / windows));

    let peak = 0;
    const shape: number[] = [];
    for (let window = 0; window < windows; window += 1) {
      const from = window * per;
      if (from >= samples.length) break;
      const until = Math.min(samples.length, from + per);
      let loudest = 0;
      for (let index = from; index < until; index += 1) {
        const value = Math.abs(samples[index] ?? 0);
        if (value > loudest) loudest = value;
      }
      if (loudest > peak) peak = loudest;
      shape.push(loudest);
    }
    return { peak, shape };
  } catch {
    /* A container this browser records but cannot decode. Nothing can be claimed. */
    return undefined;
  } finally {
    void context.close().catch(() => undefined);
  }
}

export interface Recording {
  readonly blob: Blob;
  /** The type actually recorded, codec parameters and all. */
  readonly recordedAs: string;
  readonly durationMs: number;
  /** Peak levels over the whole recording, for the review waveform. */
  readonly levels: readonly number[];
  /**
   * Nothing audible was captured, though bytes were.
   *
   * A microphone muted in hardware, or the wrong input selected, produces a perfectly
   * valid Opus stream several seconds long that contains silence. It uploads, it sends,
   * it plays — and it plays nothing, which is reported as "it is recording but there is
   * no sound".
   *
   * Decided by DECODING the recording, not by reading the live meter: the meter can fail
   * on its own (a suspended `AudioContext` reports a flat line) and a warning built on it
   * accuses the microphone of the analyser's fault. False when the audio could not be
   * decoded at all — an unknown is not a silence.
   *
   * A flag rather than a refusal: the recording is the person's and might be
   * deliberately quiet. The review warns and still lets them send it.
   */
  readonly silent: boolean;
}

export interface VoiceRecorder {
  readonly phase: RecorderPhase;
  /** Whether this browser can record at all — false keeps the button out of the composer. */
  readonly supported: boolean;
  /** Milliseconds of audio captured so far, pauses excluded. Ticks while recording. */
  readonly elapsed: number;
  /** Recent levels, 0..1, for the live bar strip. */
  readonly levels: readonly number[];
  readonly problem?: string;
  readonly start: () => Promise<void>;
  readonly pause: () => void;
  readonly resume: () => void;
  /** Ends the recording and resolves with it. `undefined` only if nothing was captured. */
  readonly stop: () => Promise<Recording | undefined>;
  /** Ends the recording and throws it away. The only path that is allowed to lose audio. */
  readonly cancel: () => void;
  readonly dismissProblem: () => void;
}

/** How many level readings to keep. Enough for a long note without growing unboundedly. */
const MAX_LEVELS = 4000;

export function useVoiceRecorder(): VoiceRecorder {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [supported, setSupported] = useState(false);

  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const audioRef = useRef<AudioContext | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const segmentsRef = useRef<RecordingSegment[]>([]);
  const levelsRef = useRef<number[]>([]);
  /** Set by `cancel` so the `stop` handler knows to throw the blob away. */
  const discardRef = useRef(false);

  /*
     Feature detection in an effect, not at module scope.

     This is a server-rendered app: `MediaRecorder` does not exist during the render that
     produces the HTML, and reading it there is a hydration mismatch — the server draws a
     composer without a microphone and the client draws one with it.
  */
  useEffect(() => {
    setSupported(
      typeof navigator !== 'undefined' &&
        navigator.mediaDevices !== undefined &&
        typeof MediaRecorder !== 'undefined' &&
        pickRecordingMime() !== undefined,
    );
  }, []);

  /** Everything the browser is holding on our behalf, released. */
  const release = useCallback(() => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;

    /* The microphone indicator stays lit until every track is stopped, whatever the
       recorder is doing. Somebody watching a red dot in their tab bar after they finished
       recording has every reason to think the application is still listening. */
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;

    void audioRef.current?.close().catch(() => {
      /* Already closed, or never opened. Nothing to recover. */
    });
    audioRef.current = undefined;
    recorderRef.current = undefined;
  }, []);

  /* Releasing on unmount is what stops a navigation mid-recording from leaving the
     microphone open for the life of the tab. */
  useEffect(() => release, [release]);

  const start = useCallback(async (): Promise<void> => {
    if (phase !== 'idle') return;
    setProblem(undefined);
    setPhase('starting');

    const mime = pickRecordingMime();
    if (mime === undefined) {
      setProblem('This browser cannot record audio.');
      setPhase('idle');
      return;
    }

    let stream: MediaStream;
    try {
      /*
         The three constraints are the difference between a voice note and a recording of a
         room. Browsers apply them in their own audio pipeline, which is far better than
         anything reasonable to do here, and they are on by default in most — asked for
         explicitly because "most" is not "all".
      */
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (cause) {
      setProblem(microphoneProblem(cause));
      setPhase('idle');
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    segmentsRef.current = [];
    levelsRef.current = [];
    discardRef.current = false;
    setLevels([]);
    setElapsed(0);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      /* A browser that reported the type as supported and then refused to construct with
         it. Rare, and survivable: let it pick its own. */
      recorder = new MediaRecorder(stream);
    }
    recorderRef.current = recorder;

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });

    /*
       A timeslice, so the chunks arrive as we go.

       Without one, `MediaRecorder` holds the entire recording and emits it in a single
       `dataavailable` when it stops — and a recorder that errors partway through has then
       produced nothing at all. With a slice, a twenty-minute note that dies at minute
       nineteen still has nineteen minutes of chunks in hand.
    */
    recorder.start(1000);
    segmentsRef.current = [{ from: Date.now() }];
    setPhase('recording');

    /* The live level, for the bar strip. */
    try {
      const context = new AudioContext();
      audioRef.current = context;
      /*
         Resumed explicitly, because a suspended context reports SILENCE.

         An `AudioContext` constructed outside a user gesture starts suspended, and some
         platforms suspend one even inside a gesture. `getByteTimeDomainData` on a
         suspended context fills the buffer with the 128 midpoint — a flat waveform that
         looks exactly like a muted microphone. Resuming is a promise nobody awaited, and
         a failure here costs the waveform and nothing else.
      */
      void context.resume().catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      const tick = (): void => {
        analyser.getByteTimeDomainData(buffer);
        /* Peak deviation from the 128 midpoint — the loudest sample in this frame rather
           than an RMS, so a consonant registers as a bar rather than being averaged flat. */
        let peak = 0;
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128) / 128);

        const current = levelsRef.current;
        if (current.length < MAX_LEVELS) current.push(peak);
        setLevels([...current]);

        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch {
      /* No analyser is a recording without a waveform, which is a lesser thing and not a
         failure. The recording itself is unaffected, so this must not stop it. */
    }
  }, [phase]);

  /* The timer. A tick rather than a computed value so the label moves while nothing else
     re-renders; `elapsedMs` is what makes it exclude the pauses. */
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setElapsed(elapsedMs(segmentsRef.current, Date.now())), 200);
    return () => clearInterval(id);
  }, [phase]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === undefined || recorder.state !== 'recording') return;
    recorder.pause();
    const open = segmentsRef.current[segmentsRef.current.length - 1];
    if (open !== undefined && open.until === undefined) {
      segmentsRef.current[segmentsRef.current.length - 1] = { from: open.from, until: Date.now() };
    }
    setElapsed(elapsedMs(segmentsRef.current, Date.now()));
    setPhase('paused');
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === undefined || recorder.state !== 'paused') return;
    recorder.resume();
    segmentsRef.current.push({ from: Date.now() });
    setPhase('recording');
  }, []);

  const stop = useCallback(async (): Promise<Recording | undefined> => {
    const recorder = recorderRef.current;
    if (recorder === undefined || recorder.state === 'inactive') return undefined;

    setPhase('stopping');
    const open = segmentsRef.current[segmentsRef.current.length - 1];
    if (open !== undefined && open.until === undefined) {
      segmentsRef.current[segmentsRef.current.length - 1] = { from: open.from, until: Date.now() };
    }
    const durationMs = elapsedMs(segmentsRef.current, Date.now());
    const recordedAs = recorder.mimeType;
    const captured = [...levelsRef.current];

    /*
       Waiting for `stop` rather than reading the chunks immediately.

       The final `dataavailable` fires BEFORE `stop`, and it carries whatever was recorded
       since the last timeslice — up to a second of audio. Assembling the blob without
       waiting silently truncates every recording by the tail the person just finished
       speaking, which is the part they were most deliberate about.
    */
    const blob = await new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        'stop',
        () => resolve(new Blob(chunksRef.current, { type: recordedAs })),
        { once: true },
      );
      recorder.stop();
    });

    release();
    setPhase('idle');
    setElapsed(0);
    setLevels([]);

    /*
       Discarded is silent. EMPTY is not.

       These were one branch, and that is the defect behind "it is not recording
       anything": a recording that produced no bytes returned `undefined` exactly like a
       cancelled one, so `voice-composer.tsx` skipped the review and the bar simply
       vanished. No note, no chip, no message — the person pressed record, spoke, pressed
       stop, and the product returned to how it had been with nothing to say.

       A microphone that is muted in hardware, held by another application, or feeding
       silence through a virtual device all land here, and every one of them is worth a
       sentence.
    */
    if (discardRef.current) return undefined;
    if (blob.size === 0 || durationMs <= 0) {
      setProblem(
        'No audio was captured. Check that the right microphone is selected and not muted, then try again.',
      );
      return undefined;
    }

    /*
       Read from the RECORDED AUDIO, not from the live analyser.

       The first version of this read `captured` — the analyser's per-frame peaks, the
       same numbers that draw the waveform. That inherits the analyser's failures: an
       `AudioContext` that never resumes fills its buffer with the midpoint, which is
       indistinguishable from a muted microphone. So a perfectly good recording was
       reported as silent AND drawn without a waveform, both from the same cause.
       Reported from use, with a screenshot of exactly that.

       Decoding the blob asks the only question that matters — is there sound in the file
       that is about to be sent — and it is independent of whether the meter worked.

       Below the guards, so a cancelled or empty recording is never decoded.
    */
    const measured = await analyse(blob, SHAPE_WINDOWS);

    /* An undecodable blob is NOT a silence. "I could not tell" and "there is no sound"
       are different answers, and only one of them is worth warning somebody about. */
    const silent = measured !== undefined && measured.peak < 0.01;

    /*
       The meter's shape when the meter worked, the recording's shape when it did not.

       The live strip is the better source when it runs: it is what the person watched
       while speaking, pauses and all. But it is also the thing that fails, and a review
       that then shows a flat line — or, as it did until now, no strip at all — reads as a
       broken player rather than as a quiet recording. The decoded shape always exists and
       is always true, so there is always a waveform to show.
    */
    const meterWorked = captured.some((level) => level > 0.01);
    const levels = meterWorked ? captured : (measured?.shape ?? captured);

    return { blob, recordedAs, durationMs, levels, silent };
  }, [release]);

  const cancel = useCallback(() => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder !== undefined && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* Already stopping. The release below is what matters. */
      }
    }
    chunksRef.current = [];
    release();
    setPhase('idle');
    setElapsed(0);
    setLevels([]);
  }, [release]);

  return {
    phase,
    supported,
    elapsed,
    levels,
    ...(problem !== undefined ? { problem } : {}),
    start,
    pause,
    resume,
    stop,
    cancel,
    dismissProblem: () => setProblem(undefined),
  };
}
