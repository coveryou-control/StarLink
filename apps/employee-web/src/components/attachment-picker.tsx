'use client';

/**
 * Attaching a file to a message (SL-054, SL-055, SL-056 — ADR-012, §28).
 *
 * The whole pipeline — grant, quarantine, scan, promote, bind, download — was built and
 * tested in Phase 7, and **neither web surface had any way to attach a file**. Found by
 * the route-to-client scan on 2026-08-29.
 *
 * ## The four steps, and why they are four
 *
 *   1. **Ask for a grant.** Authorization happens before any object exists (§28.1 rejects
 *      before bytes). This is also where a storage outage surfaces — as a 503 saying
 *      "temporarily unavailable", never a 404 saying the file is gone (§34.4).
 *   2. **PUT the bytes to the grant's own URL.** SL-054's acceptance is literally "API not
 *      byte bottleneck": the application never handles the file.
 *   3. **Announce.** A hint that moves the object into scanning. §28.4 treats it as a hint
 *      only — the expiry sweep would find an abandoned upload anyway.
 *   4. **Wait for the verdict, and say so.** Added 2026-08-30, and the reason is below.
 *
 * Binding to a message happens at SEND, not here, because §28.1 makes the message the
 * thing that gives an attachment reach. Until then the file is uploaded and reachable by
 * nobody, which is the state that rule exists to create.
 *
 * ## Step 4: the file was called "ready to send" before it could be sent
 *
 * §28.1 binds only a CLEAN attachment, and the scan happens on a sweep. This component
 * used to jump straight from "the bytes arrived" to READY, so the composer offered the
 * file, the send left it out, the id came back in `notAttachedIds` — and nothing read that
 * field. The person saw a chip that said "ready to send", clicked send, and got a message
 * with no document attached and no indication anything had gone wrong.
 *
 * SCANNING is therefore a real state with its own label, and READY now means what it says:
 * the server will bind this. The verdict is polled rather than pushed because §20.7 gives
 * attachments no realtime channel, and a poll bounded by a deadline is honest about being
 * a poll.
 *
 * ## What this still deliberately does not do
 *
 * It does not BLOCK the composer. §34's degradation rule and brief §43 invariant 9 both
 * say the text must never be hostage to the file: the send proceeds, and a file that is
 * still scanning simply is not among the ones bound. What changed is that the interface no
 * longer claims otherwise — the chip says it is still being checked, and the composer
 * reports afterwards what did not go.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../lib/api-client';
import { uploadAttachment, type StagedAttachment } from '../lib/upload-attachment';

/*
   Defined in `upload-attachment.ts` and re-exported here.

   The type used to live in this file, and when the transfer moved to the lib module the
   two imported each other — a cycle that is harmless at runtime (it is type-only) and that
   `pnpm boundaries` fails the build on anyway, correctly: a gate people learn to ignore
   stops catching the cycles that are not harmless. The re-export keeps every existing
   importer working.
*/
export type { StagedAttachment } from '../lib/upload-attachment';

/** How long to wait for a verdict before saying so rather than spinning for ever. */
const SCAN_DEADLINE_MS = 60_000;
/**
 * How often to ask whether the scan has finished.
 *
 * The WAIT is real and is not removable: §28.1 binds only a CLEAN attachment, so the
 * product genuinely does not know whether the file can be sent until the scanner answers.
 * What was removable is the part of the wait that was this poll's own doing — at a flat
 * 800ms a scan that finished in 50ms still looked like it took most of a second.
 *
 * So the first few checks are fast and then it backs off: the common case (a small file,
 * an immediate verdict) resolves in about a quarter of the time, and a slow one does not
 * pay for that with a request every 250ms for a minute.
 */
const SCAN_POLL_FAST_MS = 250;
const SCAN_POLL_MS = 800;
/** How long to stay on the fast cadence before backing off. */
const SCAN_FAST_WINDOW_MS = 3_000;

/**
 * Server states, mapped to what they mean for the person waiting.
 *
 * Written as an explicit table rather than "anything that is not CLEAN is still going",
 * because each terminal state deserves its own sentence. §34.4: an upload fails EXPLICITLY,
 * so the person keeps their message and knows to retry. A state absent from this table
 * leaves the chip where it is and the poll running until its deadline — fail-closed, and
 * the states are the closed enum in `packages/attachments/src/pipeline.ts`.
 *
 * **`BOUND` is `'GONE'`, not `'READY'`.** It was mapped to READY, and that was a loop: an
 * attachment reaches BOUND when it has been attached to a message, `bind` requires CLEAN,
 * so a BOUND attachment can never be bound again. If a send's response was lost, the retry
 * found the id already bound, the server returned it in `notAttachedIds`, the chip reset to
 * SCANNING, the poll read BOUND, the chip said "ready to send" — and round it went, one
 * duplicate customer message per turn. BOUND means the file arrived; the chip's job is done
 * and it should leave.
 */
const VERDICTS: Record<string, { state: 'READY' | 'FAILED' | 'GONE'; problem?: string }> = {
  CLEAN: { state: 'READY' },
  BOUND: { state: 'GONE' },
  INFECTED: { state: 'FAILED', problem: 'This file did not pass the virus check.' },
  REJECTED: {
    state: 'FAILED',
    problem: 'This file was rejected — its type or size did not match what was declared.',
  },
  EXPIRED: { state: 'FAILED', problem: 'This upload expired before it was sent. Attach it again.' },
};

export function AttachmentPicker({
  conversationId,
  staged,
  onStagedChange,
}: {
  readonly conversationId: string;
  readonly staged: readonly StagedAttachment[];
  /**
   * Accepts an updater, and the calls below always use one.
   *
   * Every mutation here happens after an `await`, so a version built from the `staged`
   * prop captured at call time would discard whatever changed meanwhile — attaching two
   * files at once, or a poll settling while a second upload was in flight, silently lost
   * one of them. This is the same stale-closure class as the composer's dropped
   * attachments, and the functional form is what makes it unrepresentable.
   */
  readonly onStagedChange: Dispatch<SetStateAction<readonly StagedAttachment[]>>;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const update = (
    attachmentId: string,
    patch: Partial<StagedAttachment>,
  ): void => {
    onStagedChange((current) =>
      current.map((item) => (item.attachmentId === attachmentId ? { ...item, ...patch } : item)),
    );
  };

  /*
     The transfer itself lives in `upload-attachment.ts`, because the paperclip is no longer
     the only way to start one — a file dropped on the composer and a pasted screenshot take
     the same four steps. This keeps the chips, the poll and the button; it no longer keeps
     its own copy of the pipeline.
  */
  const attach = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      await uploadAttachment(conversationId, file, onStagedChange);
    } finally {
      setBusy(false);
      if (inputRef.current !== null) inputRef.current.value = '';
    }
  };

  /**
   * Polls the scan verdict for anything still SCANNING.
   *
   * Keyed on the set of scanning ids rather than on `staged`, so it does not restart every
   * time an unrelated chip changes. A file whose verdict never arrives becomes FAILED at
   * the deadline with a sentence saying so — not a spinner that runs until the tab closes.
   */
  const scanningKey = staged
    .filter((item) => item.state === 'SCANNING')
    .map((item) => item.attachmentId)
    .join(',');

  useEffect(() => {
    if (scanningKey === '') return;
    const ids = scanningKey.split(',');
    let cancelled = false;
    const startedAt = Date.now();

    const poll = async (): Promise<void> => {
      for (const attachmentId of ids) {
        if (cancelled) return;
        try {
          const { state } = await api.attachmentStatus(attachmentId);
          const verdict = VERDICTS[state];
          if (verdict === undefined || cancelled) continue;

          if (verdict.state === 'GONE') {
            // Already attached to a message — see the note on BOUND above. The chip is
            // removed rather than marked, because there is nothing left for it to do and
            // anything it said would be a state the person cannot act on.
            onStagedChange((current) => current.filter((item) => item.attachmentId !== attachmentId));
            continue;
          }

          update(attachmentId, {
            state: verdict.state,
            ...(verdict.problem !== undefined ? { problem: verdict.problem } : {}),
          });
        } catch {
          // A transient failure is not a verdict. The deadline below is what ends this.
        }
      }

      if (!cancelled && Date.now() - startedAt > SCAN_DEADLINE_MS) {
        for (const attachmentId of ids) {
          update(attachmentId, {
            state: 'FAILED',
            problem: 'This file is taking too long to check. Your message is safe — try it again.',
          });
        }
      }
    };

    /**
     * `setTimeout` chained rather than `setInterval`, because the cadence changes: an
     * interval cannot slow itself down, and rescheduling from inside the tick is what lets
     * the first three seconds be quick and everything after be polite.
     */
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      void poll();
      // Shares the deadline's own clock, so "how long has this been scanning" is one
      // number rather than two that can disagree.
      const elapsed = Date.now() - startedAt;
      timer = setTimeout(tick, elapsed < SCAN_FAST_WINDOW_MS ? SCAN_POLL_FAST_MS : SCAN_POLL_MS);
    };
    timer = setTimeout(tick, SCAN_POLL_FAST_MS);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    /**
     * `scanningKey` alone is the correct dependency, and that is a claim worth stating
     * rather than assuming: the body reads no captured `staged`, because every write goes
     * through the updater form of `onStagedChange`. That is what makes a shorter list safe
     * here where it was not safe in the composer.
     *
     * `react-hooks/exhaustive-deps` is still not configured in this repository, so nothing
     * checks the claim mechanically. It is the rule that would have caught the composer
     * dropping attachments, and it remains worth adding.
     *
     * Two limits of this poll, stated because an earlier version of the comment above
     * claimed otherwise: an unrecognised state does NOT stop the poll — it leaves the chip
     * alone and spins until the deadline — and `startedAt` is re-initialised whenever
     * `scanningKey` changes, so with several files in flight each settlement restarts the
     * others' clocks. Both are fail-closed and neither is worth extra machinery at pilot
     * volume; they are wrong to describe as something else.
     */
  }, [scanningKey]);

  return (
    <div className="attachment-picker">
      {/*
        A paperclip, with the real input laid transparently over it.

        The browser's own file control renders "Choose File | No file chosen" — a
        two-part, locale-dependent widget with a fixed label that no stylesheet can
        change, and it looked exactly as out of place in a chat composer as it sounds.

        This is the standard accessible pattern rather than a trick: the `input` is still
        an input, still focusable, still keyboard-operable, still carries its own
        `aria-label`, and is what actually receives the click — it is stretched over the
        glyph at zero opacity, not hidden. `visibility` and `display` are untouched, so it
        remains present to assistive technology and to any test that asserts the control
        is there. The glyph is `aria-hidden` decoration; the focus ring is drawn on the
        wrapper via `:focus-within`, because the element that has focus is invisible.
      */}
      <span className="attach-control">
        <span className="attach-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="19" height="19" focusable="false">
            <path
              d="M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="file"
          aria-label="Attach a file"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void attach(file);
          }}
        />
      </span>

      {/*
        "Files to send", NOT "Attached files".

        `message-list.tsx` already labels the files ON a sent message "Attached files", and
        this list carried the same name — so a screen reader announced "files that were
        sent" and "files I have not sent yet" identically, in a component whose whole job
        is to keep that distinction clear. §28.1 makes it a real distinction: nothing here
        is attached to anything until a message binds it.
      */}
      {staged.length > 0 ? (
        <ul className="staged" aria-label="Files to send">
          {staged.map((item) => (
            <li key={item.attachmentId} className={`staged-${item.state.toLowerCase()}`}>
              <span className="staged-name">{item.filename}</span>
              {/*
                The size, when the server told us one. `declaredBytes` is what the upload
                grant was issued against, so it is a fact rather than a guess — and it is
                the difference between a chip that says a file is attached and one that
                says WHICH file, which matters when two drafts have similar names.
              */}
              {item.declaredBytes !== undefined ? (
                <span className="staged-size">{formatBytes(item.declaredBytes)}</span>
              ) : null}
              {item.state === 'UPLOADING' ? <span className="muted"> · uploading…</span> : null}
              {/*
                The state that did not exist, and whose absence was the defect. "Still being
                checked" is the literal truth and it is also the reason the file will not be
                attached if the person sends now — §28.1 binds nothing that is not CLEAN.
              */}
              {item.state === 'SCANNING' ? (
                <span className="muted"> · still being checked</span>
              ) : null}
              {/*
                §28.1: an uploaded file is reachable by NOBODY until it is bound to a
                message. Saying "ready to send" rather than "uploaded" keeps that true in
                the person's head — the file is not shared yet.
              */}
              {item.state === 'READY' ? <span className="muted"> · ready to send</span> : null}
              {item.state === 'FAILED' ? <span role="alert"> · {item.problem}</span> : null}
              <button
                type="button"
                aria-label={`Remove ${item.filename}`}
                onClick={() =>
                  onStagedChange((current) =>
                    current.filter((s) => s.attachmentId !== item.attachmentId),
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Bytes as a person reads them.
 *
 * Binary units (1024) because that is what the operating system's file dialog just showed
 * them — a chip reading 1.0 MB beside a dialog reading 1.0 MiB for the same file is a
 * small wrongness people notice and cannot explain. One decimal place above KB; none
 * below, because "1.4 KB" is precision nobody is using.
 */
/**
 * The badge on a file card: the extension of the name the uploader gave.
 *
 * Not a guess at the file's type. §28.2 sniffs the real content server-side and the sniffed
 * type is not part of any projection the browser receives — drawing a PDF glyph because a
 * name ends in `.pdf` would assert something only the scanner knows, on the one screen
 * where a file's identity matters most.
 *
 * Clipped to four characters so a name ending in `.something-long` cannot widen the tile.
 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return 'FILE';
  return filename.slice(dot + 1, dot + 5).toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
