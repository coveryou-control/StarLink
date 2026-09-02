'use client';

/**
 * Announcements — the rail's third destination, and the bottom nav's.
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
 * ## The compose control is asked for, never assumed
 *
 * Most people may read announcements and not write them. The button is drawn only when the
 * server says the caller holds `conversation.announcement.post` — a convenience, not the
 * boundary: `POST` decides again, and that decision is the one that counts. A reader who is
 * shown a button that answers 404 learns that the product is unreliable, which is a worse
 * failure than not seeing the button.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type ConversationSummary } from '../lib/api-client';
import { relativeTime } from './conversation-naming';

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

  const load = async (): Promise<void> => {
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
  };

  useEffect(() => {
    void load();
    void api
      .mayAnnounce()
      .then((result) => setMayPost(result.mayPost))
      // Fail CLOSED: a permission we could not read is not a permission held.
      .catch(() => setMayPost(false));
  }, []);

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

  return (
    <section className="panel" aria-label="Announcements">
      <header className="panel-head">
        <h2>Announcements</h2>
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

        {problem !== undefined ? (
          <p className="panel-note" role="alert">
            {problem}
          </p>
        ) : items === undefined ? (
          <p className="panel-note">Loading…</p>
        ) : items.length === 0 ? (
          <p className="panel-note">
            Nothing has been announced yet.
            {mayPost ? ' You can open the first one.' : ''}
          </p>
        ) : (
          <ul className="conversation-items" aria-label="Announcements">
            {items.map((item) => (
              <li key={item.conversationId}>
                <button
                  type="button"
                  className={`conversation-row${item.conversationId === activeId ? ' active' : ''}`}
                  aria-current={item.conversationId === activeId ? 'page' : undefined}
                  onClick={() => onOpen(item.conversationId)}
                >
                  <span className="row-avatar announcement" aria-hidden="true">
                    {/* A megaphone, drawn rather than typed: an emoji here renders at
                        whatever the platform decides and is read aloud as its own name. */}
                    <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
                      <path
                        d="M4 10v4h3l6 4V6l-6 4H4Zm13.5-1.5a5 5 0 0 1 0 7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="row-text">
                    <span className="row-top">
                      <strong className="row-name">{item.title ?? 'Announcement'}</strong>
                      <time
                        className="row-time"
                        dateTime={item.lastActivityAt}
                        title={new Date(item.lastActivityAt).toLocaleString()}
                      >
                        {relativeTime(item.lastActivityAt)}
                      </time>
                    </span>
                    <span className="row-bottom">
                      <span className="row-preview">
                        {item.lastMessagePreview ?? 'No message yet'}
                      </span>
                      {item.unreadCount > 0 ? (
                        <span className="row-unread">{item.unreadCount}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
