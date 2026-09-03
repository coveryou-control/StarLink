'use client';

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type AttachmentView } from '../lib/api-client';
import { extensionOf, formatBytes } from './attachment-picker';
import { deliveryTick, type DeliveryTick } from '@starlink/shared-contracts';
import { initialsFor, senderColour } from './conversation-naming';
import { crossesDay, daySeparatorLabel, unreadDividerIndex } from './timeline';
import { splitBody } from '../lib/mention-draft';
import { MessageActions } from './message-actions';

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
  readonly onDelete?: ((message: MessageView) => void) | undefined;
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
  onDelete,
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
          conversationIsInternal={conversationIsInternal}
          isGroup={isGroup}
          currentPrincipalId={currentPrincipalId}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
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
  onDelete,
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
  onDelete?: ((message: MessageView) => void) | undefined;
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

  return (
    <li
      className={`message-row${isCustomerNote ? ' internal' : ''}${isMine ? ' mine' : ''}${
        grouped ? ' grouped' : ''
      }${showHead ? ' with-head' : ''}`}
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
          className="message-avatar"
          aria-hidden="true"
          style={grouped ? undefined : { color: senderColour(message.senderPrincipalId) }}
        >
          {grouped ? '' : initialsFor(message.senderDisplayName)}
        </span>
      ) : null}

      {/*
        Bubble and stamp, stacked.

        The stamp used to live INSIDE the bubble, floated into its bottom-right corner.
        That works on a lightly tinted bubble and fails on this design's two: on the
        near-black one it would be grey type on near-black, and on the white one it would
        crowd a box that is already at its padding. Every screen in the reference puts the
        time on its own line beneath the bubble, aligned to the side the message came from.
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
            className="author"
            /* A stable hue per person, so "who said this" is a glance rather than a read
               in a group. Never the only signal — the name is right there. */
            style={{ color: senderColour(message.senderPrincipalId) }}
          >
            {message.senderDisplayName}
          </strong>
          <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
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
          {message.attachments.map((file) => (
            <li key={file.attachmentId}>
              <AttachmentLink file={file} />
            </li>
          ))}
        </ul>
      ) : null}
      </div>


      {/*
        Reply, copy and react, in one menu on hover. Every entry does something — a menu
        with a disabled or decorative item is worse than a shorter menu.
      */}
      <MessageActions
        message={message}
        isMine={isMine}
        {...(onReply !== undefined ? { onReply } : {})}
        {...(onReact !== undefined ? { onReact } : {})}
        {...(onEdit !== undefined ? { onEdit } : {})}
        {...(onDelete !== undefined ? { onDelete } : {})}
      />

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
                onClick={() => onReact?.(message.messageId, reaction.emoji, !reaction.mine)}
                aria-pressed={reaction.mine}
                aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', including you' : ''}`}
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
      {/*
        Not when the turn's own heading already carries the time — one message, one
        timestamp. A group row with a heading has no tick to show either: the tick is only
        ever drawn on your own messages, and those never take a heading.
      */}
      {showHead ? null : (
        <div className="message-stamp">
          {/*
            "edited" beside the time, not instead of it. The message is still from when it
            was sent; the correction is a second fact about it, and somebody comparing what
            they remember with what is on screen needs both.
          */}
          {message.editedAt !== undefined && message.redactedAt === undefined ? (
            <span className="message-edited" title={`Edited ${formatTimestamp(message.editedAt)}`}>
              edited
            </span>
          ) : null}
          <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
          <DeliveryTicks tick={deliveryTick({ isMine, seq: message.seq, readWatermark })} />
        </div>
      )}
      </div>
    </li>
  );
}

/**
 * One tick or two.
 *
 * Drawn as a single glyph rather than two overlapping copies of the same path: two
 * `<svg>`s side by side end up either colliding or reading as a wide gap, and the shape
 * people recognise is one check tucked behind another.
 *
 * The accessible name is a SENTENCE, not "read" — a screen reader announcing "read" after
 * a timestamp says nothing about who, and in a group the whole point of this tick is that
 * it means everybody. `NONE` renders nothing at all, including for a colleague's message,
 * where a tick would be telling them what they already know and telling you nothing.
 */
function DeliveryTicks({ tick }: { readonly tick: DeliveryTick }): ReactNode {
  if (tick === 'NONE') return null;

  const read = tick === 'READ';
  /**
   * A tick and the WORD, which is how the design states it: "10:06 ✓ Read".
   *
   * Two overlapping ticks are a convention borrowed from a consumer messenger and they
   * carry the meaning only for people who already know it. The word carries it for
   * everybody, costs about twenty pixels beside a timestamp that is already there, and
   * removes the need for a tooltip to explain a glyph.
   *
   * "Read by everyone" in a group and in a one-to-one alike: it is true in both, and one
   * wording means the receipt cannot quietly mean less in a group than it appears to.
   */
  const label = read ? 'Read by everyone' : 'Sent';

  return (
    <span className={`message-tick${read ? ' read' : ''}`} title={label}>
      {/*
        The tick carries the colour; the word does not.

        Screen 02 draws "10:06 <green tick> Read" with the word in the same secondary ink as
        the timestamp beside it. A green WORD reads as a status banner and pulls the eye to
        every delivered message on the page, which is the opposite of what a receipt is for.
      */}
      <span className="message-tick-glyph">
        <svg viewBox="0 0 16 12" width="14" height="11" aria-hidden="true" focusable="false">
          <path
            d="M1.5 6.4 5 9.9l9-9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {read ? 'Read' : null}
      {/* The un-read state is a bare tick; a screen reader still needs the word. */}
      {read ? null : <span className="sr-only">Sent</span>}
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
      <div className="message-stamp">
        <span className={failed ? 'pending-failed' : undefined}>
          {failed ? 'Not sent' : 'Sending…'}
          {!conversationIsInternal && pending.visibility === 'INTERNAL' ? ' · internal note' : ''}
        </span>
      </div>
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
function formatTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { day: '2-digit', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
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
