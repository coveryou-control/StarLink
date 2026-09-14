'use client';

/**
 * Company Announcements — the board.
 *
 * ## Why it is not just a filter on the chat list
 *
 * An announcement is a conversation in every technical sense: the same messages, the same
 * sequence, the same read state, the same realtime delivery. It is a different thing to a
 * reader. One notice addressed to the whole company would otherwise sit at the top of
 * everybody's chat list every time anybody in the company opened it, and a person looking
 * for the thread they were in the middle of would be reading a notice board.
 *
 * So the split is a scope on the server's own query, not a filter here — a client-side
 * filter would return short pages and then page against a cursor that had already skipped
 * past what it dropped.
 *
 * ## Why it stopped being a list of rows
 *
 * It was the conversation list with a megaphone instead of a face: a title, a preview and a
 * time. That is the right shape for a thread you are IN and the wrong one for a notice, and
 * three things went missing because of it.
 *
 * Nobody could see WHO had issued a notice, which on the one screen where the author is the
 * point is the fact most worth carrying. Nothing could be held at the top, so "office closed
 * on Friday" sank under three routine updates the moment they were posted. And read state
 * was a red count, which is the right signal for "four people said something to you" and the
 * wrong one for "you have not read this" — a notice is read once and the number is always
 * one.
 *
 * The board answers those three: the publisher's name on every card, a pin a publisher can
 * set for everybody, and a dot rather than a count.
 *
 * ## The compose control is asked for, never assumed
 *
 * Most people may read announcements and not write them. The button is drawn only when the
 * server says the caller holds `conversation.announcement.post` — a convenience, not the
 * boundary: `POST` decides again, and that decision is the one that counts. A reader who is
 * shown a button that answers 404 learns that the product is unreliable, which is a worse
 * failure than not seeing the button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type ConversationSummary } from '../lib/api-client';
import { relativeTime } from './conversation-naming';

/**
 * Three views of one board.
 *
 * "Unread" and "Pinned" are filters over what has already been fetched rather than three
 * server queries, and that is safe here in a way it would not be on the chat list: the
 * announcements scope is a short, complete list — a company posts notices, not messages —
 * so there is no cursor for a client-side filter to skip past. The chat list pages, which
 * is exactly why ITS filters are server-side.
 */
type Board = 'all' | 'unread' | 'pinned';

const TABS: readonly { readonly id: Board; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'pinned', label: 'Pinned' },
];

function PinGlyph({ filled }: { readonly filled: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M14.5 3.5 20.5 9.5l-3 1-1.2 4.2-4.5-4.5-4.6 6.4 6.4-4.6-4.5-4.5L13.5 6.5Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AnnouncementsPanel({
  activeId,
  onOpen,
  onLoaded,
}: {
  readonly activeId?: string | undefined;
  readonly onOpen: (conversationId: string) => void;
  /**
   * Handed up so the thread column can NAME what it is showing.
   *
   * The chat header and the information panel are drawn from the conversation SUMMARY the
   * shell holds, and that list deliberately excludes announcements. Without this an open
   * announcement rendered as "Conversation" with a dot for an avatar — the thread was
   * correct and the frame around it knew nothing about it.
   */
  readonly onLoaded?: (items: readonly ConversationSummary[]) => void;
}): ReactNode {
  const [items, setItems] = useState<readonly ConversationSummary[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [mayPost, setMayPost] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState<Board>('all');
  const [pinning, setPinning] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await api.conversations({ scope: 'announcements' });
      setItems(page.conversations);
      onLoaded?.(page.conversations);
      setProblem(undefined);
    } catch (cause) {
      /*
         An empty board and an unreachable server must not look the same — the same rule
         the inbox obeys. "Nothing has been announced" is a fact; a failed request is not.
      */
      setItems(undefined);
      setProblem(
        cause instanceof ApiError && cause.isUnauthenticated
          ? 'Your session has ended. Sign in again to see announcements.'
          : 'Announcements could not be loaded. This is not the same as none.',
      );
    }
    /* `onLoaded` is a fresh closure every render in the shell; depending on it would
       reload the board on every parent render. */
  }, []);

  useEffect(() => {
    void load();
    void api
      .mayAnnounce()
      // Fail CLOSED: a permission we could not read is not a permission held.
      .then((result) => setMayPost(result.mayPost))
      .catch(() => setMayPost(false));
  }, [load]);

  const create = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setBusy(true);
    try {
      const { conversationId } = await api.announce(trimmed);
      setTitle('');
      setComposing(false);
      await load();
      onOpen(conversationId);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError && cause.status === 404
          ? 'You are not able to open an announcement.'
          : 'That announcement could not be opened. Nothing was posted.',
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (item: ConversationSummary): Promise<void> => {
    setPinning(item.conversationId);
    try {
      await api.pinAnnouncement(item.conversationId, item.pinnedForEveryone === undefined);
      await load();
    } catch {
      setProblem('That could not be changed. Nothing has moved.');
    } finally {
      setPinning(undefined);
    }
  };

  const unreadCount = (items ?? []).filter((item) => item.unreadCount > 0).length;
  const pinnedCount = (items ?? []).filter((item) => item.pinnedForEveryone !== undefined).length;

  const shown = useMemo(
    () =>
      (items ?? []).filter((item) =>
        board === 'unread' ? item.unreadCount > 0
        : board === 'pinned' ? item.pinnedForEveryone !== undefined
        : true,
      ),
    [items, board],
  );

  const count = (id: Board): number =>
    id === 'all' ? (items ?? []).length : id === 'unread' ? unreadCount : pinnedCount;

  return (
    <section className="panel" aria-label="Announcements">
      <header className="panel-head announce-head">
        <div className="announce-title">
          <h2>Announcements</h2>
          {/*
            One line saying what the board is FOR, which the reference draws and which is
            worth the row: an announcement behaves unlike everything else in this product —
            you cannot reply to most of them — and a person meeting it for the first time
            should be told why before they wonder what is broken.
          */}
          <p>Important updates from leadership and the company.</p>
        </div>
        {mayPost ? (
          <button
            type="button"
            className="panel-head-action"
            onClick={() => setComposing((open) => !open)}
            aria-expanded={composing}
          >
            {composing ? 'Cancel' : 'New'}
          </button>
        ) : null}
      </header>

      <div className="panel-body">
        {composing ? (
          <form
            className="announce-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label htmlFor="announce-title">What is this about?</label>
            <input
              id="announce-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Office closed on Friday"
              autoFocus
            />
            <p className="muted">
              Everyone at CoverYou will be able to read this. Only people who can post
              announcements will be able to reply in it.
            </p>
            <button type="submit" disabled={busy || title.trim() === ''}>
              {busy ? 'Opening…' : 'Open announcement'}
            </button>
          </form>
        ) : null}

        {/*
          The three views, with their counts — and only once there is something to divide.

          A row reading "All 0 · Unread 0 · Pinned 0" above an empty board is a worse way of
          saying nothing has been announced. The same call the channel directory and the
          search facets make.
        */}
        {items !== undefined && items.length > 0 ? (
          <div className="filter-pills" role="tablist" aria-label="Which announcements">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={board === tab.id}
                className={`filter-pill${board === tab.id ? ' active' : ''}`}
                onClick={() => setBoard(tab.id)}
              >
                {tab.label} {count(tab.id)}
              </button>
            ))}
          </div>
        ) : null}

        {problem !== undefined ? (
          <p className="panel-note" role="alert">
            {problem}
          </p>
        ) : items === undefined ? (
          /* Shapes, not the word — the same waiting state every other list here shows. */
          <ul className="announce-items" aria-hidden="true">
            {[80, 62].map((width) => (
              <li key={width}>
                <div className="announce-card">
                  <span className="skeleton-line" style={{ width: `${width}%` }} />
                  <span className="skeleton-line short" style={{ width: `${width - 24}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p className="panel-note">
            Nothing has been announced yet.
            {mayPost ? ' You can open the first one.' : ''}
          </p>
        ) : shown.length === 0 ? (
          /* The same voice as the conversation list's caught-up state, without the mark:
             this is a narrow side panel and a 26px glyph in it would be a third of the
             column. What carries over is that reaching the end reads as reaching the end
             rather than as an absence — see `EmptyState` in `conversation-list.tsx`. */
          <p className="panel-note">
            {board === 'unread'
              ? "You're all caught up on the board."
              : 'Nothing is pinned right now.'}
          </p>
        ) : (
          <ul className="announce-items" aria-label="Announcements">
            {shown.map((item) => {
              const unread = item.unreadCount > 0;
              const pinned = item.pinnedForEveryone !== undefined;
              return (
                <li key={item.conversationId}>
                  <div
                    className={`announce-card${item.conversationId === activeId ? ' active' : ''}${
                      unread ? ' unread' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="announce-open"
                      aria-current={item.conversationId === activeId ? 'page' : undefined}
                      onClick={() => onOpen(item.conversationId)}
                    >
                      <span className="announce-top">
                        {pinned ? (
                          <span className="announce-pinned">
                            <PinGlyph filled />
                            Pinned
                          </span>
                        ) : null}
                        {/*
                          A DOT, not a count.

                          A red number is the right signal for "four people said something
                          to you" and the wrong one for a notice: an announcement is read
                          once, so the number is always 1 and says nothing the dot does not.
                        */}
                        {unread ? (
                          <span className="announce-unread" aria-label="Unread" />
                        ) : null}
                        <time
                          className="announce-when"
                          dateTime={item.lastActivityAt}
                          title={new Date(item.lastActivityAt).toLocaleString()}
                        >
                          {relativeTime(item.lastActivityAt)}
                        </time>
                      </span>

                      <span className="announce-name">{item.title ?? 'Announcement'}</span>

                      <span className="announce-preview">
                        {item.lastMessagePreview ?? 'No message yet'}
                      </span>

                      {/*
                        Who issued it. The CREATOR, from the server — see the summary's own
                        note on why it is not the newest sender.
                      */}
                      {item.publisherName !== undefined ? (
                        <span className="announce-by">{item.publisherName}</span>
                      ) : null}
                    </button>

                    {/*
                      The pin, for publishers only.

                      `mayPost` is the server's answer to "may you publish", and pinning is
                      authorized as the same act for the same reason: holding a notice at
                      the top of everybody's board is an editorial decision about what the
                      company should be looking at. A reader sees the badge and no control.
                    */}
                    {mayPost ? (
                      <button
                        type="button"
                        className={`announce-pin${pinned ? ' on' : ''}`}
                        disabled={pinning === item.conversationId}
                        aria-pressed={pinned}
                        aria-label={pinned ? 'Unpin for everyone' : 'Pin for everyone'}
                        title={pinned ? 'Unpin for everyone' : 'Pin for everyone'}
                        onClick={() => void togglePin(item)}
                      >
                        <PinGlyph filled={pinned} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
