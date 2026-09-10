'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type AttachmentView } from '../lib/api-client';
import { extensionOf, formatBytes } from './attachment-picker';
import { AttachmentMedia, mediaKindOf } from './attachment-media';
import { VoiceNote, isVoiceNote } from './voice-note';
import { AvatarImage } from './avatar-image';
import { deliveryTick, type DeliveryTick } from '@starlink/shared-contracts';
import { initialsFor } from './conversation-naming';
import { distinctIdentityHues, identityStyleFrom } from '../lib/identity-colour';
import { crossesDay, daySeparatorLabel, unreadDividerIndex } from './timeline';
import { splitBody } from '../lib/mention-draft';
import { MessageActions } from './message-actions';
import { MessageContextMenu } from './message-context-menu';
import { ReactionDetails } from './reaction-details';

import type { MessageView } from '../lib/api-client';
import type { PendingSend } from './composer';

interface MessageListProps {
  readonly messages: readonly MessageView[];
  readonly pending: readonly PendingSend[];
  readonly currentPrincipalId: string;
  readonly onRetry?: ((localId: string) => void) | undefined;
  /** UC-E16. Absent means the surface offers no reply control at all. */
  readonly onReply?: ((message: MessageView) => void) | undefined;
  /**
   * Does this conversation have a customer on the other end?
   *
   * ## Why the timeline needs to know
   *
   * Every message in a colleague thread is `INTERNAL` by construction — there is no
   * customer to make anything visible to. So the ADR-021 note treatment matched all of
   * them, and an internal conversation rendered as an unbroken column of amber dashed
   * boxes each captioned "NOT VISIBLE TO CUSTOMER". Forty warnings about a customer who
   * does not exist, on the product's main screen.
   *
   * A warning that fires on every message is not a warning. It costs the thread its
   * sent/received distinction too: `.message-row.internal` overrides `.mine`, so nothing
   * in an internal thread showed who said what by position. This is the same correction
   * already applied to the composer, in the other component that reads visibility.
   *
   * ## Fail-closed
   *
   * The flag says the conversation IS internal, not that it is customer-facing, so the
   * default and the unknown case both keep the marking. A caller that has not resolved
   * the conversation kind yet passes `false` and gets the safe rendering.
   */
  readonly conversationIsInternal?: boolean;

  /**
   * Whether more than two people can speak here.
   *
   * It decides one thing: whether a colleague's name is DRAWN above their words. In a group
   * the name is the only thing separating two colleagues; in a one-to-one there is exactly
   * one other person, their name is in the header and their face is in the gutter, and
   * repeating it above every bubble is a third copy of an answer nobody asked twice.
   *
   * The name is never removed from the accessibility tree either way — a screen reader has
   * neither the header's context nor the gutter's avatar.
   */
  readonly isGroup?: boolean;

  /**
   * How many messages were unread when this conversation was opened, for the "New" rule.
   *
   * Frozen by the caller at mount. Opening a conversation marks it read, so the live
   * value collapses to zero almost immediately and a divider driven by it would appear
   * and then vanish under the reader.
   */
  readonly unreadOnOpen?: number;
  /** Toggles one of the reader's own reactions. Absent means the surface offers none. */
  readonly onReact?: ((messageId: string, emoji: string, on: boolean) => void) | undefined;
  readonly onEdit?: ((message: MessageView) => void) | undefined;
  /** The message currently being corrected in place, if any. */
  readonly editingMessageId?: string | undefined;
  /** Commit the correction. The caller decides what "unchanged" means and may ignore it. */
  readonly onSubmitEdit?: ((message: MessageView, body: string) => void) | undefined;
  readonly onCancelEdit?: (() => void) | undefined;
  /** Message ids currently pinned for everybody in the conversation. */
  readonly pinnedIds?: ReadonlySet<string> | undefined;
  readonly onTogglePin?: ((message: MessageView, next: boolean) => void) | undefined;
  readonly onForward?: ((message: MessageView) => void) | undefined;
  readonly onToggleStar?: ((message: MessageView, next: boolean) => void) | undefined;
  /** Needed to fetch who reacted, which is a per-message read the page does not carry. */
  readonly conversationId?: string | undefined;
  readonly participants?: readonly { principalId: string; displayName: string }[] | undefined;
  readonly onMessageInfo?: ((message: MessageView) => void) | undefined;
  /**
   * How far every OTHER participant has read. Zero means nobody, or somebody has not.
   *
   * One number for the whole thread rather than a flag per message, because that is what
   * the state actually is: a per-participant watermark, minimised. See `read-receipts.ts`
   * in the domain package for why it is a minimum and why it resolves downward.
   */
  readonly readWatermark?: number;
}

/**
 * Thread view.
 *
 * Internal notes and customer-visible messages sit in the SAME timeline — they are one
 * conversation, and splitting them into tabs is how people lose the thread of what was
 * actually said to the customer. But an internal note must be unmistakably marked
 * wherever it appears (ADR-021, NFR-ACC-3), by text and shape rather than colour alone.
 */
export function MessageList({
  messages,
  pending,
  currentPrincipalId,
  onRetry,
  onReply,
  conversationIsInternal = false,
  isGroup = false,
  unreadOnOpen = 0,
  onReact,
  onEdit,
  editingMessageId,
  onSubmitEdit,
  onCancelEdit,
  pinnedIds,
  onTogglePin,
  onForward,
  onToggleStar,
  conversationId,
  participants,
  onMessageInfo,
  readWatermark = 0,
}: MessageListProps): ReactNode {
  if (messages.length === 0 && pending.length === 0) {
    return (
      <div className="thread-empty">
        <p className="state-note">
          <strong>No messages yet</strong>
          Say hello — this is the beginning of the conversation.
        </p>
      </div>
    );
  }

  /**
   * One colour each, for the people in THIS thread.
   *
   * Built from the senders actually present rather than from the participant list: a group
   * of forty with four people talking should spend four colours, not four out of forty. The
   * hash alone cannot promise distinctness - nine hues and five speakers collide 41% of the
   * time - so `distinctIdentityHues` settles it, deterministically and independently of the
   * order the messages arrived in.
   *
   * Memoised on the sender ids, so scrolling, reacting and a new message from somebody
   * already here do not rebuild it.
   */
  const senderKey = messages
    .map((m) => m.senderPrincipalId ?? '')
    .filter((id) => id !== '')
    .sort()
    .join(',');
  const identityHues = useMemo(
    () => distinctIdentityHues(senderKey === '' ? [] : senderKey.split(',')),
    [senderKey],
  );

  const dividerAt = unreadDividerIndex(messages, currentPrincipalId, unreadOnOpen);

  return (
    <ol aria-label="Messages" className="thread">
      {messages.map((message, index) => (
        <Fragment key={message.messageId}>
          {/*
            Separators are list items, not wrappers. An `<ol>` may only contain `<li>`, and
            a `<div>` between the rows would put the browser's own error recovery between
            a screen reader and the thread.
          */}
          {crossesDay(messages[index - 1], message) ? (
            <li className="day-separator" role="separator">
              <span>{daySeparatorLabel(message.createdAt)}</span>
            </li>
          ) : null}

          {index === dividerAt ? (
            <li className="unread-separator" role="separator" aria-label="New messages">
              <span>New</span>
            </li>
          ) : null}

        <MessageRow
          readWatermark={readWatermark}
          message={message}
          /* A separator ends the turn: a name and a time under a date rule that the
             reader has just crossed is the point of the rule. */
          grouped={
            !crossesDay(messages[index - 1], message) &&
            index !== dividerAt &&
            continuesTurn(messages[index - 1], message)
          }
          isMine={message.senderPrincipalId === currentPrincipalId}
          /**
           * UC-E16: the quoted parent is resolved from the page already in hand rather
           * than fetched. A reply to something scrolled out of view resolves to nothing
           * and renders as a plain reference - honest, and no extra read.
           */
          repliedTo={
            message.replyToMessageId === undefined
              ? undefined
              : messages.find((m) => m.messageId === message.replyToMessageId)
          }
          onReply={onReply}
          pinnedIds={pinnedIds}
          onTogglePin={onTogglePin}
          onForward={onForward}
          onToggleStar={onToggleStar}
          conversationId={conversationId}
          participants={participants}
          onMessageInfo={onMessageInfo}
          conversationIsInternal={conversationIsInternal}
          isGroup={isGroup}
          currentPrincipalId={currentPrincipalId}
          onReact={onReact}
          onEdit={onEdit}
          identityHues={identityHues}
          editingMessageId={editingMessageId}
          onSubmitEdit={onSubmitEdit}
          onCancelEdit={onCancelEdit}
        />
        </Fragment>
      ))}
      {pending.map((item) => (
        <PendingRow
          key={item.localId}
          pending={item}
          onRetry={onRetry}
          conversationIsInternal={conversationIsInternal}
        />
      ))}
    </ol>
  );
}

/**
 * Does this message continue the previous author's turn?
 *
 * A run of messages from one person within a few minutes is one turn of the conversation,
 * and repeating the name and timestamp on each line is noise the eye has to filter. When
 * this is true the row tightens against the one above and drops its meta line.
 *
 * Visibility is part of the comparison, not an afterthought: an internal note following a
 * customer-visible reply from the same author is a DIFFERENT kind of statement, and
 * merging the two into one visual block is exactly the confusion ADR-021 exists to
 * prevent. A note always starts its own turn.
 */
const TURN_WINDOW_MS = 5 * 60 * 1000;

/**
 * A message being corrected, in place.
 *
 * Enter commits and Shift+Enter adds a line, matching the composer — a person editing a
 * message is in the same mode of thought they were in when they wrote it, and two different
 * meanings for one key in one thread is the kind of detail that makes software feel
 * arbitrary. Escape cancels, and so does clicking away.
 *
 * The textarea grows with its content rather than scrolling inside three fixed rows: a
 * correction to a long message must show the long message, or the person is editing
 * something they cannot see.
 */
function MessageEditor({
  message,
  onSubmit,
  onCancel,
}: {
  readonly message: MessageView;
  readonly onSubmit: (body: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {

  const [text, setText] = useState(message.body);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const field = ref.current;
    if (field === null) return;
    field.focus();
    /* Caret at the END, not selecting everything. A correction is usually a word at the
       end or a typo in the middle; select-all means the first keystroke destroys the
       message, which is the one outcome an edit must not make easy. */
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  /* Grown on every change rather than on mount alone, so pasting a paragraph in opens the
     field rather than hiding it behind a scrollbar. */
  useEffect(() => {
    const field = ref.current;
    if (field === null) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 260)}px`;
  }, [text]);

  const commit = (): void => {
    const next = text.trim();
    if (next === '' || next === message.body) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <div className="message-editing">
      <textarea
        ref={ref}
        className="message-edit-field"
        value={text}
        rows={1}
        aria-label="Edit this message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            commit();
          }
        }}
      />
      <div className="message-edit-actions">
        <span className="message-edit-hint">Enter to save · Esc to cancel</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={commit}>
          Save
        </button>
      </div>
    </div>
  );
}

function continuesTurn(previous: MessageView | undefined, current: MessageView): boolean {
  if (previous === undefined) return false;
  if (previous.senderPrincipalId !== current.senderPrincipalId) return false;
  if (previous.visibility !== current.visibility) return false;
  // A quoted reply re-opens a turn: it is answering something specific and needs its own
  // header to say who is answering and when.
  if (current.replyToMessageId !== undefined) return false;
  const gap = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(gap) && gap >= 0 && gap < TURN_WINDOW_MS;
}

function MessageRow({
  message,
  isMine,
  grouped,
  repliedTo,
  onReply,
  conversationIsInternal,
  isGroup,
  currentPrincipalId,
  onReact,
  onEdit,
  identityHues,
  editingMessageId,
  onSubmitEdit,
  onCancelEdit,
  pinnedIds,
  onTogglePin,
  onForward,
  onToggleStar,
  conversationId,
  participants,
  onMessageInfo,
  readWatermark,
}: {
  message: MessageView;
  isMine: boolean;
  grouped: boolean;
  repliedTo: MessageView | undefined;
  // `| undefined` explicitly: `exactOptionalPropertyTypes` makes "absent" and
  // "present but undefined" different types, and the caller passes the property.
  onReply?: ((message: MessageView) => void) | undefined;
  conversationIsInternal: boolean;
  isGroup: boolean;
  currentPrincipalId: string;
  onReact?: ((messageId: string, emoji: string, on: boolean) => void) | undefined;
  onEdit?: ((message: MessageView) => void) | undefined;
  /** @see MessageList - one hue per speaker, distinct within this conversation. */
  identityHues: ReadonlyMap<string, number>;
  editingMessageId?: string | undefined;
  onSubmitEdit?: ((message: MessageView, body: string) => void) | undefined;
  onCancelEdit?: (() => void) | undefined;
  pinnedIds?: ReadonlySet<string> | undefined;
  onTogglePin?: ((message: MessageView, next: boolean) => void) | undefined;
  onForward?: ((message: MessageView) => void) | undefined;
  onToggleStar?: ((message: MessageView, next: boolean) => void) | undefined;
  conversationId?: string | undefined;
  participants?: readonly { principalId: string; displayName: string }[] | undefined;
  onMessageInfo?: ((message: MessageView) => void) | undefined;
  readWatermark: number;
}): ReactNode {
  /**
   * A note is only a note when something else in the same thread is not one.
   *
   * `visibility === 'INTERNAL'` is true of every message in a colleague thread, so on its
   * own it marks nothing — see the prop's own note. The distinction ADR-021 protects is
   * between a staff note and a customer-visible reply sitting in ONE timeline, and that
   * timeline only exists on a customer conversation.
   */
  /**
   * A system note about the conversation itself, not a message in it.
   *
   * Screen 03 draws it as a centred pill on the thread's own ground: no bubble, no avatar,
   * no stamp, no actions. Returned early rather than branched through the row below, because
   * almost nothing in that row applies — a reaction to "Neha added Vikram" is not a thing,
   * and neither is a reply to it.
   */
  if (message.messageClass === 'MEMBERSHIP') {
    return (
      <li className="message-system">
        <span>{message.body}</span>
      </li>
    );
  }

  const isCustomerNote = !conversationIsInternal && message.visibility === 'INTERNAL';

  /**
   * A colleague's message in a GROUP opens with their name and the time, above the bubble.
   *
   * This is the design's second message shape, not a variation on the first. In a one-to-one
   * the bubble carries the words and the time sits under it; in a channel the reference puts
   * "Arjun Sethi 09:44" on a line above and squares the bubble's TOP-left corner instead of
   * its bottom-left — the tail points up at the name it belongs to.
   *
   * Only on the first message of a turn. A run of four from one person needs one name, and
   * repeating it makes the run look like four separate people who happen to share one.
   */
  const showHead = isGroup && !isMine && !grouped;

  /** Where the context menu was summoned, or absent when it is closed. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | undefined>();
  /**
   * An in-flight touch long-press: where it began, and the timer that will open the menu.
   *
   * A ref rather than state — it changes on every pointer move and must not re-render a
   * row of a list that can be hundreds long.
   */
  const longPress = useRef<
    { from: { x: number; y: number }; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);

  /* A row can unmount mid-press — a re-fetch replaces the list — and a timer that fires
     afterwards would open a menu for a message no longer on screen. */
  useEffect(
    () => () => {
      if (longPress.current !== undefined) clearTimeout(longPress.current.timer);
    },
    [],
  );
  /** Which chip's detail panel is open, if any. */
  /*
     Which chip was asked about, AND where that chip is.

     The emoji alone was not enough. The panel was positioned at the message stack's edge,
     so on a message carrying three chips all three opened the same panel in the same place
     — measured at x 1152..1412 whichever of them was pressed, which is a panel that answers
     a question without saying which one it answered. The offset travels with the emoji so
     the panel can point at the thing that opened it.
  */
  const [detailsFor, setDetailsFor] = useState<
    { readonly emoji: string; readonly left: number; readonly caret: number } | undefined
  >();

  return (
    <li
      className={`message-row${isCustomerNote ? ' internal' : ''}${isMine ? ' mine' : ''}${
        grouped ? ' grouped' : ''
      }${showHead ? ' with-head' : ''}${
        message.redactedAt === undefined && isSoleEmoji(message.body) ? ' sole-emoji' : ''
      }${
        /*
           A message that is ONLY a picture, decided here rather than in CSS.

           The stylesheet tried `:not(:has(.message-body:not(:empty)))` and never matched:
           `.message-body` renders mention-split spans, so it has child nodes and is not
           `:empty` even when the text is blank. The component knows the difference between
           "no words" and "an element containing no words", and it is the only one that
           does.
        */
        message.body.trim() === '' &&
        (message.attachments ?? []).some((file) => mediaKindOf(file) !== undefined)
          ? ' media-only'
          : ''
      }`}
      /* The anchor the pinned bar scrolls to. An id attribute rather than a ref map: the
         list is virtualised by nothing and remounts freely, and a map of refs would need
         clearing on every page load to avoid pointing at detached nodes. */
      data-message-id={message.messageId}
      /*
        Right-click opens the message's actions — see `message-context-menu.tsx`.

        On the ROW rather than on the bubble, so the whole line responds: aiming at a
        two-character bubble to reach a menu is a target the size of the word "hi".

        A deleted message has nothing to copy, reply to, edit or delete again, so it keeps
        the browser's own menu rather than offering four items attached to an absence.
      */
      onContextMenu={(event) => {
        if (message.redactedAt !== undefined) return;
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
      /*
         The same menu, from a long press.

         On a phone there was no way to reach any of this. `contextmenu` is not dispatched
         by a touch long-press on Android Chrome, and iOS Safari answers it with its own
         selection callout — so Reply, Copy, Forward, Pin, Save, Edit, Delete and Message
         info were all unreachable, which is most of what the product does with a message.
         Tapping did nothing either; the react button was the only control a finger could
         find.

         Held for 500ms, cancelled by movement. The movement check is what keeps this from
         eating scrolls: a finger that travels more than ten pixels is scrolling the thread,
         not pressing a message, and the timer is dropped without opening anything.
      */
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || message.redactedAt !== undefined) return;
        const start = { x: event.clientX, y: event.clientY };
        longPress.current = {
          from: start,
          timer: setTimeout(() => {
            longPress.current = undefined;
            setMenuAt(start);
          }, 500),
        };
      }}
      onPointerMove={(event) => {
        const held = longPress.current;
        if (held === undefined) return;
        const moved =
          Math.abs(event.clientX - held.from.x) + Math.abs(event.clientY - held.from.y);
        if (moved <= 10) return;
        clearTimeout(held.timer);
        longPress.current = undefined;
      }}
      onPointerUp={() => {
        if (longPress.current === undefined) return;
        clearTimeout(longPress.current.timer);
        longPress.current = undefined;
      }}
      onPointerCancel={() => {
        if (longPress.current === undefined) return;
        clearTimeout(longPress.current.timer);
        longPress.current = undefined;
      }}
      /*
         The same menu, from the keyboard.

         Reply used to be a button on the hover bar and is now only in this menu, so a menu
         that opens on right-click alone would put Reply, Edit and Delete out of reach of
         anybody not using a mouse — NFR-ACC-1 requires the product to be fully operable
         from a keyboard, and "fully" is doing real work in that sentence.

         `ContextMenu` is the dedicated key; `Shift+F10` is what keyboards without one use,
         and what most screen-reader users press by habit. The handler sits on the ROW and
         catches the event as it bubbles from whatever inside it has focus — in practice
         the react button, which is already a tab stop. That is deliberately not the same
         as making every message focusable: a thread of two hundred messages would then be
         two hundred tab stops between the list and the composer.

         Anchored to the focused element's own rect rather than to a pointer that was never
         used, so the menu opens beside the control the person can see.
      */
      onKeyDown={(event) => {
        if (message.redactedAt !== undefined) return;
        const wanted = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
        if (!wanted) return;
        event.preventDefault();
        const box = (event.target as HTMLElement).getBoundingClientRect();
        setMenuAt({ x: box.left, y: box.bottom });
      }}
    >
      {/*
        An avatar gutter on the left, filled once per turn.

        The gutter is reserved on grouped rows too — an empty column, not a missing one —
        so a run of messages from one person stays aligned instead of stepping left under
        its own first line. Own messages sit right and take no gutter: position already
        says who wrote them, and a picture of yourself on every line you send is noise.
      */}
      {!isMine ? (
        <span
          className={`message-avatar${grouped ? '' : ' identity'}`}
          aria-hidden="true"
          /* The whole pair, not just the ink. This used to set `color` alone over a fixed
             `--accent-soft` circle, so the same person was a blue R here and a brick R in
             the list — on an identical pink disc in both. */
          style={grouped ? undefined : identityStyleFrom(identityHues, message.senderPrincipalId)}
        >
          {grouped ? '' : initialsFor(message.senderDisplayName)}
          {/*
            The person's actual PHOTO, over the initials.

            The initials were the whole avatar here, so somebody who had set a profile
            picture saw it in the chat header and in the conversation list and then two
            letters beside every line they wrote. `AvatarImage` renders nothing when there
            is no picture, so the initials underneath are the fallback rather than a
            competing layer - the same arrangement the list row and the header already use.
          */}
          {grouped ? null : <AvatarImage principalId={message.senderPrincipalId} alt="" />}
        </span>
      ) : null}

      {/*
        The bubble, and above it in a group, the author's name.

        The time and the ticks are INSIDE the bubble now — see `.bubble-meta` below. They
        were on a line underneath it, which is what the reference draws, and which costs a
        whole row of vertical rhythm per message and puts the receipt further from the words
        it is about. Inside is what every messenger does and what people read without
        being taught.
      */}
      <div className="message-stack">
      {/*
        Name and time above the bubble, in a group, once per turn.

        Outside `.message-main` because it is not part of the bubble in the design — it sits
        on the page above it, at the bubble's left edge.
      */}
      {showHead ? (
        <div className="message-head">
          <strong
            className="author identity-ink"
            /* A stable hue per person, so "who said this" is a glance rather than a read
               in a group. Never the only signal — the name is right there. */
            style={identityStyleFrom(identityHues, message.senderPrincipalId)}
          >
            {message.senderDisplayName}
          </strong>
        </div>
      ) : null}
      <div className="message-main">
        {/*
          The name for a screen reader whenever it is not drawn.

          Position, tint and the conversation header carry "who said this" for a sighted
          reader in a one-to-one, and the turn's own heading carries it in a group. None of
          those reach an assistive technology, and "who said this" is not optional — so on
          every row that does not draw the name, it is present and hidden.
        */}
        <div className="message-meta">
          {!showHead ? (
            <strong className="author sr-only">
              {message.senderDisplayName}
              {isMine ? ' (you)' : null}
            </strong>
          ) : null}
          {isCustomerNote ? (
            <span className="internal-flag">
              <span aria-hidden="true">🔒 </span>INTERNAL — NOT VISIBLE TO CUSTOMER
            </span>
          ) : null}
        </div>
      {/*
        UC-E16's quote. The parent's own visibility label travels with it: quoting an
        internal note inside a customer-visible reply would otherwise reproduce staff-only
        text in a message bound for the customer, and the quote must never be the thing
        that launders it. The composer refuses that pairing outright (see `composer.tsx`);
        this is the second place it is visible.
      */}
      {message.replyToMessageId !== undefined ? (
        <blockquote className="quoted">
          {repliedTo === undefined ? (
            <span>Replying to an earlier message</span>
          ) : (
            <>
              <strong style={{ fontWeight: 600 }}>{repliedTo.senderDisplayName}</strong>{' '}
              {!conversationIsInternal && repliedTo.visibility === 'INTERNAL' ? (
                <span style={{ color: 'var(--warn-text)', fontWeight: 700 }}>[internal] </span>
              ) : null}
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {repliedTo.body.length > 140 ? `${repliedTo.body.slice(0, 140)}…` : repliedTo.body}
              </span>
            </>
          )}
        </blockquote>
      ) : null}

      {/*
        Mentions are rendered from the STORED offsets, never by searching the body for a
        name. Searching is how "@Priya Nair" inside a quotation gets marked as a mention
        nobody made, and how two colleagues with one name become indistinguishable.

        `splitBody` tolerates a malformed array by rendering it as plain text: a thread
        that fails to render is worse than one that misses a highlight.
      */}
      {/*
        A deleted message says so.
        
        The row survives with an empty body, so without this it renders as an empty bubble
        — which reads as a rendering fault rather than as somebody's decision. The wording
        is passive because who deleted it is not on the page: the sender is the only person
        who can, and they already know.
      */}
      {message.redactedAt !== undefined ? (
        <div className="message-body message-deleted">
          <span aria-hidden="true">🚫 </span>This message was deleted
        </div>
      ) : editingMessageId === message.messageId && onSubmitEdit !== undefined ? (
        /*
           Correcting a message happens IN the message.

           It used to be `window.prompt`, whose own comment called it deliberate and
           temporary: an inline editor "has to grow, keep the caret, handle Escape and Enter,
           preserve mentions across the edit and reconcile with the optimistic row". All
           true, and all cheaper than what the prompt actually costs — a modal dialog drawn
           by the browser, titled with the origin ("localhost:3010 says"), which blocks the
           page, cannot be styled, and looks to a person exactly like the alert a website
           shows when something has gone wrong.

           The mentions survive because the SERVER re-parses them from the text (see
           `revise-message.ts`); the client never had to preserve them, which was the part
           that looked expensive.
        */
        <MessageEditor
          message={message}
          onSubmit={(body) => onSubmitEdit(message, body)}
          onCancel={() => onCancelEdit?.()}
        />
      ) : (
      <div className="message-body">
        {splitBody(message.body, message.mentions ?? []).map((part, index) =>
          part.mention === undefined ? (
            // Positional split of one string; the index is the only identity these have.
            <span key={`t${index}`}>{part.text}</span>
          ) : (
            <span
              key={`m${index}`}
              className={`mention${part.mention.kind === 'ALL' ? ' mention-all' : ''}${
                part.mention.kind === 'PRINCIPAL' && part.mention.principalId === currentPrincipalId
                  ? ' mention-me'
                  : ''
              }`}
            >
              {part.text}
            </span>
          ),
        )}
      </div>
      )}

      {/*
        SL-054's read half, INSIDE the bubble.

        §34.4: the conversation shows THAT a file exists — its absence must be legible
        rather than mysterious. It belongs in the bubble because the file is the message,
        not an annotation on it; hanging it below meant an attachment-only message rendered
        as an empty bubble with a chip loose underneath it.

        The download URL is fetched on demand, one object at a time, because issuing it is
        an audited act (FR-ATT-5) and a list render must not perform fifty of them.
      */}
      {message.attachments !== undefined && message.attachments.length > 0 ? (
        <ul className="attachments" aria-label="Attached files">
          {message.attachments.map((file) => {
            /*
               A picture is shown; everything else is listed.

               `mediaKindOf` decides from the SNIFFED content type, so a file named `.png`
               that is not one gets a card rather than being handed to an <img>. Anything
               still being scanned is a card too — it has no trustworthy type yet, and it
               is not downloadable either.
            */
            const kind = mediaKindOf(file);
            /* A voice note is neither. It is not a picture to show and not a file to list:
               it is a control, and `duration_ms` means the row is complete before any
               grant is spent — see `voice-note.tsx`. */
            const voice = isVoiceNote(file);
            return (
              <li
                key={file.attachmentId}
                className={
                  voice ? 'attachment-voice' : kind === undefined ? undefined : 'attachment-visual'
                }
              >
                {voice ? (
                  <VoiceNote file={file} />
                ) : kind === undefined ? (
                  <AttachmentLink file={file} />
                ) : (
                  <AttachmentMedia file={file} kind={kind} />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
        The time and the receipt, in the corner of the bubble.

        `.message-main` is a flex row ending at the baseline of its last line, so on a short
        message this sits beside the words and on a long one it sits under them at the
        right — which is the shape people already know from every phone messenger, and the
        reason it needs no label.

        Always rendered, including on a turn's first message. The old markup skipped it
        whenever the author's heading was drawn, on the reasoning that one message needs one
        timestamp — but the heading's time was above the bubble and this is inside it, so
        the effect was that the first message of every turn was the one you could not find
        the tick on.
      */}
      <span className="bubble-meta">
        {/*
          "edited" beside the time, not instead of it. The message is still from when it was
          sent; the correction is a second fact about it, and somebody comparing what they
          remember against what is on screen needs both.
        */}
        {message.editedAt !== undefined && message.redactedAt === undefined ? (
          <span className="message-edited" title={`Edited ${formatTimestamp(message.editedAt)}`}>
            edited
          </span>
        ) : null}
        {/*
          A starred message says so, on the message.

          Favourites is a list somewhere else; without a mark here, the only way to know
          whether you had already starred something was to open the menu and read whether
          it offered "Add" or "Remove". The star is private — nobody else sees it — which
          is why it carries no count, unlike a reaction.
        */}
        {message.starred === true ? (
          <span className="message-starred" title="In your favourites" aria-label="In your favourites" role="img">
            <svg viewBox="0 0 24 24" width="11" height="11" focusable="false">
              <path
                d="M12 4.2l2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.5-4.6 2.5.9-5.3L4.5 9.8l5.2-.7L12 4.2Z"
                fill="currentColor"
              />
            </svg>
          </span>
        ) : null}
        <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
        <DeliveryTicks tick={deliveryTick({ isMine, seq: message.seq, readWatermark })} />
      </span>
      </div>


      {/*
        The smiley, and only the smiley.

        Reply was beside it and has moved into the context menu — the request asked for one
        control on hover, and reacting is the one worth a permanent target because it is
        the only action with no keyboard-friendly alternative phrasing ("react with a
        thumbs up" is a picker, not a command). Reply, Edit and Delete are all in the menu,
        reachable by right-click or by the ContextMenu key handled on the row above.
      */}
      <MessageActions
        message={message}
        {...(onReact !== undefined ? { onReact } : {})}
      />

      {menuAt !== undefined ? (
        <MessageContextMenu
          message={message}
          at={menuAt}
          /* Edit and delete are yours alone: editing somebody else's words is
             impersonation and deleting them is moderation. The server refuses both, so
             offering them would be offering a refusal. */
          canEdit={isMine}
          pinned={pinnedIds?.has(message.messageId) === true}
          {...(onTogglePin !== undefined ? { onTogglePin } : {})}
          {...(onForward !== undefined ? { onForward } : {})}
          {...(onToggleStar !== undefined ? { onToggleStar } : {})}
          {...(onMessageInfo !== undefined ? { onMessageInfo } : {})}
          {...(onReply !== undefined ? { onReply } : {})}
          {...(onEdit !== undefined ? { onEdit } : {})}
          onClose={() => setMenuAt(undefined)}
        />
      ) : null}

      {/*
        Reaction chips, below the bubble.

        `mine` drives the highlight and the toggle direction, so pressing your own chip
        removes your reaction and pressing somebody else's adds yours to it — which is
        what every chat application does and what people try first.
      */}
      {message.reactions !== undefined && message.reactions.length > 0 ? (
        <ul className="reactions" aria-label="Reactions">
          {message.reactions.map((reaction) => (
            <li key={reaction.emoji}>
              <button
                type="button"
                className={`reaction${reaction.mine ? ' mine' : ''}`}
                /*
                   The chip OPENS the detail panel; it does not toggle.

                   Adding, changing and removing all live in the hover picker, where the
                   emoji you already chose is highlighted and tapping it again removes it —
                   so the chip is free to answer the question a chip actually raises, which
                   is "who?". Toggling here as well would mean the same click both removed
                   your reaction and asked about it.
                */
                onClick={(event) => {
                  if (detailsFor?.emoji === reaction.emoji) {
                    setDetailsFor(undefined);
                    return;
                  }
                  /*
                     Measured at the moment of the press, not derived in CSS.

                     The panel's left edge has to be clamped so it cannot leave the thread
                     column, and the caret has to point at the chip REGARDLESS of that
                     clamp — which means the caret's position depends on the clamped value.
                     `clamp()` can express the first and cannot be read back for the second,
                     so both are computed here where the resolved number is available.
                  */
                  const chip = event.currentTarget.getBoundingClientRect();
                  const stack = event.currentTarget.closest('.message-stack');
                  const column = stack?.closest('.thread');
                  if (stack == null || column == null) return;
                  const box = stack.getBoundingClientRect();
                  /*
                     The boundary is the THREAD, not the message.

                     Clamping to `.message-stack` was the first attempt and it collapsed the
                     fix: a stack is only as wide as its own bubble — about 410px for a
                     one-line message — so a 260px panel had 150px of travel inside it, and
                     two chips 43px apart both hit the same limit. Measured: x 1164..1424 for
                     both, which is the bug this was meant to remove.

                     A panel is allowed to reach across the column it hangs in. It is not
                     allowed to leave it, which is what this actually measures.
                  */
                  const within = column.getBoundingClientRect();
                  const width = Math.min(260, window.innerWidth - 32);
                  const MARGIN = 8;
                  const centre = chip.left - box.left + chip.width / 2;
                  /* Everything below is in the stack's coordinates, which is what `left`
                     on an absolutely positioned child of it means. */
                  const lowest = within.left + MARGIN - box.left;
                  const highest = within.right - MARGIN - width - box.left;
                  const left =
                    highest < lowest ? lowest : Math.max(lowest, Math.min(centre - width / 2, highest));
                  setDetailsFor({
                    emoji: reaction.emoji,
                    left,
                    /* Inset from the panel's edge, kept off the rounded corners. */
                    caret: Math.max(14, Math.min(centre - left, width - 14)),
                  });
                }}
                aria-haspopup="dialog"
                aria-label={`${reaction.emoji} ${reaction.count}${
                  reaction.mine ? ', including you' : ''
                } — see who reacted`}
                disabled={onReact === undefined}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span className="reaction-count" aria-hidden="true">
                  {reaction.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Anchored to the CHIP, and not portalled.

        `.message-stack` is already a positioning context — the hover action bar uses it —
        and a panel that scrolls with its own message is one the reader never has to hunt
        for after the thread moves under it. Within that context the panel is placed at the
        offset the pressed chip reported, so a message with several chips opens a different
        panel position for each of them.
      */}
      {detailsFor !== undefined && conversationId !== undefined ? (
        <ReactionDetails
          conversationId={conversationId}
          messageId={message.messageId}
          participants={participants ?? []}
          currentPrincipalId={currentPrincipalId}
          initialEmoji={detailsFor.emoji}
          anchor={{ left: detailsFor.left, caret: detailsFor.caret }}
          onClose={() => setDetailsFor(undefined)}
          onRemoveOwn={() => {
            const own = message.reactions?.find((entry) => entry.mine);
            if (own !== undefined) onReact?.(message.messageId, own.emoji, false);
            setDetailsFor(undefined);
          }}
        />
      ) : null}

      {/*
        Time under the bubble, never inside it.

        The design puts it there on every screen, and the two bubbles are why: on the
        near-black one an inside stamp is grey type on near-black, and on the white one it
        crowds a box already at its padding. The stylesheet has assumed this position since
        the bubbles were redrawn — the markup had not caught up, so the stamp was rendering
        inside `.message-main` and taking the bubble's ink with it.

        The tick means "the server has it" and nothing more, until every other participant's
        read marker has passed this message's sequence.

        That claim is deliberately strict: "everybody in this conversation has read it",
        never "somebody has". A person who has not opened the thread has no read-state row,
        which counts as zero and holds the whole conversation at one tick — see
        `read-receipts.ts` for why every ambiguous case has to resolve downward.
        Over-claiming is the only failure here that lies to anybody.
      */}
      </div>
    </li>
  );
}

/**
 * One tick for delivered, two for read.
 *
 * ## Why the shape carries it, and not a word
 *
 * This used to render a single check plus the WORD "Read", on the reasoning that two
 * overlapping ticks are a convention borrowed from a consumer messenger and mean nothing
 * to somebody who has not learned it. That reasoning was wrong about its own audience:
 * everybody who will use StarLink has used a phone messenger, the convention is the most
 * widely understood status glyph there is, and the word cost a visible label on every
 * message you had ever sent.
 *
 * The state is still carried twice, which is what NFR-ACC-3 asks for. Not by colour alone:
 * one tick versus two is a difference in SHAPE, legible in greyscale and to a reader who
 * cannot separate the hues. The colour is the reinforcement.
 *
 * ## The claim is deliberately strict
 *
 * Two ticks mean "everybody in this conversation has read it", never "somebody has". A
 * person who has not opened the thread has no read-state row, which counts as zero and
 * holds the whole conversation at one tick — see `read-receipts.ts` for why every
 * ambiguous case resolves downward. Over-claiming is the only failure here that lies to
 * anybody.
 *
 * `NONE` renders nothing, including on a colleague's message, where a tick would tell them
 * what they already know and tell you nothing.
 */
function DeliveryTicks({ tick }: { readonly tick: DeliveryTick }): ReactNode {
  if (tick === 'NONE') return null;

  const read = tick === 'READ';

  return (
    <span
      className={`message-tick${read ? ' read' : ''}`}
      title={read ? 'Read by everyone' : 'Sent'}
    >
      {/*
        One path, drawn twice at an offset for the read state, rather than two `<svg>`
        elements side by side — those end up either colliding or reading as a wide gap, and
        the shape people recognise is one check tucked behind another.

        The viewBox widens with the second tick so the glyph is not squeezed to fit.
      */}
      <svg
        viewBox={read ? '0 0 18 12' : '0 0 13 12'}
        width={read ? 17 : 12}
        height={11}
        aria-hidden="true"
        focusable="false"
      >
        {read ? (
          <path
            d="M1 6.6 4.2 9.8 10.6 2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        <path
          d={read ? 'M6.4 6.6 9.6 9.8 16 2.6' : 'M1 6.6 4.2 9.8 10.6 2.6'}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {/* The word is gone from the page; a screen reader still needs it. */}
      <span className="sr-only">{read ? 'Read by everyone' : 'Sent'}</span>
    </span>
  );
}

function PendingRow({
  pending,
  onRetry,
  conversationIsInternal,
}: {
  pending: PendingSend;
  onRetry?: ((localId: string) => void) | undefined;
  conversationIsInternal: boolean;
}): ReactNode {
  const failed = pending.state === 'FAILED';

  return (
    <li className={`message-row pending${failed ? ' failed' : ''}`}>
      <div className="message-body">{pending.body}</div>
      {/*
        The state sits where the timestamp sits on a delivered message, so the row does
        not change shape when it lands — it is the same bubble, with the clock replaced by
        a word and then by a tick.
      */}
      <span className="bubble-meta">
        <span className={failed ? 'pending-failed' : undefined}>
          {failed ? 'Not sent' : 'Sending…'}
          {!conversationIsInternal && pending.visibility === 'INTERNAL' ? ' · internal note' : ''}
        </span>
      </span>
      {failed ? (
        <p className="pending-explain">Your text has been kept in the composer.</p>
      ) : null}
      {failed && onRetry !== undefined ? (
        <button type="button" className="pending-retry" onClick={() => onRetry(pending.localId)}>
          Retry
        </button>
      ) : null}
    </li>
  );
}

/**
 * The date is dropped for today's messages.
 *
 * A thread is mostly today, and "Aug 31, 04:05 PM" repeated down a screen of messages all
 * sent within the same hour spends the widest part of the meta line restating something
 * every row already agrees on. The day returns as soon as it is not today, which is the
 * only case where it carries information.
 *
 * Calendar day, not a 24-hour window: 23:59 last night is not "today" however few hours
 * ago it was, and printing a bare clock time on it would put yesterday's message on
 * today's footing.
 */
/**
 * Is this message a single emoji and nothing else?
 *
 * ## Why graphemes and not characters
 *
 * "👍" is two code units, "👨‍👩‍👧" is eight, and a flag is two code points that mean one
 * picture. Counting `length`, or even `[...body]`, splits all three into several
 * "characters" and the test never fires for exactly the emoji people send most. `Intl
 * .Segmenter` counts what a reader would call one symbol.
 *
 * ## Why only one
 *
 * The rule is a single emoji, not a short message. Two of them go back in a bubble: at
 * display size a row of them stops reading as a gesture and starts crowding the thread,
 * which is why every product with this behaviour caps it.
 */
export function isSoleEmoji(body: string): boolean {
  const text = body.trim();
  if (text === '') return false;
  /* Older engines without `Intl.Segmenter` simply never get the treatment — a plain
     bubble is the correct fallback, and guessing with a regex over code units is how the
     family emoji ends up rendered as four. */
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}/u.test(graphemes[0]?.segment ?? '');
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  /*
     The time, and never the date.

     It used to prepend "Sep 02" to anything not sent today, which put the date on every
     message in the conversation twice over — once in the stamp and once in the day
     divider a few rows above it that exists to say exactly that. Two answers to the same
     question, and the redundant one repeated per message.

     The divider is the load-bearing half: `timeline.ts` inserts TODAY, YESTERDAY or the
     date whenever the day changes, so every message on screen already sits under a heading
     that dates it. This is the time within that day.
  */
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * One attached file, and the download grant it fetches on demand.
 *
 * Deliberately a click rather than an `href`. §28.4 issues a short-lived, single-object
 * grant only after the full authorization ladder, and the issuance is AUDITED — so a
 * rendered link would either be a grant nobody asked for or an audit entry for a file
 * nobody opened. The click is the request.
 */
function AttachmentLink({ file }: { readonly file: AttachmentView }): ReactNode {
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const open = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      const grant = await api.downloadAttachment(file.attachmentId);
      window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      /**
       * §34.4 requires an explicit "temporarily unavailable", never a broken image or a
       * silent blank — which is what a 404 would produce, because the person would read
       * it as "the file is gone".
       */
      setProblem(
        cause instanceof ApiError && cause.status === 503
          ? 'Storage is temporarily unavailable. The file is safe — try again shortly.'
          : 'That file is not available to you.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="attachment-card"
        onClick={() => void open()}
        disabled={busy}
      >
        <span className="attachment-icon" aria-hidden="true">
          {extensionOf(file.filename)}
        </span>
        <span className="attachment-text">
          <span className="attachment-name">{file.filename}</span>
          <span className="attachment-meta">{formatBytes(file.declaredBytes)}</span>
        </span>
      </button>
      {problem !== undefined ? <span role="alert"> {problem}</span> : null}
    </>
  );
}
