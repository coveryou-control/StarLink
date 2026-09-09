'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';

import {
  avatarFor,
  conversationLabel,
  relativeTime,
} from './conversation-naming';
import { PresenceDot } from './presence';
import { GroupGlyph } from './group-glyph';
import { AvatarImage, ConversationAvatarImage } from './avatar-image';
import { ConversationRowMenu } from './conversation-row-menu';
import { api } from '../lib/api-client';
import { MAX_PINNED_CONVERSATIONS } from '@starlink/shared-contracts';
import { deliveryTick } from '@starlink/shared-contracts';
import type { ConversationSummary } from '../lib/api-client';

interface ConversationListProps {
  readonly conversations: readonly ConversationSummary[];
  readonly activeId?: string | undefined;
  readonly loading: boolean;
  /** Provided only while the server has offered a cursor. */
  readonly onLoadMore?: (() => void) | undefined;
  readonly loadingMore?: boolean;
  /**
   * Whose list this is, so a row can tell "my last message" from theirs.
   *
   * Needed for the tick and for nothing else: a row shows delivery state only on a message
   * the reader wrote.
   */
  readonly currentPrincipalId?: string;
  /**
   * Re-reads the list after a pin moves.
   *
   * The order is the SERVER's — pinned conversations come first in its own `ORDER BY` —
   * so a row that reordered itself locally would disagree with the next page fetched.
   */
  readonly onPinChanged?: (() => void) | undefined;
  /**
   * conversationId → the principal currently typing in it.
   *
   * Only for conversations you are NOT looking at: the open thread draws its own indicator
   * above the composer, and two of them on one screen saying the same thing is noise.
   */
  readonly view?: 'all' | 'unread' | 'favourites' | 'groups' | 'direct' | 'archive';
  readonly typing?: ReadonlyMap<string, string> | undefined;
}

/**
 * One tick or two, on a conversation row.
 *
 * Renders nothing unless the newest message is the reader's own — which is the same rule
 * the thread applies, for the same reason: a tick on somebody else's message tells them
 * what they already know, and in a group it would report how closely each colleague is
 * following the thread.
 *
 * Every input is optional because an older server sends none of them, and the honest
 * response to a missing watermark is no tick rather than a guessed one.
 */
function RowTick({
  conversation,
  me,
}: {
  readonly conversation: ConversationSummary;
  readonly me: string | undefined;
}): ReactNode {
  const tick = deliveryTick({
    isMine: me !== undefined && conversation.lastMessageSenderId === me,
    seq: conversation.lastMessageSeq ?? 0,
    readWatermark: conversation.readWatermark ?? 0,
  });
  if (tick === 'NONE') return null;

  const read = tick === 'READ';
  const label = read ? 'Read by everyone' : 'Sent';

  return (
    <span className={`row-tick${read ? ' read' : ''}`} title={label} aria-label={label} role="img">
      <svg viewBox="0 0 20 12" width={read ? 17 : 13} height="10" aria-hidden="true" focusable="false">
        <path
          d="M1.5 6.4 5 9.9l9-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {read ? (
          <path
            d="M6.6 6.4 10.1 9.9l9-9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
    </span>
  );
}

/**
 * The three ways somebody actually narrows a chat list.
 *
 * Unread is the one people use every morning; Groups is the one they use when they know
 * the thread has several people in it and cannot remember who.
 *
 * The pill row that used to live here is gone: the sidebar names All, Unread, Favourites,
 * Groups, 1:1 and Archive, so the pills were a second control for the same job sitting
 * directly beneath the first. Favourites and Archive are real now — migration 0028 gave
 * each a per-person flag — which is what the note here used to say could not be done.
 */


export function ConversationList({
  conversations,
  activeId,
  loading,
  onLoadMore,
  loadingMore = false,
  currentPrincipalId,
  onPinChanged,
  typing,
  view = 'all',
}: ConversationListProps): ReactNode {
  /*
     One narrowing, from the sidebar.

     There were two — this pill row and the sidebar — and they overlapped on All and
     Groups. The sidebar won: it names more of them, it has room for the labels, and one
     control that says which list you are looking at cannot disagree with itself.
  */
  /** The row a right-click opened a menu for, and where the pointer was. */
  const [rowMenu, setRowMenu] = useState<
    | {
        conversationId: string;
        label: string;
        pinned: boolean;
        mutedUntil: string | undefined;
        x: number;
        y: number;
      }
    | undefined
  >();
  /*
     Shown when the server refuses a fourth pin. Held here rather than in the menu, which
     has closed by the time the round trip returns — a message inside a component that no
     longer exists is a message nobody reads.
  */
  const [pinProblem, setPinProblem] = useState<string | undefined>();

  const togglePin = (conversationId: string, next: boolean): void => {
    setPinProblem(undefined);
    void api
      .setConversationPreferences(conversationId, { pinned: next })
      .then((result) => {
        if (result.limitReached === true) {
          setPinProblem(
            `You can pin ${MAX_PINNED_CONVERSATIONS} chats. Unpin one to pin another.`,
          );
          return;
        }
        onPinChanged?.();
      })
      .catch(() => setPinProblem('That could not be saved.'));
  };

  /*
     `null` unmutes. The duration is sent, not the instant it ends: the server computes
     that against its own clock, so a browser running fast cannot ask to be quietened until
     a moment already past.

     Re-reads the list on success, because `mutedUntil` lives on the summary and the shell
     hands it to the notification hook — a mute that the list does not know about is a mute
     that still makes a noise.
  */
  const setMute = (conversationId: string, minutes: number | null): void => {
    setPinProblem(undefined);
    void api
      .setConversationPreferences(conversationId, { muteMinutes: minutes })
      .then(() => onPinChanged?.())
      .catch(() =>
        setPinProblem(
          minutes === null ? 'That could not be unmuted.' : 'That could not be muted.',
        ),
      );
  };

  /**
   * Applied to what is loaded, and honest about that.
   *
   * The list is paged, so "Unread" narrows the conversations already fetched rather than
   * asking the server for every unread thread. That is the right trade for a filter people
   * flick between — a round trip per pill would make it feel like navigation — but it does
   * mean an unread thread further back appears only once "Load older" has reached it.
   */
  const shown = conversations.filter((conversation) => {
    /* Archive is not a shape of conversation but a different fetch, so it is not decided
       here — the shell asks the server for that list instead. */
    /*
       Split on the conversation's TYPE, not on how many people are currently in it.

       Counting participants meant a group moved between the two lists as members came and
       went: remove one person from a three-member group and it vanished from Groups and
       appeared under 1:1, while still being an `INTERNAL_GROUP` everywhere else in the
       product — with a group avatar, a group title and an Add-member control. A two-person
       group is a group whose others have left, and the person who created it still thinks
       of it that way.

       The type is the fact the server records; the head count is a property that changes.
    */
    if (view === 'groups') return conversation.conversationType !== 'INTERNAL_DIRECT';
    if (view === 'direct') return conversation.conversationType === 'INTERNAL_DIRECT';
    if (view === 'unread') return conversation.unreadCount > 0;
    return true;
  });


  return (
    <nav aria-label="Conversations" className="conversation-nav">
      {/*
        No "CONVERSATIONS" heading above the pills.

        The panel's own header already says Chats two rows up, and a caps label repeating
        it cost a row in the one column where rows are the product. The filter pills are
        the list's header now — they name what is below them by narrowing it.
      */}
      {/*
        The pill row is gone.

        It offered All, Unread and Groups; the sidebar names all three and two more, so the
        pills were a second control for the same job sitting directly beneath the first.
        Removed on request, and correctly: two ways to narrow one list is how a reader ends
        up looking at the intersection of two filters they only set one of.
      */}

      {/*
        A skeleton, not a spinner and not nothing.

        The list used to render empty and then fill, so the first second of every session
        looked like an account with no conversations — the single worst first impression
        this product can give. Rows at the real row height keep the column still and read
        as "your conversations are loading" without a word.
      */}
      {loading && conversations.length === 0 ? (
        <ul className="conversation-items" aria-hidden="true">
          {[72, 58, 66, 50, 62, 54].map((width) => (
            <li key={width}>
              <div className="conversation-row skeleton-row">
                <span className="row-avatar skeleton-block" />
                <span className="row-text">
                  <span className="skeleton-line" style={{ width: `${width}%` }} />
                  <span className="skeleton-line short" style={{ width: `${width - 12}%` }} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {loading && conversations.length === 0 ? (
        <p className="sr-only" role="status">
          Loading your conversations…
        </p>
      ) : null}

      {conversations.length === 0 && !loading ? (
        <p className="state-note">
          <strong>No conversations yet</strong>
          Tap the compose button to message a colleague, or find someone in People.
        </p>
      ) : null}

      {/*
        An empty FILTER is not an empty inbox, and must not read as one.
      */}
      {!loading && shown.length === 0 && conversations.length > 0 ? (
        <p className="state-note">
          <strong>Nothing here</strong>
          {view === 'unread'
            ? 'You have read everything.'
            : view === 'groups'
              ? 'No group conversations yet.'
              : view === 'direct'
                ? 'No one-to-one conversations yet.'
                : view === 'archive'
                  ? 'Nothing archived.'
                  : 'No conversations yet.'}
        </p>
      ) : null}

      <ul className="conversation-items">
        {shown.map((conversation) => {
          const active = conversation.conversationId === activeId;
          const unread = conversation.unreadCount;
          const label = conversationLabel(conversation);
          /*
             The kind line is dropped when a preview exists: a row has one secondary line,
             and the last thing said is worth more than the word "Direct message" repeated
             down the whole column. With no preview the kind returns, so the row is never
             blank under the name.
          */
          const preview = conversation.lastMessagePreview;
          /*
             In a group, WHO said it is half the glimpse.

             "on my way" tells you nothing about whether to open a room of six people.
             "Rahul: on my way" tells you whether it was aimed at you. A one-to-one needs
             no prefix — the row's own name already answers it, and repeating it there
             would cost the preview a third of its width for nothing.

             The name comes from the participant summary the row already has, so this is a
             map read rather than a lookup. Nothing is drawn when the sender is not in that
             list (someone since removed): a bare preview is right, an invented name is not.
          */
          const senderName =
            avatarFor(conversation).isGroup && conversation.lastMessageSenderId !== undefined
              ? /*
                   "You" when it was you.

                   `participants` is the OTHER people in the conversation — the reader is
                   not in their own summary — so looking the sender up there returns
                   nothing for your own messages, and half the rows in a group-heavy list
                   lost their prefix while the other half kept it. That reads as a bug in
                   the prefix rather than as a fact about who spoke.
                */
                conversation.lastMessageSenderId === currentPrincipalId
                ? 'You'
                : (conversation.participants ?? []).find(
                    (person) => person.principalId === conversation.lastMessageSenderId,
                  )?.displayName
              : undefined;

          /*
             With no preview, the kind used to be the fallback — so every group with
             nothing said in it read "Group", a label the row's own avatar and name already
             carry. What is actually true of that row is that it is empty, so it says so.
          */
          /*
             Somebody typing replaces the preview, because it is newer than it.

             Suppressed on the conversation you are already in: that one draws its own
             indicator above the composer, and the same claim in two places on one screen
             reads as two people typing.

             The name is resolved from the participants the row already carries, and a
             signal from somebody the summary does not list falls back to the preview
             rather than to "Someone" — an unattributed "typing…" on a row is less useful
             than the last thing that was actually said.
          */
          const typist =
            conversation.conversationId === activeId
              ? undefined
              : typing?.get(conversation.conversationId);
          const typistName =
            typist === undefined
              ? undefined
              : (conversation.participants ?? []).find(
                  (person) => person.principalId === typist,
                )?.displayName;

          const secondary =
            preview !== undefined && preview !== ''
              ? senderName !== undefined
                ? senderName + ': ' + preview
                : preview
              : 'No messages yet';

          return (
            <li key={conversation.conversationId}>
              <Link
                href={`/conversations/${conversation.conversationId}`}
                aria-current={active ? 'page' : undefined}
                className="conversation-row"
                /* `preventDefault` so the browser's own menu does not open on top of
                   this one. Right-click does not follow the link either way. */
                onContextMenu={(event) => {
                  event.preventDefault();
                  setRowMenu({
                    conversationId: conversation.conversationId,
                    label,
                    pinned: conversation.pinned === true,
                    mutedUntil: conversation.mutedUntil,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                {/*
                  The dot belongs to a PERSON, so it is shown only for a one-to-one. A
                  group has several people behind one avatar and a single dot on it would
                  be a claim about which of them.
                */}
                <span className="avatar-wrap">
                  <span
                    className={`row-avatar${avatarFor(conversation).isGroup ? ' group' : ''}`}
                    aria-hidden="true"
                  >
                    {avatarFor(conversation).isGroup ? (
                      <>
                        <GroupGlyph />
                        <ConversationAvatarImage conversationId={conversation.conversationId} />
                      </>
                    ) : (
                      <>
                        {/* The picture sits OVER the initials rather than replacing them:
                            if it fails to load, what shows through is the letters rather
                            than an empty circle. */}
                        {avatarFor(conversation).text}
                        <AvatarImage
                          principalId={conversation.participants?.[0]?.principalId}
                          alt=""
                        />
                      </>
                    )}
                  </span>
                  {(conversation.participants ?? []).length === 1 ? (
                    <PresenceDot principalId={conversation.participants?.[0]?.principalId} />
                  ) : null}
                </span>

                <span className="row-text">
                  <span className="row-top">
                    {/*
                      One weight for every row.

                      This carried an inline 700/620/500 ladder, which put the name's
                      emphasis on three levels the reference does not have — there the name
                      is 600 whether the row is read, unread or open. Unread still states
                      itself three ways and none of them is colour alone (NFR-ACC-3): the
                      count badge, the preview in full text colour at 500, and the
                      timestamp in brand orange. Those are in the stylesheet, which is also
                      why the weight belongs there and not here — an inline style outranks
                      every rule that tries to correct it.
                    */}
                    <strong className="row-name">{label}</strong>
                    <time
                      dateTime={conversation.lastActivityAt}
                      className="row-time"
                      title={new Date(conversation.lastActivityAt).toLocaleString()}
                    >
                      {relativeTime(conversation.lastActivityAt)}
                    </time>
                    {/*
                      A pinned row says so.

                      A pin sorts the row to the top, and until now that was the ONLY sign
                      it had been pinned — which is unreadable, because a row at the top of
                      a list sorted by recency is also just a recent row. The mark sits
                      beside the time because that is the row's metadata corner, and it is
                      the only place that does not steal width from the name.
                    */}
                    {/*
                      A muted chat says so, permanently.

                      Muting silences notifications, and until now the only way to find out
                      which threads were muted was to open each one's menu and read the
                      "Muted until…" line. A thread you silenced weeks ago is exactly the
                      one you forget about, so the state belongs on the row rather than
                      behind a right-click.
                    */}
                    {conversation.mutedUntil !== undefined &&
                    new Date(conversation.mutedUntil).getTime() > Date.now() ? (
                      <span
                        className="row-muted"
                        title={`Muted until ${new Date(conversation.mutedUntil).toLocaleString()}`}
                        aria-label="Muted"
                        role="img"
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" focusable="false">
                          <path
                            d="M6 9.5a6 6 0 0 1 9.2-5.1M17.9 11v3.6l1.6 2.4H8.2M10.1 20.2a2 2 0 0 0 3.8 0"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path d="M4 4l16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                        </svg>
                      </span>
                    ) : null}
                    {conversation.pinned === true ? (
                      <span className="row-pin" title="Pinned" aria-label="Pinned" role="img">
                        <svg viewBox="0 0 24 24" width="12" height="12" focusable="false">
                          <path
                            d="M14.5 3.5 20.5 9.5l-2.4.7-3.3 3.3.5 3.4-1.6 1.6-4-4L5 19.7l-.7-.7 5.2-5.6-4-4L7.1 7.8l3.4.5 3.3-3.3.7-1.5Z"
                            fill="currentColor"
                          />
                        </svg>
                      </span>
                    ) : null}
                  </span>

                  <span className="row-bottom">
                    {typistName !== undefined ? (
                      <span className="row-preview row-typing">
                        <span className="typing-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        {avatarFor(conversation).isGroup
                          ? `${typistName} is typing`
                          : 'typing'}
                      </span>
                    ) : (
                      <span className="row-preview">{secondary}</span>
                    )}
                    {unread > 0 ? (
                      <span
                        // The visible badge is a numeral; the accessible name spells it
                        // out, because "3" read aloud beside a thread title means nothing.
                        aria-label={`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}
                        className="row-unread"
                      >
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : (
                      /*
                        A tick on the row, for the same reason the thread has one: the
                        question "did they see it" is usually asked from the list, before
                        anybody opens anything.

                        Only when there is no unread badge — the two occupy the same slot,
                        and a row cannot simultaneously be waiting for you to read it and
                        reporting that somebody read you.
                      */
                      <RowTick conversation={conversation} me={currentPrincipalId} />
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {rowMenu !== undefined ? (
        <ConversationRowMenu
          conversationId={rowMenu.conversationId}
          label={rowMenu.label}
          pinned={rowMenu.pinned}
          mutedUntil={rowMenu.mutedUntil}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onTogglePin={togglePin}
          onMute={setMute}
          archived={view === 'archive'}
          onToggleArchive={(conversationId, next) => {
            void (async () => {
              try {
                if (next) await api.archiveConversation(conversationId);
                else await api.restoreConversation(conversationId);
              } finally {
                /* The row has to leave the list it is in, and only a re-read knows which
                   list that now is — the same callback a pin uses, for the same reason. */
                onPinChanged?.();
              }
            })();
          }}
          onClose={() => setRowMenu(undefined)}
        />
      ) : null}

      {/* `role="alert"` because it appears in response to something the person just did
          and there is nothing else on the screen to notice. */}
      {pinProblem !== undefined ? (
        <p className="state-note" role="alert">
          {pinProblem}
        </p>
      ) : null}

      {loading ? <p className="state-note">Loading…</p> : null}

      {onLoadMore !== undefined ? (
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className="load-more">
          {loadingMore ? 'Loading…' : 'Load older conversations'}
        </button>
      ) : null}
    </nav>
  );
}
