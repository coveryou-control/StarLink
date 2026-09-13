'use client';

import type { Dispatch, SetStateAction } from 'react';

import { api, ApiError } from './api-client';
import { rememberLocalMedia } from './local-media';

/**
 * A file the composer is holding, and how far along it is.
 *
 * Lives here rather than in `attachment-picker.tsx` because the uploader is what creates
 * and advances one; the picker renders them. That is also what keeps the two modules from
 * importing each other.
 */
export interface StagedAttachment {
  readonly attachmentId: string;
  readonly filename: string;
  /** Carried so the optimistic message can render the file without a re-read. */
  readonly declaredBytes: number;
  /**
   * What the browser said the file was when it was chosen.
   *
   * Carried so the OPTIMISTIC row can be drawn correctly. Its absence was half of why a
   * sent picture appeared as a file card: the optimistic attachment was built from this
   * shape, `mediaKindOf` decides from a content type, and there was none to decide on.
   *
   * It is the DECLARED type and it is used for exactly one thing — deciding how to draw
   * bytes this browser already has. Nothing downstream trusts it: the server sniffs the
   * real type, and every attachment anybody else can see is drawn from that.
   */
  readonly contentType: string;
  /**
   * UPLOADING — bytes in flight. SCANNING — uploaded, awaiting the verdict; NOT sendable.
   * READY — CLEAN, and §28.1 will bind it. FAILED — it never will, and `problem` says why.
   */
  readonly state: 'UPLOADING' | 'SCANNING' | 'READY' | 'FAILED';
  readonly problem?: string;
  /** Present on a voice note only, so the chip can say how long it is while it uploads. */
  readonly durationMs?: number;
}

/**
 * The four-step upload (§28), lifted out of the picker so more than one gesture can start it.
 *
 * ## Why it moved
 *
 * This was a closure inside `AttachmentPicker`, which was correct while the paperclip was
 * the only way to attach anything. Dropping a file on the composer and pasting a screenshot
 * are the same operation reached by different gestures, and the alternative to lifting it
 * was three copies of the grant-upload-announce-poll sequence drifting apart — which is
 * exactly how one of them ends up not handling the 503 that §34.4 requires be handled.
 *
 * The picker still owns the CHIPS and the scan poll. Only the transfer moved.
 *
 * Resolves the ATTACHMENT ID, or `undefined` when the file never reached the scanner.
 *
 * It resolved a boolean until the voice note's arrow had to send as well as stage: sending
 * means binding one specific attachment, and "it worked" is not enough to name which. Every
 * caller may still ignore the value — the chip already says what happened — except the
 * recorder, which must not throw away the only copy of a recording it has just failed to
 * send, and now also needs to know what it just uploaded.
 *
 * The steps, and why they are four, are documented on `attachment-picker.tsx`; this is the
 * same code, not a second implementation.
 */
export async function uploadAttachment(
  conversationId: string,
  file: File,
  onStagedChange: Dispatch<SetStateAction<readonly StagedAttachment[]>>,
  /**
   * How long a voice note runs. Only a recorder can know this, and only a recorder passes
   * it — a document has no duration and must not acquire one, or the bubble renders a
   * play button beside a PDF.
   */
  durationMs?: number,
): Promise<string | undefined> {
  let attachmentId: string | undefined;
  try {
    /* 1. The grant. Declared values only — the server verifies the real MIME by content
          after upload, because SL-056's acceptance is "extension never trusted". */
    const grant = await api.requestUpload(conversationId, {
      filename: file.name,
      declaredMime: file.type || 'application/octet-stream',
      declaredBytes: file.size,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    attachmentId = grant.attachmentId;

    /* The bytes are already here. Keeping them against the id is what lets the thread draw
       your own picture the instant it is sent, rather than after a round trip for a
       download grant on a file this browser just uploaded — see `local-media.ts`. */
    rememberLocalMedia(grant.attachmentId, file);

    onStagedChange((current) => [
      ...current,
      {
        attachmentId: grant.attachmentId,
        filename: file.name,
        declaredBytes: file.size,
        contentType: file.type || 'application/octet-stream',
        state: 'UPLOADING',
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]);

    /* 2. Direct to storage. The application never sees the bytes. */
    await api.uploadBytes(grant.uploadUrl, file);

    /*
       3. "I finished" — and the answer already carries the verdict.

       The check runs inside the announce now rather than up to ten seconds later in a
       sweep, so this response almost always says CLEAN. What a person used to wait through
       was never the check itself; it was the poll interval in front of it.
    */
    const announced = await api.markUploaded(grant.attachmentId);

    /*
       4. Sendable immediately when it came back clean, and only then.

       The SCANNING branch is not dead code and must not be removed: it is what happens when
       the scanner was unavailable, and the picker's poll picks the verdict up exactly as it
       did before. What has gone is the wait in the ordinary case, not the honesty in the
       unusual one — a file the server has not cleared still must not claim to be sendable,
       because sending it produces a message with no attachment.
    */
    const ready = announced.state === 'CLEAN' || announced.state === 'BOUND';
    onStagedChange((current) =>
      current.map((item) =>
        item.attachmentId === grant.attachmentId
          ? { ...item, state: ready ? 'READY' : 'SCANNING' }
          : item,
      ),
    );
    return grant.attachmentId;
  } catch (cause) {
    /**
     * §34.4 requires an upload to fail EXPLICITLY so "the user keeps their message and can
     * retry". A 503 is storage being down and is worth saying plainly; a refusal is the
     * uniform 404 and must not be guessed at (§27.3).
     */
    /* 413 is the voice-note ceiling, and it is the one refusal that can say what to do
       about it — the server sends the actual limit back, so the message names it rather
       than leaving somebody to guess how much shorter is short enough. */
    const tooBig =
      cause instanceof ApiError && cause.status === 413
        ? (cause.body as { error?: string; maxSeconds?: number; maxBytes?: number } | undefined)
        : undefined;

    const problem =
      tooBig?.error === 'voice_note_too_long'
        ? `That recording is longer than the ${Math.round((tooBig.maxSeconds ?? 0) / 60)}-minute limit.`
        : tooBig?.error === 'voice_note_too_large'
          ? `That recording is larger than the ${Math.round((tooBig.maxBytes ?? 0) / (1024 * 1024))} MB limit.`
          : /*
               The size ceiling, met at the server rather than in the composer.
 
               The composer normally says this first and says it better — it can sort a
               whole batch and name every file at once. This is the same refusal arriving
               the other way: the limits fetch failed, or the policy changed under a page
               that had been open a while. Either way the answer is the same one, and it
               names the ceiling the SERVER applied rather than one this browser believed.
            */
            tooBig?.error === 'attachment_too_large'
            ? `This file is larger than the ${Math.round((tooBig.maxBytes ?? 0) / (1024 * 1024))} MB limit. Put it on Drive and share the link instead.`
            : cause instanceof ApiError && cause.status === 503
            ? 'Storage is temporarily unavailable. Your message is safe — try the file again.'
            : cause instanceof ApiError && cause.isRefusal
              ? 'That file cannot be attached here.'
              : 'The upload did not finish. Your message is safe.';

    if (attachmentId !== undefined) {
      const id = attachmentId;
      onStagedChange((current) =>
        current.map((item) =>
          item.attachmentId === id ? { ...item, state: 'FAILED', problem } : item,
        ),
      );
    } else {
      /* The grant itself was refused, so there is no id to key on. Keyed by name so the
         person still sees which file failed. */
      onStagedChange((current) => [
        ...current,
        {
          attachmentId: `failed:${file.name}:${Date.now()}`,
          filename: file.name,
          declaredBytes: file.size,
          contentType: file.type || 'application/octet-stream',
          state: 'FAILED',
          problem,
        },
      ]);
    }
    /**
     * The caller is TOLD, as well as the chip being marked.
     *
     * A dropped file that fails leaves a chip explaining itself and the file still on
     * disk, so a return value would add nothing. A voice note has neither: the audio
     * exists only in the page, and the recorder's review is the only place it can be
     * played or re-sent from. Clearing that review on a failed upload destroys the
     * recording — so the recorder waits for this before it does.
     */
    return undefined;
  }
}

/**
 * A pasted screenshot has no filename, so it is given one.
 *
 * `clipboardData` hands over a `File` called `image.png` on every platform — sometimes
 * literally that, sometimes the empty string. Several screenshots pasted into one message
 * would then be a list of identical names, and the chips, the optimistic row and the
 * thread would all show the same word three times with no way to tell which is which.
 * A timestamp is the one distinguishing fact available at paste time.
 */
export function nameForPastedImage(file: File, at: Date = new Date()): string {
  const existing = file.name.trim();
  if (existing !== '' && existing.toLowerCase() !== 'image.png') return existing;

  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    ` ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const extension = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] ?? 'png');
  return `Screenshot ${stamp}.${extension}`;
}
