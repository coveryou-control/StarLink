'use client';

import { useEffect, useRef, useState } from 'react';

import { useVoiceRecorder, type Recording } from '../lib/use-voice-recorder';
import { formatDuration, toBars } from '../lib/voice-recording';

/**
 * The microphone, the recording state, and the review that comes before sending.
 *
 * ## Where this sits
 *
 * It replaces the composer's field row while a recording is in progress and hands the
 * finished audio back through `onRecorded`. It does NOT upload and it does not send: the
 * composer already owns both, through the same `uploadAttachment` a dropped file goes
 * through, and a voice note that took its own route to the server would be a second
 * attachment pipeline with its own bugs about scanning and binding.
 *
 * ## The rule
 *
 * A recording is never lost without being asked about. Stop puts it in REVIEW, where the
 * only ways out are send and delete, and delete says what it is deleting. The confirm on
 * delete is not ceremony — the button sits where "stop" was a moment ago, and the audio
 * behind it cannot be recovered.
 */

/** How many bars the strip draws. Enough to read as a waveform, few enough to stay crisp. */
const BARS = 44;

interface Props {
  readonly disabled: boolean;
  /**
   * Called with the finished recording. The composer stages and uploads it.
   *
   * Resolves FALSE when the upload did not get there. The review stays open on a false,
   * because the blob in it is the only copy of the audio that exists — closing it would
   * lose a recording to a dropped connection, which is the one thing this component is
   * built not to do.
   */
  readonly onRecorded: (recording: Recording) => Promise<boolean>;
  /** True while the composer is busy, so the review's Send cannot be pressed twice. */
  readonly sending: boolean;
  /**
   * Whether the bar has taken the row over.
   *
   * The composer needs this to STOP RENDERING the field, the paperclip and the send button
   * while a recording is running — not to hide them. A field that is still in the document
   * is still in the tab order and still holds the caret, so somebody recording could tab
   * into a textarea they cannot see and type into it.
   */
  readonly onActiveChange: (active: boolean) => void;
}

export function VoiceComposer({
  disabled,
  onRecorded,
  sending,
  onActiveChange,
}: Props): React.ReactNode {
  const recorder = useVoiceRecorder();
  const [review, setReview] = useState<Recording | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Set when an upload failed. The recording is still in `review`; this says why. */
  const [sendFailed, setSendFailed] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);

  const active =
    review !== undefined ||
    recorder.phase === 'recording' ||
    recorder.phase === 'paused' ||
    recorder.phase === 'stopping';

  /* In an effect, not during render: telling a parent to re-render while this one is
     rendering is the "cannot update a component while rendering another" warning, and the
     parent's state would be one render behind besides. */
  useEffect(() => onActiveChange(active), [active, onActiveChange]);

  /* Read in an effect for the same reason the support check is: `isSecureContext` does
     not exist during the server render, and reading it there is a hydration mismatch. */
  const [insecure, setInsecure] = useState(false);
  useEffect(() => {
    setInsecure(typeof window !== 'undefined' && window.isSecureContext === false);
  }, []);

  /*
     Unsupported because the page is not secure is worth SAYING, not hiding.

     The rule below — no support, no button — is right for a browser that genuinely
     cannot record. It is wrong for the commonest case in practice: StarLink opened over
     plain http at a LAN address, where `navigator.mediaDevices` does not exist and the
     microphone silently is not there. Somebody testing from a phone sees a composer with
     no microphone and no reason, which reads as a missing feature.
  */
  if (!recorder.supported && recorder.problem === undefined && insecure) {
    return (
      <p className="voice-problem" role="status">
        Voice notes need a secure connection. Open StarLink over https, or at localhost.
      </p>
    );
  }

  if (!recorder.supported && recorder.problem === undefined) {
    /*
       No microphone support, no button.

       A control that opens a dialog saying the browser cannot do this is worse than its
       absence: it occupies a place in the row, invites a press, and answers with a
       disappointment. The rest of the composer is unaffected.
    */
    return null;
  }

  const recording = recorder.phase === 'recording' || recorder.phase === 'paused';

  /* ---- REVIEW: recorded, not yet sent ------------------------------------------------ */
  if (review !== undefined) {
    return (
      <ReviewBar
        recording={review}
        sending={sending || uploading}
        confirming={confirmingDelete}
        failed={sendFailed}
        onConfirmDelete={() => setConfirmingDelete(true)}
        onKeep={() => setConfirmingDelete(false)}
        onDelete={() => {
          setConfirmingDelete(false);
          setSendFailed(undefined);
          setReview(undefined);
        }}
        onSend={() => {
          setSendFailed(undefined);
          setUploading(true);
          void onRecorded(review)
            .then((ok) => {
              /* Only on success. A failed upload leaves the recording exactly where it
                 was, with a reason and a Send that can be pressed again — the audio is
                 in this component and nowhere else. */
              if (ok) setReview(undefined);
              else setSendFailed('That did not send. Your recording is still here — try again.');
            })
            .finally(() => setUploading(false));
        }}
      />
    );
  }

  /* ---- RECORDING --------------------------------------------------------------------- */
  if (recording || recorder.phase === 'stopping') {
    const bars = toBars(recorder.levels, BARS);
    return (
      <div className="voice-bar" role="group" aria-label="Recording a voice note">
        <button
          type="button"
          className="voice-cancel"
          onClick={() => recorder.cancel()}
          aria-label="Discard this recording"
          title="Discard"
        >
          <TrashGlyph />
        </button>

        {/*
          The dot is `aria-hidden` and the state is in the live region below instead. A
          blinking dot announced on every blink is a screen reader repeating "recording"
          once a second, which is the opposite of informative.
        */}
        <span
          className={`voice-dot${recorder.phase === 'paused' ? ' paused' : ''}`}
          aria-hidden="true"
        />

        <span className="voice-time" aria-hidden="true">
          {formatDuration(recorder.elapsed)}
        </span>

        <Waveform bars={bars} live={recorder.phase === 'recording'} />

        {/*
          One live region for the whole state, updated when the phase changes rather than
          when the timer does. Polite, so it waits for a gap instead of interrupting.
        */}
        <span className="sr-only" role="status">
          {recorder.phase === 'paused'
            ? `Recording paused at ${formatDuration(recorder.elapsed)}`
            : 'Recording'}
        </span>

        {recorder.phase === 'paused' ? (
          <button
            type="button"
            className="voice-secondary"
            onClick={() => recorder.resume()}
            aria-label="Resume recording"
            title="Resume"
          >
            <MicGlyph />
          </button>
        ) : (
          <button
            type="button"
            className="voice-secondary"
            onClick={() => recorder.pause()}
            aria-label="Pause recording"
            title="Pause"
          >
            <PauseGlyph />
          </button>
        )}

        <button
          type="button"
          className="voice-stop"
          disabled={recorder.phase === 'stopping'}
          onClick={() => {
            void recorder.stop().then((done) => {
              /*
                 `undefined` here means nothing was captured — a microphone that produced
                 no bytes, or a stop within the first tick. There is no audio to review and
                 nothing to warn about; returning to the composer is the whole recovery.
              */
              if (done !== undefined) setReview(done);
            });
          }}
          aria-label="Stop recording"
          title="Stop"
        >
          <StopGlyph />
        </button>
      </div>
    );
  }

  /* ---- IDLE: the microphone button, and anything that went wrong last time ----------- */
  return (
    <>
      <button
        type="button"
        className="composer-mic"
        disabled={disabled || recorder.phase === 'starting'}
        onClick={() => void recorder.start()}
        aria-label="Record a voice note"
        title="Record a voice note"
      >
        <MicGlyph />
      </button>

      {recorder.problem !== undefined ? (
        <p className="voice-problem" role="alert">
          {recorder.problem}
          <button type="button" onClick={recorder.dismissProblem} aria-label="Dismiss">
            <span aria-hidden="true">×</span>
          </button>
        </p>
      ) : null}
    </>
  );
}

/* ===================================================================================== */

/**
 * What you recorded, before it goes anywhere.
 *
 * Playback here is a plain `<audio>` over an object URL — the bytes are already in the
 * page, so there is nothing to fetch and no grant to spend. It is the one place in the
 * product where audio plays without a download grant, and it is legitimate: the file has
 * not been uploaded yet, and the person listening is the person who just recorded it.
 */
function ReviewBar({
  recording,
  sending,
  confirming,
  failed,
  onConfirmDelete,
  onKeep,
  onDelete,
  onSend,
}: {
  recording: Recording;
  sending: boolean;
  confirming: boolean;
  failed?: string | undefined;
  onConfirmDelete: () => void;
  onKeep: () => void;
  onDelete: () => void;
  onSend: () => void;
}): React.ReactNode {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | undefined>(undefined);

  /* The object URL is revoked when this unmounts. Without that, every recording made in a
     session leaks its whole blob until the tab closes. */
  useEffect(() => {
    const made = URL.createObjectURL(recording.blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [recording.blob]);

  const bars = toBars(recording.levels, BARS);
  const played = recording.durationMs > 0 ? position / recording.durationMs : 0;

  if (confirming) {
    return (
      <div className="voice-bar voice-confirm" role="alertdialog" aria-label="Delete this recording?">
        {/* The length is named, because it is the thing being thrown away and the reason
            somebody might not mean to. */}
        <span className="voice-confirm-text">
          Delete this {formatDuration(recording.durationMs)} recording?
        </span>
        <button type="button" className="voice-secondary" onClick={onKeep}>
          Keep
        </button>
        <button type="button" className="voice-delete" onClick={onDelete}>
          Delete
        </button>
      </div>
    );
  }

  return (
    <div className="voice-bar" role="group" aria-label="Review your voice note">
      <button
        type="button"
        className="voice-cancel"
        onClick={onConfirmDelete}
        aria-label="Delete this recording"
        title="Delete"
      >
        <TrashGlyph />
      </button>

      <button
        type="button"
        className="voice-play"
        onClick={() => {
          const el = audioRef.current;
          if (el === null) return;
          if (el.paused) void el.play();
          else el.pause();
        }}
        aria-label={playing ? 'Pause playback' : 'Play your recording'}
      >
        {playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>

      <span className="voice-time" aria-hidden="true">
        {formatDuration(playing || position > 0 ? position : recording.durationMs)}
      </span>

      <Waveform bars={bars} progress={played} />

      {url !== undefined ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
        />
      ) : null}

      <button
        type="button"
        className="voice-stop voice-send"
        onClick={onSend}
        disabled={sending}
        aria-label={failed === undefined ? 'Send this voice note' : 'Try sending again'}
        title={failed === undefined ? 'Send' : 'Try again'}
      >
        <SendGlyph />
      </button>

      {failed !== undefined ? (
        <p className="voice-problem voice-send-failed" role="alert">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The bar strip.
 *
 * `aria-hidden`, because a waveform is decoration for a value already given in words by
 * the timer beside it — and forty-four bars read out individually would be forty-four
 * pieces of noise.
 *
 * Live recording fills from the right (the newest sample at the leading edge, as every
 * recorder draws it); review fills from the left in proportion to playback.
 */
function Waveform({
  bars,
  live = false,
  progress,
}: {
  bars: readonly number[];
  live?: boolean;
  progress?: number;
}): React.ReactNode {
  /* A strip that renders only the bars it has is a strip that grows as you speak, pushing
     the buttons beside it around. Padding to a fixed count keeps the row still. */
  const padded =
    bars.length >= BARS
      ? bars.slice(-BARS)
      : live
        ? [...Array.from({ length: BARS - bars.length }, () => 0), ...bars]
        : [...bars, ...Array.from({ length: BARS - bars.length }, () => 0)];

  return (
    <span className="voice-wave" aria-hidden="true">
      {padded.map((level, index) => (
        <span
          key={index}
          className={
            progress !== undefined && index / BARS <= progress ? 'voice-bar-on' : undefined
          }
          style={{
            /* A floor of 12%, so silence is a flat line rather than a gap in the strip —
               a waveform with holes in it reads as a recording with holes in it. */
            height: `${Math.max(12, Math.min(100, level * 130))}%`,
          }}
        />
      ))}
    </span>
  );
}

/* ---- glyphs ------------------------------------------------------------------------- */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function MicGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...stroke} />
    </svg>
  );
}

function PauseGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path d="M9 5v14M15 5v14" {...stroke} strokeWidth={2.2} />
    </svg>
  );
}

function StopGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
    </svg>
  );
}

function PlayGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" />
    </svg>
  );
}

function SendGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M12 19.5V5m0 0-6.5 6.5M12 5l6.5 6.5" {...stroke} strokeWidth={2} />
    </svg>
  );
}

function TrashGlyph(): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path d="M4.5 6.5h15M9.5 6.5V4.8h5v1.7M6.8 6.5l.8 12.2h8.8l.8-12.2" {...stroke} />
    </svg>
  );
}
