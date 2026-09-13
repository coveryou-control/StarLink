'use client';

/**
 * The screen between picking a picture and sending it.
 *
 * ## Why a picture is not a document
 *
 * Every other attachment is a filename: you know what `renewal-schedule.pdf` is from its
 * name, and a chip in the composer is a complete description of it. A photograph is not.
 * `IMG_20260910_113402.jpg` says nothing, and the one question a person has after picking
 * one — is this the right picture? — a chip cannot answer. So a picture gets shown before
 * it is sent, and everything else does not.
 *
 * ## The upload has already started
 *
 * This is a preview, not a gate. `attach()` begins the four-step upload the moment the
 * file is chosen, so by the time somebody has looked at the picture and typed a line the
 * bytes are usually already up — measured at about 96ms to a sendable state on the local
 * stack. Nothing here waits for anything; the send control simply says so if the file is
 * genuinely not ready yet.
 *
 * ## The caption IS the message body
 *
 * Not a second field with its own state. It writes through the composer's own
 * `onCaptionChange`, which is the composer's `handleChange` — so the draft is saved, the
 * mention pruning runs, and pressing send here goes through exactly the same `send()` as
 * pressing the arrow. A picture with a line under it is one message, and it has to be one
 * code path or the two drift.
 *
 * ## What cancel does
 *
 * Removes the staged file. It does NOT clear the caption: somebody who picked the wrong
 * photograph has not changed their mind about the sentence they typed under it.
 */
import { useEffect, useRef } from 'react';

import { documentFamily, extensionOf } from './attachment-picker';

export interface MediaPreview {
  /**
   * The object URL. Created by the composer, revoked by the composer.
   *
   * Empty for a document: there is nothing to render it into, and creating a blob URL for
   * bytes nothing will read would be a leak with no reader.
   */
  readonly url: string;
  readonly kind: 'image' | 'video' | 'file';
  readonly filename: string;
  readonly bytes: number;
  /** Known once the grant comes back; until then the file cannot be cancelled by id. */
  readonly attachmentId?: string;
  /** `true` once the server will bind it — see §28.1. */
  readonly ready: boolean;
  readonly problem?: string;
}

export function MediaPreviewOverlay({
  preview,
  caption,
  onCaptionChange,
  onSend,
  onCancel,
  sending,
  humanBytes,
}: {
  readonly preview: MediaPreview;
  readonly caption: string;
  readonly onCaptionChange: (next: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly sending: boolean;
  readonly humanBytes: (bytes: number) => string;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* The caption is the only thing left to do, so it takes the caret. */
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  /*
     Escape cancels — but not mid-send, when dismissing the surface would leave somebody
     with no idea whether the picture went. The same rule the compose dialog uses.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !sending) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, sending]);

  /*
     Focus stays inside while this is up.

     It covers the whole window, so a Tab that walked out of it would put the caret on the
     conversation list behind a scrim — reachable by keyboard, invisible to the eye. This
     is the smallest correct version: the two ends of the tab ring wrap to each other.
  */
  useEffect(() => {
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, video[controls]',
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => document.removeEventListener('keydown', onTab);
  }, []);

  const blocked = preview.problem !== undefined;

  return (
    <div className="media-preview" role="dialog" aria-modal="true" aria-label="Send this file">
      <div className="media-preview-panel" ref={panelRef}>
        <header className="media-preview-head">
          <div className="media-preview-what">
            <strong>{preview.filename}</strong>
            <span>{humanBytes(preview.bytes)}</span>
          </div>
          <button
            type="button"
            className="media-preview-close"
            onClick={onCancel}
            disabled={sending}
            aria-label="Cancel"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        {/*
          The picture at its own proportions, never cropped.

          A preview that crops is worse than no preview: it answers "is this the right
          picture" with a lie about what will arrive. `contain` inside a bounded box is
          what keeps a panorama and a portrait both whole.
        */}
        <div className="media-preview-stage">
          {preview.kind === 'image' ? (
            <img src={preview.url} alt={preview.filename} />
          ) : preview.kind === 'video' ? (
            /* Controls, because a video's first frame is often black and "is this the
               right clip" cannot be answered by a still. No autoplay: a recording that
               starts talking the moment it is picked is startling in an office. */
            <video src={preview.url} controls preload="metadata" />
          ) : (
            /*
               A document, which cannot be previewed and says so.

               There is no honest thumbnail for a PDF or a spreadsheet in a browser — the
               first page needs a renderer this product does not ship, and a generic icon
               pretending to be a preview is worse than the sentence. What the panel CAN
               confirm is the thing somebody actually needs before sending: that this is
               the right file, by name, kind and size.

               It is still the same panel, because the act is the same act. A document
               gets a caption too, which is the other half of why it is here — that was
               previously impossible: a document went as a bare chip with the message text
               beside it, and there was nowhere to write "the signed copy" against the
               file it describes.
            */
            <div className="media-preview-doc">
              <span className={`media-preview-doc-icon is-${documentFamily(preview.filename)}`} aria-hidden="true">
                <svg viewBox="0 0 32 40" width="64" height="80" focusable="false">
                  <path
                    d="M4 3.4A2.4 2.4 0 0 1 6.4 1h12.2L28 10.4v26.2a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 36.6Z"
                    fill="currentColor"
                    opacity="0.16"
                  />
                  <path
                    d="M4 3.4A2.4 2.4 0 0 1 6.4 1h12.2L28 10.4v26.2a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 36.6Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M18.6 1v7a2.4 2.4 0 0 0 2.4 2.4h7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </span>
              <p className="media-preview-doc-name">{preview.filename}</p>
              <p className="media-preview-doc-meta">
                {extensionOf(preview.filename)} · {humanBytes(preview.bytes)}
              </p>
              <p className="media-preview-doc-note">No preview available</p>
            </div>
          )}
        </div>

        {blocked ? (
          <p className="media-preview-problem" role="alert">
            {preview.problem}
          </p>
        ) : null}

        <footer className="media-preview-foot">
          <input
            ref={fieldRef}
            type="text"
            className="media-preview-caption"
            placeholder="Add a caption"
            aria-label="Caption"
            value={caption}
            onChange={(event) => onCaptionChange(event.target.value)}
            onKeyDown={(event) => {
              /* Enter sends, exactly as it does in the composer this replaces for the
                 moment it is up. Shift+Enter is not a newline here: the caption is one
                 line and a multi-line field would be a second composer. */
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              if (!sending && !blocked) onSend();
            }}
          />
          <button
            type="button"
            className="media-preview-send"
            onClick={onSend}
            /*
               Disabled until the server will actually bind it.

               Not a wait imposed by this screen - it is the one the pipeline already has,
               and it is short (about 96ms locally). What matters is what pressing send a
               moment too early would DO: `send()` binds only READY attachments, so with a
               caption typed it would send the sentence and leave the picture behind. A
               message that arrives without its picture is the failure this prevents.
            */
            disabled={sending || blocked || !preview.ready}
            /*
               The label says which state it is in, because the icon cannot.

               "Sending" and "still arriving" look identical on a disabled arrow, and they
               are different facts: one means wait, the other means the bytes are not up
               yet. A screen reader gets the difference; so does a tooltip.
            */
            aria-label={sending ? 'Sending' : preview.ready ? 'Send' : 'Send when the file is ready'}
            title={preview.ready || sending ? 'Send' : 'Still uploading'}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path
                d="M4.5 12h13m0 0-5.2-5.2M17.5 12l-5.2 5.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </footer>
      </div>
    </div>
  );
}
