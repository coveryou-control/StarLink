'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';

import {
  CONVERSATION_KIND,
  avatarFor,
  conversationLabel,
  relativeTime,
} from './conversation-naming';
import { PresenceDot } from './presence';
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
 * the thread has several people in it and cannot remember who. There is deliberately no
 * "Favourites" or "Archived" — both need a per-person server-side flag that does not
 * exist, and a filter that forgets itself on reload is worse than no filter.
 */
type Filter = 'all' | 'unread' | 'groups';

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'groups', label: 'Groups' },
];

export function ConversationList({
  conversations,
  activeId,
  loading,
  onLoadMore,
  loadingMore = false,
  currentPrincipalId,
}: ConversationListProps): ReactNode {
  const [filter, setFilter] = useState<Filter>('all');

  /**
   * Applied to what is loaded, and honest about that.
   *
   * The list is paged, so "Unread" narrows the conversations already fetched rather than
   * asking the server for every unread thread. That is the right trade for a filter people
   * flick between — a round trip per pill would make it feel like navigation — but it does
   * mean an unread thread further back appears only once "Load older" has reached it.
   */
  const shown = conversations.filter((conversation) => {
    if (filter === 'unread') return conversation.unreadCount > 0;
    if (filter === 'groups') return (conversation.participants ?? []).length > 1;
    return true;
  });

  const unreadCount = conversations.filter((c) => c.unreadCount > 0).length;

  return (
    <nav aria-label="Conversations" className="conversation-nav">
      {/*
        No "CONVERSATIONS" heading above the pills.

        The panel's own header already says Chats two rows up, and a caps label repeating
        it cost a row in the one column where rows are the product. The filter pills are
        the list's header now — they name what is below them by narrowing it.
      */}
      <div className="filter-pills" role="tablist" aria-label="Filter conversations">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={filter === option.id}
            className={`filter-pill${filter === option.id ? ' active' : ''}`}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
            {/* The count is on Unread only: it is the one that answers a question
                ("is there anything?") without being clicked. */}
            {option.id === 'unread' && unreadCount > 0 ? (
              <span className="filter-count">{unreadCount}</span>
            ) : null}
          </button>
        ))}
      </div>

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
          {filter === 'unread' ? 'You have read everything.' : 'No group conversations yet.'}
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
          const secondary =
            preview !== undefined && preview !== ''
              ? preview
              : (CONVERSATION_KIND[conversation.conversationType] ??
                conversation.conversationType);

          return (
            <li key={conversation.conversationId}>
              <Link
                href={`/conversations/${conversation.conversationId}`}
                aria-current={active ? 'page' : undefined}
                className="conversation-row"
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
                    {avatarFor(conversation).text}
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
                  </span>

                  <span className="row-bottom">
                    <span className="row-preview">{secondary}</span>
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

      {loading ? <p className="state-note">Loading…</p> : null}

      {onLoadMore !== undefined ? (
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className="load-more">
          {loadingMore ? 'Loading…' : 'Load older conversations'}
        </button>
      ) : null}
    </nav>
  );
}
