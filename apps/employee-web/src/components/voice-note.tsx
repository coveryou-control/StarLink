'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type AttachmentView } from '../lib/api-client';
import { formatDuration, toBars } from '../lib/voice-recording';

/**
 * A voice note in the thread: play, scrub, and how long it runs.
 *
 * ## Why the length is on the row before anything is fetched
 *
 * §28.4 issues a download grant only after the full authorization ladder, and every
 * issuance is AUDITED. A bubble that had to fetch the file to learn it was 7:34 long would
 * make a thread of ten voice notes ten audited downloads nobody asked for. `duration_ms`
 * travels with the attachment record for exactly this reason, so the row is complete
 * before a byte moves — and the grant is spent when somebody presses PLAY, which is the
 * moment the audit entry becomes true.
 *
 * That is a stronger position than the one images are in (`attachment-media.tsx` has to
 * fetch on scroll, because a picture cannot be described by a number).
 *
 * ## Why the waveform is not drawn until it is played
 *
 * A waveform is a claim about the audio. There is no amplitude data on the record — the
 * levels the recorder captured belong to the sender's browser and were never uploaded —
 * so drawing a shape before the file is here would mean inventing one, and a made-up
 * waveform is a picture of a recording that does not exist.
 *
 * So: a plain track until play, and the REAL shape once the bytes are in hand and decoded.
 * Decoding is skipped above `MAX_DECODE_BYTES`, where the cost stops being worth it; the
 * track simply stays plain, which is honest about having nothing to show.
 */

/** Bars in the strip. */
const BARS = 38;

/**
 * Above this, the shape is not computed.
 *
 * `decodeAudioData` expands to 32-bit float PCM — a 20-minute Opus note is about 7 MB on
 * the wire and around 230 MB decoded. Drawing a waveform is not worth a quarter of a
 * gigabyte, and the long notes this feature deliberately allows are exactly the ones that
 * would pay it.
 */
const MAX_DECODE_BYTES = 4 * 1024 * 1024;

/** True for an attachment that should render as a voice note rather than a file card. */
export function isVoiceNote(file: AttachmentView): boolean {
  /* Only BOUND is downloadable (§28.1), and only the SNIFFED type may decide rendering —
     deciding from the declared type would let an uploader choose what every recipient's
     browser does with their file. */
  if (file.state !== 'BOUND') return false;
  return file.contentType !== undefined && file.contentType.startsWith('audio/');
}

/**
 * One at a time.
 *
 * Two voice notes playing over each other is not a state anybody asks for, and it is the
 * default: each bubble owns its own `<audio>` and knows nothing about the others. A module
 * -level registry rather than context because it is a property of the PAGE — the thread,
 * a pinned message and a search result can all hold one, and they do not share a provider.
 */
const playing = new Set<HTMLAudioElement>();

function claimPlayback(element: HTMLAudioElement): void {
  for (const other of playing) {
    if (other !== element) other.pause();
  }
  playing.add(element);
}

export function VoiceNote({ file }: { readonly file: AttachmentView }): ReactNode {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [fetching, setFetching] = useState(false);
  const [isPlaying, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [shape, setShape] = useState<readonly number[] | undefined>(undefined);
  const [rate, setRate] = useState(1);

  /*
     The length from the record, and the length the browser reports once it has the file.

     They can disagree: the recorder measures wall-clock between start and stop, the
     decoder measures the samples that actually landed. The browser's is the better number
     once it exists, and until then the record's is the only one — which is the whole point
     of storing it.
  */
  const [measured, setMeasured] = useState<number | undefined>(undefined);
  const total = measured ?? file.durationMs ?? 0;

  /** The grant, requested on the first play and not before. */
  const obtain = useCallback(async (): Promise<string | undefined> => {
    if (url !== undefined) return url;
    setFetching(true);
    try {
      const grant = await api.downloadAttachment(file.attachmentId);
      setUrl(grant.url);
      return grant.url;
    } catch (cause) {
      /* §34.4: say it plainly. A dead play button that does nothing reads as a broken
         application; "temporarily unavailable" reads as something to try again. */
      setProblem(
        cause instanceof ApiError && cause.status === 503
          ? 'Storage is temporarily unavailable. Try again shortly.'
          : 'That voice note is not available to you.',
      );
      return undefined;
    } finally {
      setFetching(false);
    }
  }, [file.attachmentId, url]);

  /* The real shape, once the bytes are here. Deliberately after the fetch, never before. */
  useEffect(() => {
    if (url === undefined || shape !== undefined) return;
    let live = true;

    void (async () => {
      try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_DECODE_BYTES) return;

        const context = new AudioContext();
        const decoded = await context.decodeAudioData(buffer);
        void context.close().catch(() => undefined);
        if (!live) return;

        /* Peak per window, from the first channel. A mean converges on the noise floor and
           flattens a long recording into a grey band. */
        const samples = decoded.getChannelData(0);
        const window = Math.max(1, Math.floor(samples.length / (BARS * 4)));
        const peaks: number[] = [];
        for (let i = 0; i + window <= samples.length; i += window) {
          let peak = 0;
          for (let j = i; j < i + window; j++) peak = Math.max(peak, Math.abs(samples[j] ?? 0));
          peaks.push(peak);
        }
        /* Normalised, so a quietly recorded note is still legible as a shape rather than a
           flat line — the strip says WHERE the speech is, not how loud the room was. */
        const loudest = Math.max(...peaks, 0.01);
        setShape(toBars(peaks.map((p) => p / loudest), BARS));
      } catch {
        /* An undecodable container is a waveform we do not draw. The audio still plays —
           the browser's decoder and `AudioContext`'s do not always agree — so this must
           not become an error the person sees. */
      }
    })();

    return () => {
      live = false;
    };
  }, [url, shape]);

  /* Leaving the registry on unmount, so a thread that scrolls a playing note out of the
     DOM does not leave a dead reference pausing nothing. */
  useEffect(() => {
    const element = audioRef.current;
    return () => {
      if (element !== null) playing.delete(element);
    };
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    const source = await obtain();
    if (source === undefined) return;

    const element = audioRef.current;
    if (element === null) return;

    if (element.paused) {
      /*
         The source is assigned HERE, and NOWHERE ELSE.
 
         Two bugs live at this line and they are opposites.
 
         Leaving it to React means the first press finds an element with no source:
         `obtain()` sets state, state reaches the DOM on the next render, and `play()` was
         called on silence. The button did nothing once and worked the second time.
 
         Doing BOTH — assigning here and passing `src={url}` in the JSX — is worse, because
         it looks fixed. React's render sets the attribute a moment after this assignment,
         and setting `src` is a new LOAD REQUEST, which aborts the play already in flight.
         The promise rejects with `AbortError`, the catch below reports "could not be
         played in this browser", and the file is perfectly playable: measured on the
         element afterwards, `readyState` was 4 and a direct `play()` ran fine.
 
         So the element is uncontrolled with respect to its source. React never touches it.
      */
      if (element.src !== source) element.src = source;
      claimPlayback(element);
      try {
        await element.play();
      } catch {
        /* A rejected `play()` is an autoplay policy or a source the browser will not
           decode. Either way the button must not be left showing "pause" over silence. */
        setPlaying(false);
        setProblem('This recording could not be played in this browser.');
      }
    } else {
      element.pause();
    }
  }, [obtain]);

  const progress = total > 0 ? Math.min(1, position / total) : 0;

  /**
   * Move to a point in the recording.
   *
   * The length comes from the RECORD, never from `element.duration` — that is `Infinity`
   * on every WebM `MediaRecorder` produces, because the recorder streams and never goes
   * back to write a duration into the header. An earlier version guarded on
   * `Number.isFinite(element.duration)` and so refused every seek on every voice note the
   * product creates; the audio was seekable the whole time (`currentTime = 3` measured as
   * landing on 3.00) and the guard was the only thing stopping it.
   *
   * This is the third thing `duration_ms` is for, after the label and the ceiling.
   */
  const seekSeconds = useCallback(
    (seconds: number): void => {
      const element = audioRef.current;
      if (element === null) return;
      /*
         Clamped twice, and the second one is the one that was missing.
 
         Short of the end, because seeking exactly to it fires `ended` — dragging to the
         right edge would stop the recording rather than move to its last moment.
 
         And short of what has actually ARRIVED. A WebM with no duration in its header has
         no seek index either, so asking Chrome for a position past the buffered range does
         not wait for the bytes: it gives up and returns to zero. Pressing End on a note
         still downloading therefore sent it back to the beginning, which is the opposite
         of what End means. `buffered` is the honest ceiling until the whole file is here.
      */
      const byRecord = total > 0 ? total / 1000 - 0.05 : Number.POSITIVE_INFINITY;
      const buffered = element.buffered;
      const byBytes =
        buffered.length > 0
          ? buffered.end(buffered.length - 1) - 0.1
          : Number.POSITIVE_INFINITY;

      const to = Math.max(0, Math.min(seconds, byRecord, byBytes));
      element.currentTime = to;
      /* The element's own `timeupdate` will follow, but not for up to 250ms — and a strip
         that does not move under the press reads as a control that did not work. */
      setPosition(to * 1000);
    },
    [total],
  );

  return (
    <div className="voice-note" data-playing={isPlaying ? 'true' : undefined}>
      <button
        type="button"
        className="voice-note-play"
        onClick={() => void toggle()}
        disabled={fetching}
        aria-label={isPlaying ? `Pause ${file.filename}` : `Play ${file.filename}`}
      >
        {fetching ? <Spinner /> : isPlaying ? <Pause /> : <Play />}
      </button>

      {/*
        A slider, not a decorated div. Scrubbing a voice note with the keyboard is the
        difference between a control and a picture of one, and `role="slider"` with arrow
        keys is what a screen reader announces as seekable.
      */}
      <div
        className="voice-note-track"
        role="slider"
        tabIndex={0}
        aria-label={`Seek within ${file.filename}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(total / 1000)}
        aria-valuenow={Math.round(position / 1000)}
        aria-valuetext={`${formatDuration(position)} of ${formatDuration(total)}`}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
          seekSeconds(fraction * (total / 1000));
        }}
        onKeyDown={(event) => {
          /* Five seconds by arrow, the whole thing by Home/End. `preventDefault` only for
             keys actually handled — swallowing Tab here would trap focus on the strip. */
          const element = audioRef.current;
          if (element === null) return;
          const at = element.currentTime;
          const to =
            event.key === 'ArrowLeft'
              ? at - 5
              : event.key === 'ArrowRight'
                ? at + 5
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? total / 1000
                    : undefined;
          if (to === undefined) return;
          event.preventDefault();
          seekSeconds(to);
        }}
      >
        {shape === undefined ? (
          /* Nothing is known about the audio yet, so nothing is claimed about it: a plain
             track that fills as it plays. */
          <span className="voice-note-plain" style={{ ['--played' as string]: `${progress * 100}%` }} />
        ) : (
          <span className="voice-note-wave" aria-hidden="true">
            {shape.map((level, index) => (
              <span
                key={index}
                className={index / BARS <= progress ? 'voice-bar-on' : undefined}
                style={{ height: `${Math.max(14, Math.min(100, level * 100))}%` }}
              />
            ))}
          </span>
        )}
      </div>

      {/* Counts UP while playing and shows the total at rest — the two facts somebody
          wants at those two moments, rather than one of them at both. */}
      <span className="voice-note-time">
        {formatDuration(isPlaying || position > 0 ? position : total)}
      </span>

      {/*
        Speed, because a voice note is somebody talking and not everybody wants it at
        their pace. Cycles rather than opening a menu: three values, and a menu for three
        values is a menu for the sake of having one.
      */}
      <button
        type="button"
        className="voice-note-rate"
        onClick={() => {
          const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
          setRate(next);
          if (audioRef.current !== null) audioRef.current.playbackRate = next;
        }}
        aria-label={`Playback speed ${rate}×. Press to change.`}
      >
        {rate}×
      </button>

      {/*
        Always rendered, and with no `src` of its own.

        Always, because a conditional `<audio>` is a ref that is null exactly when the
        first press needs it. Without a `src`, because `toggle` assigns it — see there for
        why having both is worse than having neither.

        This costs nothing while it has no source: `preload="metadata"` fetches nothing
        until one is set, so the lazy grant (§28.4) is unaffected. No source exists until
        somebody presses play, which is the whole point of the grant being lazy.
      */}
      <audio
          ref={audioRef}
          preload="metadata"
          onPlay={(event) => {
            claimPlayback(event.currentTarget);
            setPlaying(true);
          }}
          onPause={(event) => {
            playing.delete(event.currentTarget);
            setPlaying(false);
          }}
          onEnded={(event) => {
            playing.delete(event.currentTarget);
            setPlaying(false);
            setPosition(0);
          }}
          onLoadedMetadata={(event) => {
            /*
               A WebM without a duration in its header reports `Infinity` — a known quirk
               of `MediaRecorder` output, which streams and never goes back to write the
               length. `duration_ms` from the record is what covers it, which is the
               second reason that column exists.
            */
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) setMeasured(seconds * 1000);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
      />

      {problem !== undefined ? (
        <p className="voice-note-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/* ---- glyphs ------------------------------------------------------------------------- */

function Play(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" />
    </svg>
  );
}

function Pause(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M9 5v14M15 5v14"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

function Spinner(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth={2} opacity={0.25} />
      <path
        d="M20 12a8 8 0 0 0-8-8"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
