'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api, type MessageView } from '../lib/api-client';
import { useEnterToSend } from '../lib/preferences';
import { AttachmentPicker, type StagedAttachment } from './attachment-picker';
import { EmojiPicker } from './emoji-picker';
import { MentionPicker, useClampedIndex, type MentionCandidate } from './mention-picker';
import { useActiveConversation } from './active-conversation';
import {
  insertMention,
  mentionQueryAt,
  pruneMentions,
  type MentionQuery,
} from '../lib/mention-draft';
import type { MentionView } from '../lib/api-client';
import { DraftStore, createDraftAutosaver } from '../lib/drafts';

export type Visibility = 'INTERNAL' | 'CUSTOMER_VISIBLE';

export interface PendingSend {
  readonly localId: string;
  readonly body: string;
  readonly visibility: Visibility;
  readonly state: 'SENDING' | 'FAILED';
}

interface ComposerProps {
  readonly conversationId: string;
  readonly principalId: string;
  /** Used only for the optimistic row; the server freezes its own copy at send time. */
  readonly senderDisplayName: string;
  /** False for internal-only threads, where there is no customer to reply to. */
  readonly canReplyToCustomer: boolean;
  readonly onSent: (message: MessageView) => void;
  readonly onPendingChange: (pending: readonly PendingSend[]) => void;
  /**
   * SL-010. Announces that this person is composing, with the CURRENT mode.
   *
   * The visibility travels with it because §20.10 withholds an internal-note signal from
   * a customer in the same room — the gateway cannot apply that rule without knowing
   * which kind of message is being written.
   */
  readonly onTyping?: (visibility: Visibility) => void;
  /** UC-E16: the message being replied to, cleared by the composer once sent. */
  readonly replyingTo?: MessageView | undefined;
  readonly onCancelReply?: (() => void) | undefined;
  /** Placeholder override, so the composer can name the conversation it writes into. */
  readonly placeholder?: string | undefined;
}

/**
 * Message composer.
 *
 * The dominant risk here is not a bug, it is a human error the UI invited: posting an
 * internal note into a customer-visible thread. §19.4 and NFR-ACC-3 therefore require
 * the two modes to be unmistakable, and specifically NOT distinguished by colour alone
 * — roughly one in twelve men has a colour vision deficiency, and a red-vs-grey
 * composer tells them nothing.
 *
 * So every mode change moves four independent signals: the badge TEXT, an icon, the
 * border STYLE (dashed vs solid), and the send button's WORDS. Any one of them is
 * enough on its own.
 */
export function Composer({
  conversationId,
  principalId,
  senderDisplayName,
  canReplyToCustomer,
  onSent,
  onPendingChange,
  onTyping,
  replyingTo,
  onCancelReply,
  placeholder,
}: ComposerProps): ReactNode {
  const [visibility, setVisibility] = useState<Visibility>(
    canReplyToCustomer ? 'CUSTOMER_VISIBLE' : 'INTERNAL',
  );
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Files uploaded and waiting for a message to bind them to (§28.1). */
  const [staged, setStaged] = useState<readonly StagedAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Mentions the draft currently carries, and the `@query` the caret is inside.
   *
   * Held here rather than derived from the text on send, because the OFFSETS are the point
   * — see `mention-draft.ts`. Re-deriving them by searching the body for display names is
   * how a quoted name gets marked as a mention nobody made.
   */
  const [mentions, setMentions] = useState<readonly MentionView[]>([]);
  /* Settings' one genuine chat preference. Read through a hook so turning it off in the
     panel takes effect in an already-open composer, without a reload. */
  const enterToSend = useEnterToSend();
  const [query, setQuery] = useState<MentionQuery | undefined>(undefined);
  const activeConversation = useActiveConversation();

  /**
   * Who can be mentioned here.
   *
   * The other participants, from the summary the shell already holds — so this costs no
   * request and cannot disagree with the header. `@all` is offered only in a GROUP: on a
   * one-to-one it means the one person already reading the message, and the server refuses
   * it there anyway.
   */
  const others = activeConversation?.participants ?? [];
  const isGroup = activeConversation?.conversationType === 'INTERNAL_GROUP';
  const candidates = useMemo<readonly MentionCandidate[]>(() => {
    if (query === undefined) return [];
    const term = query.term.toLowerCase();
    const people = others
      .filter((person) => person.displayName.toLowerCase().includes(term))
      .map((person) => ({ principalId: person.principalId, label: person.displayName }));
    const all =
      isGroup && 'all'.startsWith(term)
        ? [{ label: 'all', hint: `Notify everyone in this conversation` }]
        : [];
    // `@all` first: it is the one people scroll past looking for, and it is the option
    // that does not appear anywhere else.
    return [...all, ...people].slice(0, 8);
  }, [query, others, isGroup]);

  const [activeIndex, setActiveIndex] = useClampedIndex(candidates.length);

  /** The text a mention should read as, for pruning edits. */
  const labelFor = useCallback(
    (mention: MentionView): string | undefined =>
      mention.kind === 'ALL'
        ? 'all'
        : others.find((person) => person.principalId === mention.principalId)?.displayName,
    [others],
  );


  const autosaver = useMemo(() => createDraftAutosaver(400), []);
  const isInternal = visibility === 'INTERNAL';

  /**
   * Is this an INTERNAL NOTE, or just a message?
   *
   * They are not the same thing, and conflating them is what made an employee-to-employee
   * chat look like a CRM. A note is staff-only text written *inside a customer's
   * conversation* — it needs ADR-021's four signals precisely because a customer could
   * otherwise have seen it. A message between two colleagues has no customer to hide from,
   * so "🔒 Internal note — the customer cannot see this" describes nobody, and the amber
   * panel warns about nothing.
   *
   * Every note-specific control below is gated on this rather than on `isInternal`.
   *
   * Product decision, 2026-08-31: Stage 1 is employee-to-employee, and its composer is a
   * normal chat composer. This overrides the earlier requirement that the visibility
   * control stay visible on internal threads.
   */
  const isCustomerNote = canReplyToCustomer && isInternal;
  /**
   * Invariant 5, applied to the quote rather than the body.
   *
   * A customer-visible reply whose parent is an internal note would put staff-only
   * text in front of the customer through the quotation, and every other layer that
   * protects internal notes inspects the MESSAGE, not what it points at.
   */
  const quotingInternalToCustomer =
    replyingTo !== undefined && replyingTo.visibility === 'INTERNAL' && !isInternal;

  // Load the draft for this thread AND this mode. Switching mode swaps the text,
  // because a half-written internal note must never become a customer reply.
  useEffect(() => {
    let cancelled = false;
    void DraftStore.load(principalId, conversationId, visibility).then((draft) => {
      if (!cancelled) setBody(draft?.body ?? '');
    });
    return () => {
      cancelled = true;
      void autosaver.flush();
    };
  }, [conversationId, principalId, visibility, autosaver]);

  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  const handleChange = useCallback(
    (next: string) => {
      setBody(next);
      autosaver.schedule({ principalId, conversationId, body: next, visibility });
    },
    [autosaver, conversationId, principalId, visibility],
  );

  /**
   * Every edit re-checks the mentions against the text and re-reads the `@query`.
   *
   * Pruning is conservative — a mention whose characters no longer match is dropped rather
   * than adjusted. Adjusting needs a diff and gets it wrong at exactly the moments that
   * matter; a dropped mention becomes ordinary text, which is visible and harmless, where
   * a kept-but-wrong one notifies the wrong person.
   */
  const pick = useCallback(
    (candidate: MentionCandidate) => {
      const element = textareaRef.current;
      if (element === null || query === undefined) return;
      const caret = element.selectionStart ?? body.length;
      const result = insertMention(body, query, caret, mentions, candidate);
      setMentions(result.mentions);
      setQuery(undefined);
      handleChange(result.body);
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(result.caret, result.caret);
      });
    },
    [body, mentions, query, handleChange],
  );

  const onEdit = useCallback(
    (next: string, caret: number) => {
      handleChange(next);
      setMentions((current) => pruneMentions(next, current, labelFor));
      setQuery(mentionQueryAt(next, caret));
    },
    [handleChange, labelFor],
  );

  const send = useCallback(async () => {
    const text = body.trim();
    /**
     * Guarded here as well as on the button, because the keyboard does not go through it.
     *
     * "Nothing to send" is no words AND no ready file — the same rule the button uses, and
     * it has to be the same rule or the two disagree: the arrow was armed by an attachment
     * and this returned early on the empty text, so the click did nothing at all. No
     * request, no error, no explanation.
     */
    const ready = staged.filter((file) => file.state === 'READY');
    if ((text === '' && ready.length === 0) || quotingInternalToCustomer) return;

    // §19.4: an optimistic send is shown immediately, but it is shown as PENDING and it
    // is never silently dropped. A message that looks sent but never arrived is worse
    // than one that visibly failed.
    const localId = `local-${principalId}-${conversationId}-${performance.now()}`;
    /**
     * Pruned once against the text actually being sent, and reused for the optimistic row.
     *
     * The draft is pruned on every edit, but a send can be triggered from a state the
     * change handler has not seen — and a stale offset is what the server refuses, which
     * would surface as a failed send rather than as a dropped mention.
     */
    const sentMentions = pruneMentions(text, mentions, labelFor);

    // Captured before the send: `onCancelReply` clears the shared state on success, and
    // the appended message still needs to know what it answered.
    const replyTarget = replyingTo;
    /**
     * An attachment-only send still gets a row, and the row says what is actually in
     * flight. Rendering an empty bubble would look like a rendering fault; naming the
     * files is what a person needs to see while it lands.
     */
    const optimistic: PendingSend = {
      localId,
      body: text !== '' ? text : ready.map((file) => file.filename).join(', '),
      visibility,
      state: 'SENDING',
    };

    setPending((current) => [...current, optimistic]);
    setBody('');
    autosaver.cancel();
    setError(undefined);

    try {
      /**
       * §28.1 binds an attachment at SEND, because a message is what gives it reach.
       * Only files that finished uploading are offered — one still scanning or failed is
       * not sent, and the response reports which actually bound, so the text is never
       * hostage to the file (§34, invariant 9).
       */
      const readyIds = staged.filter((a) => a.state === 'READY').map((a) => a.attachmentId);

      const sent: {
        messageId: string;
        seq: number;
        createdAt: string;
        duplicate: boolean;
        attachedIds: readonly string[];
        notAttachedIds: readonly string[];
      } = await api.sendMessage(conversationId, {
        body: text,
        visibility,
        ...(readyIds.length > 0 ? { attachmentIds: readyIds } : {}),
        // The idempotency key is the local id: a retry of THIS send must not create a
        // second message (P-05 / FR-MSG-3). The field name has to match the API exactly
        // — an earlier version sent `idempotencyKey`, which the server's schema quietly
        // stripped, so every retry created a duplicate and nothing reported it.
        clientMessageId: localId,
        ...(replyTarget !== undefined ? { replyToMessageId: replyTarget.messageId } : {}),
        /**
         * Pruned once more against the text actually being sent.
         *
         * The draft is pruned on every edit, but the send can be triggered by a keyboard
         * shortcut from a state the change handler has not seen — and a stale offset is
         * exactly what the server refuses, which would surface as a failed send rather
         * than as a dropped mention.
         */
        ...(sentMentions.length > 0 ? { mentions: sentMentions } : {}),
      });
      await DraftStore.clear(principalId, conversationId, visibility);
      setMentions([]);
      setQuery(undefined);
      setPending((current) => current.filter((item) => item.localId !== localId));

      /**
       * The response decides which chips go, not the fact that the send succeeded.
       *
       * `setStaged([])` used to run here unconditionally. Combined with the composer
       * offering a file as "ready" before it was CLEAN, that is the whole defect: the
       * message went without the document, `notAttachedIds` named it, nothing read that
       * field, and the chip vanished — so the interface's last word on the subject was
       * that the file had been sent.
       *
       * Now: only the ids the server actually BOUND are cleared. Anything else stays
       * staged and says why, so the person can send it again once it is checked without
       * re-uploading — §34.4's "the user keeps their message", applied to the file.
       */
      const bound = new Set(sent.attachedIds);
      const refused = new Set(sent.notAttachedIds);

      /**
       * Files that did not go with this message AND could still go with the next one.
       *
       * Two wrong versions of this preceded the current one, and the difference between
       * them is the whole point of the message:
       *
       *   * `staged.filter(a => !bound.has(a.attachmentId))` swept in FAILED chips, so an
       *     infected file was reported as "still being checked… send it again in a moment"
       *     beside a chip saying it had not passed the virus check. Advice that cannot
       *     work, contradicting the truth next to it.
       *   * Narrowing to `readyIds` — what the server was actually asked to bind — fixed
       *     that and lost the commonest case: a file still SCANNING when the person hit
       *     send was never offered, so nothing was reported and the message went without it
       *     in silence. That is the defect this whole banner exists for.
       *
       * The correct set is "not bound, and not terminal". A FAILED chip states its own
       * reason and will never be sendable; everything else is a file the person still has
       * and can send in a moment.
       */
      const keptBack = staged.filter((a) => !bound.has(a.attachmentId) && a.state !== 'FAILED');

      setStaged((current) =>
        current
          .filter((a) => !bound.has(a.attachmentId))
          .map((a) => {
            if (!refused.has(a.attachmentId)) return a;
            // Not FAILED: the file is fine, it simply was not ready at that instant.
            // Marking it failed would tell the person to re-upload something intact.
            // `problem` is DROPPED rather than set to undefined — `exactOptionalPropertyTypes`
            // is on, and an explicitly-undefined optional is not the same as an absent one.
            const { problem: _cleared, ...rest } = a;
            return { ...rest, state: 'SCANNING' as const };
          }),
      );

      if (keptBack.length > 0) {
        // "not ready yet" rather than "still being checked": the set includes a file whose
        // bytes are still uploading as well as one awaiting a scan verdict, and naming the
        // wrong stage is the kind of small inaccuracy that makes a person distrust the rest.
        setError(
          keptBack.length === 1
            ? `Your message was sent. “${keptBack[0]?.filename ?? 'One file'}” was not attached — it was not ready yet. It stays here; send it again in a moment.`
            : `Your message was sent. ${keptBack.length} files were not attached — they were not ready yet. They stay here; send them again in a moment.`,
        );
      }

      onCancelReply?.();
      onSent({
        /*
           Carried onto the optimistic message so the thread can drop the pending row that
           produced it.

           The server echoes `clientMessageId` on the page read, but the FIRST confirmed
           copy a sender sees is this one — appended here from the send response, which
           does not include it. Without this the de-duplication only kicks in after a
           refetch, and until then the sender's own message is on screen twice.
        */
        clientMessageId: localId,
        messageId: sent.messageId,
        seq: sent.seq,
        body: text,
        visibility,
        senderPrincipalId: principalId,
        senderDisplayName: senderDisplayName,
        createdAt: sent.createdAt,
        // Carried into the appended message so the quote appears immediately, rather than
        // only after the next authoritative read. The server stored the same reference.
        ...(replyTarget !== undefined ? { replyToMessageId: replyTarget.messageId } : {}),
        /**
         * The mentions the server just accepted, for the same reason as the quote.
         *
         * Without this the message you just sent renders its mentions as plain text until
         * something triggers a re-read — so the sender sees a different message from
         * everybody else, which reads as the feature having failed. These are exactly what
         * was sent and validated: the request would have been refused otherwise, and the
         * next authoritative read replaces them with the stored copy.
         */
        ...(sentMentions.length > 0 ? { mentions: sentMentions } : {}),
        /**
         * Only what the server said it BOUND, rendered from what this client already knew.
         *
         * The optimistic row used to carry no attachments at all, so a document appeared
         * on the thread only after a reload — indistinguishable, to the person who just
         * sent it, from the file having been dropped. Building the list from `attachedIds`
         * rather than from `readyIds` is the point: this shows what the server confirmed,
         * never what the client hoped. The next authoritative read replaces it with the
         * same thing.
         */
        ...(sent.attachedIds.length > 0
          ? {
              attachments: staged
                .filter((a) => bound.has(a.attachmentId))
                .map((a) => ({
                  attachmentId: a.attachmentId,
                  filename: a.filename,
                  declaredBytes: a.declaredBytes,
                  state: 'BOUND',
                })),
            }
          : {}),
      });
    } catch (cause) {
      // Put the text back in the composer AND keep a failed marker in the thread. The
      // person's words are never lost to a network blip.
      setPending((current) =>
        current.map((item) => (item.localId === localId ? { ...item, state: 'FAILED' } : item)),
      );
      setBody(text);
      await DraftStore.save({ principalId, conversationId, body: text, visibility });
      setError(
        cause instanceof ApiError && cause.isRefusal
          ? 'This conversation is no longer available to you.'
          : 'Could not send. Your text has been kept.',
      );
      textareaRef.current?.focus();
    }
    /**
     * Every value the body above READS.
     *
     * `staged`, `replyingTo`, `onCancelReply` and `quotingInternalToCustomer` were all
     * missing, and the omission silently dropped attachments. `body` is in the list, so
     * the callback is rebuilt on every keystroke — which means attaching a file BEFORE
     * typing worked, and the normal order (type, attach, send) captured a `staged` that
     * was still empty. `readyIds` came out empty, no `attachmentIds` were sent, and line
     * 156 cleared the chips anyway: the UI reported the file as sent and the message went
     * without it.
     *
     * The same mechanism dropped `replyToMessageId` when Reply was clicked after typing,
     * and let the Ctrl+Enter path run with a stale `quotingInternalToCustomer` — bypassing
     * the guard the disabled button enforces, which is the one that stops an internal note
     * being quoted to a customer.
     *
     * There is no `react-hooks/exhaustive-deps` rule configured, so nothing reported any
     * of it. Keep this list complete by hand until there is.
     */
  }, [
    autosaver,
    body,
    conversationId,
    onCancelReply,
    onSent,
    principalId,
    quotingInternalToCustomer,
    replyingTo,
    senderDisplayName,
    staged,
    visibility,
    mentions,
    labelFor,
  ]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      /**
       * The mention picker owns these keys while it is open.
       *
       * Enter must pick a name, not send the message — a picker that lets Enter through
       * sends "@pri" to the whole group, which is the single most annoying way this
       * feature can fail. Checked before anything else for that reason.
       */
      if (query !== undefined && candidates.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((activeIndex + 1) % candidates.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((activeIndex - 1 + candidates.length) % candidates.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const chosen = candidates[activeIndex];
          if (chosen !== undefined) pick(chosen);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setQuery(undefined);
          return;
        }
      }

      if (event.key !== 'Enter') return;

      /**
       * Enter sends on a colleague thread; Ctrl/Cmd+Enter is required on a customer one.
       *
       * The rule differs because the cost of a mistake differs. Every chat application a
       * person uses sends on Enter, and forcing a chord on an internal thread fights that
       * habit all day for no benefit — there is nobody outside the company on the other
       * end. A half-written reply landing in front of a CUSTOMER is a different kind of
       * mistake, and that composer keeps the chord.
       *
       * Shift+Enter always inserts a newline, on both.
       */
      const chord = event.ctrlKey || event.metaKey;
      if (event.shiftKey) return;
      /**
       * ...unless the person has turned that off in Settings, in which case the colleague
       * thread behaves like the customer one: Enter is a newline and the chord sends. The
       * preference cannot reach the customer composer, where the chord is a safety
       * property rather than a habit (see above) and is not somebody's to disable.
       */
      if (chord || (!canReplyToCustomer && enterToSend)) {
        event.preventDefault();
        void send();
      }
    },
    [send, canReplyToCustomer, enterToSend, query, candidates, activeIndex, setActiveIndex, pick],
  );

  /**
   * Is a send in flight?
   *
   * The button says so rather than merely going quiet: the optimistic row appears at the
   * bottom of a thread the reader may not be looking at, so without this the composer
   * gives no feedback at all between the click and the response.
   */
  const sending = pending.some((item) => item.state === 'SENDING');
  /**
   * "Nothing to send" means no words AND no file.
   *
   * The send control was disabled on empty TEXT alone, so staging a document and then
   * clicking the arrow did nothing at all — no error, no explanation, a control that
   * looked live and was not. Sending a file with no covering note is an ordinary thing to
   * do in a chat, and the server accepts it: `messages.body` is nullable, and the schema
   * now admits an empty body when at least one attachment is bound.
   *
   * A file still being scanned does NOT arm the button. §28.1 refuses to bind anything but
   * a CLEAN attachment, so a send in that window would go without it — which is the one
   * outcome worse than waiting.
   */
  const readyFiles = staged.filter((file) => file.state === 'READY');
  const empty = body.trim() === '' && readyFiles.length === 0;

  return (
    <div className={`composer${isCustomerNote ? ' internal' : ''}`}>
      {/*
        UC-E16. What is being replied to is shown while composing, because the reply is
        only meaningful relative to it - and because a reply aimed at the wrong message is
        invisible once sent.

        The internal-note warning is the part that matters. Quoting a staff-only note in a
        CUSTOMER_VISIBLE reply would reproduce that text where the customer can read it,
        which invariant 5 forbids - so the pairing is refused here, before it can be sent,
        rather than being caught downstream.
      */}
      {replyingTo !== undefined ? (
        <div className="replying-to" role="status">
          <span className="replying-to-text">
            Replying to <strong>{replyingTo.senderDisplayName}</strong>
            {/* The note qualifier belongs to a customer conversation only — on a colleague
                thread every message is internal and the words describe nobody. */}
            {canReplyToCustomer && replyingTo.visibility === 'INTERNAL' ? (
              <span style={{ color: 'var(--warn-text)', fontWeight: 700 }}> · internal note</span>
            ) : null}
            {': '}
            <span className="replying-to-quote">
              {replyingTo.body.length > 90 ? `${replyingTo.body.slice(0, 90)}…` : replyingTo.body}
            </span>
          </span>
          <button
            type="button"
            className="replying-to-cancel"
            onClick={() => onCancelReply?.()}
            aria-label="Cancel reply"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}

      {quotingInternalToCustomer ? (
        <p role="alert" style={{ color: 'var(--danger)', margin: '0 0 8px', fontSize: 13 }}>
          You are replying to an internal note. Switch to Internal note, or cancel the reply -
          a customer-visible reply must not quote staff-only content.
        </p>
      ) : null}

      {/*
        Two audiences to choose between, or no control at all. On an internal thread there
        is one audience, so a radiogroup here would be a switch that cannot be switched.
      */}
      {canReplyToCustomer ? (
        <div role="radiogroup" aria-label="Message visibility">
          <ModeButton
            selected={!isInternal}
            onSelect={() => setVisibility('CUSTOMER_VISIBLE')}
            icon="↗"
            label="Reply to customer"
          />
          <ModeButton
            selected={isInternal}
            onSelect={() => setVisibility('INTERNAL')}
            icon="🔒"
            label="Internal note"
          />
        </div>
      ) : null}

      {/* ADR-021 signals 1 and 2: explicit words plus an icon, never inferred from
          styling, announced via aria-live on mode change. Rendered only when the text
          could actually reach a customer — on a colleague thread it would be a warning
          about a reader who does not exist. */}
      {canReplyToCustomer ? (
        <p
          aria-live="polite"
          style={{
            margin: '0 0 6px',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: isInternal ? 'var(--warn-text)' : 'var(--text-muted)',
          }}
        >
          {isInternal ? '🔒 Internal note — the customer cannot see this' : '↗ Visible to the customer'}
        </p>
      ) : null}


      {/*
        SL-054/055/056. Below the input rather than beside it: a file is attached TO a
        message, and §28.1 makes that relationship the thing that gives it reach. The
        picker renders its own control and its staged-file list; the sheet makes the
        control an icon-sized button on the action row.
      */}
      {/*
        The member list, above the composer rather than below it: the composer is already
        at the bottom of the screen, and a list opening downward would be off it.
      */}
      {query !== undefined ? (
        <MentionPicker candidates={candidates} active={activeIndex} onPick={pick} />
      ) : null}

      {/*
        One row: attach, field, send — where the field carries the input and the emoji
        control together. The attachment picker also renders the staged-file list, which the
        grid places on a row above; see the stylesheet, which owns these tracks and is the
        only place that may set them.
      */}
      <div className="composer-actions">

        {/*
          Three siblings on one row: attach, the field, send.

          They used to be nested — attach and send INSIDE the field — because the desktop
          reference draws one rounded box with all of it inside. The phone draws the opposite:
          a round attach and a round send OUTSIDE a pill. Nesting can only become un-nesting
          in the markup, so the three are siblings at every width and the STYLESHEET puts the
          box around all of them at the rail widths and around the field alone on a phone.

          The picker also renders the staged-file list, which `display: contents` lifts onto
          its own grid row above.
        */}
        <AttachmentPicker
          conversationId={conversationId}
          staged={staged}
          onStagedChange={setStaged}
        />

        <div className="composer-field">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => {
            onEdit(event.target.value, event.target.selectionStart ?? event.target.value.length);
            // Unthrottled here on purpose: the gateway floors the rate per socket,
            // where a client cannot remove the limit (§20.10).
            onTyping?.(visibility);
          }}
          /* Moving the caret changes which mention you are inside, without changing text. */
          onSelect={(event) => {
            const element = event.currentTarget;
            setQuery(mentionQueryAt(element.value, element.selectionStart ?? 0));
          }}
          onBlur={() => {
            void autosaver.flush();
            // Closed on blur so the list cannot outlive the field it belongs to. The
            // picker's own `onMouseDown` prevents the blur, so a click still lands.
            setQuery(undefined);
          }}
          onKeyDown={onKeyDown}
          rows={1}
          className="composer-input"
          aria-label={
            !canReplyToCustomer
              ? 'Message'
              : isInternal
                ? 'Internal note body'
                : 'Reply to customer body'
          }
          placeholder={
            placeholder ??
            (!canReplyToCustomer
              ? 'Type a message…'
              : isInternal
                ? 'Note for colleagues only…'
                : 'Reply to the customer…')
          }
          style={{
            // Only the note border is inline: it is state, and the rest is in the sheet.
            // ADR-021 signal 3 — the border STYLE differs, so a note survives a greyscale
            // screenshot. A colleague message is not a note and takes the ordinary border.
            ...(isCustomerNote ? { border: '2px dashed var(--warn-border)' } : {}),
          }}
        />

        {/*
          Emoji inserts a character into the same field every other character goes into.
          It implies no reaction, no status and no notification — none of which the API
          supports — so it adds a capability rather than a claim.
        */}
        <EmojiPicker
          onPick={(emoji) => {
            const el = textareaRef.current;
            if (el === null) {
              handleChange(`${body}${emoji}`);
              return;
            }
            /**
             * Inserted at the CARET, not appended.
             *
             * Appending is the one-line version and it is wrong the moment somebody adds an
             * emoji mid-sentence — which is most of the time, because they have just
             * finished a clause and want it there. The selection is restored after the
             * insert so typing continues where the emoji ended.
             */
            const start = el.selectionStart ?? body.length;
            const end = el.selectionEnd ?? body.length;
            const next = `${body.slice(0, start)}${emoji}${body.slice(end)}`;
            handleChange(next);
            requestAnimationFrame(() => {
              el.focus();
              const caret = start + emoji.length;
              el.setSelectionRange(caret, caret);
            });
          }}
        />


        </div>

        {/*
          A round icon button on a colleague thread; a named button in a customer
          conversation.

          ADR-021 signal 4 is that the ACTION IS NAMED DIFFERENTLY when it can reach a
          customer, and an icon cannot carry a name — so the icon form is used only where
          there is one audience and nothing to distinguish. On an internal thread the
          accessible name is still "Send"; it is the visible label that becomes a glyph.
        */}
        <button
          type="button"
          className={`composer-send${canReplyToCustomer ? '' : ' icon'}`}
          onClick={() => void send()}
          disabled={empty || quotingInternalToCustomer || sending}
          aria-label={canReplyToCustomer ? undefined : 'Send'}
        >
          {canReplyToCustomer ? (
            isInternal ? (
              'Save internal note'
            ) : (
              'Send to customer'
            )
          ) : (
            /* An arrow UP, as the reference draws it — not a paper plane. On a colleague
               thread the button has no words, so the glyph is the whole label, and "up" is
               the one every messaging application uses for send. */
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path
                d="M12 19.5V5m0 0-6.5 6.5M12 5l6.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>

      {/*
        No keyboard caption.

        There was a line under the field reading "Enter to send · Shift + Enter for a new
        line". It is true, and it is the kind of true that only needs saying once: everybody
        who uses a chat product already presses Enter, the people who do not are not reading
        a 12px caption to find out, and it cost a permanent row under a control that is on
        screen all day. The behaviour is unchanged — see `onKeyDown` above.
      */}

      {error !== undefined ? (
        <p role="alert" className="composer-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ModeButton({
  selected,
  onSelect,
  icon,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: string;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        padding: '5px 10px',
        borderRadius: 'var(--radius)',
        border: selected ? '2px solid var(--text)' : '1px solid var(--border)',
        background: selected ? 'var(--surface-2)' : 'transparent',
        color: 'var(--text)',
        fontWeight: selected ? 700 : 400,
      }}
    >
      <span aria-hidden="true">{icon} </span>
      {label}
    </button>
  );
}
