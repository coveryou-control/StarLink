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
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api-client';
import type { StagedAttachment } from '../lib/upload-attachment';

/*
   Defined in `upload-attachment.ts` and re-exported here.

   The type used to live in this file, and when the transfer moved to the lib module the
   two imported each other — a cycle that is harmless at runtime (it is type-only) and that
   `pnpm boundaries` fails the build on anyway, correctly: a gate people learn to ignore
   stops catching the cycles that are not harmless. The re-export keeps every existing
   importer working.
*/
export type { StagedAttachment } from '../lib/upload-attachment';

/**
 * Which FAMILY of document a file belongs to, for the card that shows it.
 *
 * A PDF, a spreadsheet and a slide deck are three different things to somebody scanning a
 * conversation for one of them, and a column of identical grey rectangles reading
 * `PDF · 23 kB`, `XLSX · 4 MB`, `DOCX · 90 kB` makes that a reading task rather than a
 * glance. Colour is what turns it back into a glance, and it is the same argument the
 * attach menu's three tinted discs already make.
 *
 * Decided from the EXTENSION rather than the sniffed type, and that is a deliberate
 * exception to the rule the thread follows. The sniffed type decides how bytes are
 * INTERPRETED — whether they are handed to an `<img>`, which is an execution decision —
 * and there the uploader must not get a vote. This decides what colour a rectangle is.
 * The worst an uploader achieves by lying is a blue icon on a spreadsheet, and the
 * extension is what a person reads in the filename anyway.
 */
export type DocumentFamily = 'pdf' | 'doc' | 'sheet' | 'slides' | 'text' | 'archive' | 'file';

const FAMILIES: readonly { readonly family: DocumentFamily; readonly ext: readonly string[] }[] = [
  { family: 'pdf', ext: ['pdf'] },
  { family: 'doc', ext: ['doc', 'docx', 'odt', 'rtf', 'pages'] },
  { family: 'sheet', ext: ['xls', 'xlsx', 'ods', 'csv', 'numbers'] },
  { family: 'slides', ext: ['ppt', 'pptx', 'odp', 'key'] },
  { family: 'text', ext: ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml'] },
  { family: 'archive', ext: ['zip', 'rar', '7z', 'tar', 'gz'] },
];

export function documentFamily(filename: string): DocumentFamily {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'file';
  const ext = filename.slice(dot + 1).toLowerCase();
  return FAMILIES.find((entry) => entry.ext.includes(ext))?.family ?? 'file';
}

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

/**
 * What the paperclip offers, and what each choice will accept.
 *
 * The paperclip used to be a bare file input with no `accept` at all, so every press
 * opened the operating system's browser on the whole disk and left the person to find
 * their own way to a photograph. Naming the kind first is what every messenger does, and
 * it is not decoration: `accept` is what makes the file dialog open filtered, which is the
 * entire difference between "find your photo" and "here are your photos".
 *
 * ## `accept` is a hint, not a gate
 *
 * A person can still pick anything - every browser offers "All files" in that dialog, and
 * a determined one can rename a file. So nothing here is a check. The real ones are where
 * they have always been: the grant declares a type and a size, and section 28.1 refuses at
 * the boundary when the bytes do not match what was declared. This list makes the common
 * path short; it does not make the uncommon one safe, because it never could.
 *
 * ## Why extensions are listed as well as MIME types
 *
 * Windows reports no MIME type for several Office formats when the application that owns
 * them is not installed, so an `accept` list of those MIME types silently shows an empty
 * folder. The extension is what actually filters there.
 */
/** The menu's width before it has been measured, and the `min-width` the sheet gives it. */
const MENU_WIDTH = 194;

const ATTACH_KINDS = [
  {
    id: 'document',
    label: 'Document',
    accept:
      '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.rtf,.odt,.ods,application/pdf,text/plain,text/csv',
    icon: (
      <>
        <path d="M13.5 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.5Z" />
        <path d="M13.5 3.5v5h5" />
      </>
    ),
  },
  {
    id: 'media',
    label: 'Photos & videos',
    accept: 'image/*,video/*',
    icon: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
        <path d="m4.6 16.2 4.2-4.2 3.1 3.1 3-3 4.5 4.5" />
        <circle cx="9" cy="9.6" r="1.4" />
      </>
    ),
  },
  {
    id: 'audio',
    label: 'Audio',
    accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.aac,.flac',
    icon: (
      <>
        <path d="M9 17.5V6.2l9-1.7v11" />
        <circle cx="6.8" cy="17.6" r="2.3" />
        <circle cx="15.8" cy="15.6" r="2.3" />
      </>
    ),
  },
] as const;

export function AttachmentPicker({
  staged,
  onStagedChange,
  onFilesChosen,
}: {
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
  /**
   * The chosen batch, handed to the composer to triage, preview and upload.
   *
   * This control does not upload any more. It used to, and the cost was two copies of every
   * rule about attaching: the paperclip applied the size and count limits and decided what
   * to preview, and so did the drop handler, and the two were free to disagree. Dropping
   * three files and choosing three files are the same act reached by different gestures, so
   * they are now the same code — see `attachFiles` in `composer.tsx`.
   *
   * Resolves when the batch has been dealt with, which is what lets the paperclip show
   * itself as busy for exactly as long as it is.
   */
  readonly onFilesChosen: (files: readonly File[]) => Promise<void>;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Where the portalled menu sits, in viewport coordinates. */
  const [menuAt, setMenuAt] = useState<{ left: number; bottom: number } | undefined>(undefined);

  /*
     One input, re-pointed, rather than one per kind.

     Three inputs would be three things to keep in step and three labels for assistive
     technology to read out for what is one control. `accept` is set immediately before the
     click, which every browser reads at open time.
  */
  const choose = (accept: string): void => {
    const input = inputRef.current;
    if (input === null) return;
    input.accept = accept;
    setMenuOpen(false);
    input.click();
  };

  /**
   * The menu is placed against the WINDOW, not against the paperclip's ancestors.
   *
   * It was an absolutely positioned child of the control, opening rightward from
   * `left: 0`. The paperclip sits at the right-hand end of the composer's action row, so
   * a 194px menu ran off the right edge at every desktop width — measured at 1440, 1100,
   * 900 and 760, past the window on all four — and `main.thread-column` is
   * `overflow: hidden`, so what a person saw was the menu cut through the middle of a
   * word rather than a scrollbar.
   *
   * Clamping inside that column would have fixed the symptom and left the menu bounded by
   * a box it has no reason to be inside. It is a menu: it belongs to the window. So it is
   * portalled to the body, positioned from the trigger's own rect, and clamped to the
   * viewport with a margin — which no ancestor's `overflow` can undo.
   *
   * Right-aligned to the trigger by preference, because that is the edge with room when a
   * control is at the end of a row; the clamp catches the case where it is not.
   */
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuAt(undefined);
      return;
    }
    const place = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const box = trigger.getBoundingClientRect();
      const width = menuRef.current?.getBoundingClientRect().width ?? MENU_WIDTH;
      const MARGIN = 8;
      const preferred = box.right - width;
      const highest = window.innerWidth - MARGIN - width;
      const left = Math.max(MARGIN, Math.min(preferred, highest));
      setMenuAt({ left, bottom: window.innerHeight - box.top + MARGIN });
    };
    place();
    /* A resize or a scroll moves the paperclip out from under the menu. Re-placing is
       cheaper and less surprising than closing, which would lose a deliberate press. */
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuOpen]);

  /* Escape and a press outside, the same two exits every other popover here has. */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [menuOpen]);

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
  /*
     One batch, handed straight to the composer's own attach path.

     The paperclip used to run its own upload, which meant the count limit, the size limit
     and the preview all had to be applied here AND in the drop handler - two copies of a
     rule that exists once on the server. `onFilesChosen` is that path: the same triage, the
     same uploads, the same decision about which single file gets a preview. What is left
     here is the part that is genuinely the control's: knowing whether it is busy, and
     clearing the input so choosing the same file twice fires a change event both times.
  */
  const attach = async (files: readonly File[]): Promise<void> => {
    setBusy(true);
    try {
      await onFilesChosen(files);
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
        A paperclip that asks WHAT, and one file input behind it.

        It used to be the input itself, stretched transparently over the glyph — the
        standard accessible pattern, and the reason for it still holds: the browser's own
        control renders "Choose File | No file chosen", a locale-dependent widget with a
        fixed label no stylesheet can change. What was wrong was not the technique but the
        step it skipped. One press opened the whole disk, so attaching a photograph meant
        navigating to it, and the product had nothing to say about the difference between a
        photograph, a recording and a contract.

        So the glyph is a real button now and the input sits behind it, kept in the DOM and
        kept labelled — `setInputFiles` and any assistive technology still reach it — while
        the menu is what a person presses. The input is `hidden` rather than transparent
        because there is nothing left to lay it over; the button is the control.
      */}
      <span className="attach-control">
        <button
          ref={triggerRef}
          type="button"
          className="attach-trigger"
          aria-label="Attach"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={() => setMenuOpen((was) => !was)}
        >
          <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
            <path
              d="M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {menuOpen
          ? createPortal(
              <div
                className="attach-menu"
                role="menu"
                aria-label="What to attach"
                ref={menuRef}
                /* Hidden for the one frame between mounting and being measured, rather
                   than drawn in the wrong place and then moved. */
                style={
                  menuAt === undefined
                    ? { visibility: 'hidden' }
                    : { left: `${menuAt.left}px`, bottom: `${menuAt.bottom}px` }
                }
              >
                {ATTACH_KINDS.map((kind) => (
                  <button
                    key={kind.id}
                    type="button"
                    role="menuitem"
                    className="attach-menu-item"
                    onClick={() => choose(kind.accept)}
                  >
                    <span className={`attach-menu-icon is-${kind.id}`} aria-hidden="true">
                      <svg
                        viewBox="0 0 24 24"
                        width="17"
                        height="17"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        focusable="false"
                      >
                        {kind.icon}
                      </svg>
                    </span>
                    {kind.label}
                  </button>
                ))}
              </div>,
              document.body,
            )
          : null}

        {/*
          `multiple`, because picking six photographs is one errand.

          It was single-file, so attaching a set meant six trips through the operating
          system's file dialog and six separate messages if anybody lost patience. The
          ceiling on how many is the SERVER's and is applied in `attachFiles` — this
          attribute only decides whether the dialog lets somebody select more than one.
        */}
        <input
          ref={inputRef}
          type="file"
          aria-label="Attach a file"
          multiple
          hidden
          disabled={busy}
          onChange={(e) => {
            const chosen = [...(e.target.files ?? [])];
            if (chosen.length > 0) void attach(chosen);
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
                READY says NOTHING, and that is the point.

                It used to read "· ready to send". That caption made sense when a file spent
                up to ten seconds in "still being checked" first: the pair told a person the
                wait was over. The check now runs inside the announce and finishes in tens of
                milliseconds — measured at 96ms from picking the file to a usable send — so
                the two states no longer form a sequence anybody watches, and all the caption
                does is narrate the normal case.

                A chip that says the file is attached IS the message. §28.1's point — that an
                uploaded file is reachable by nobody until it is bound — is still true and
                still worth knowing, and it is not something to tell somebody on every
                attachment; the send button being usable says the same thing more usefully.

                The other three states keep their words, because each of them is a REASON the
                thing a person expected has not happened.
              */}
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
