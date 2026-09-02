'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import type { ConversationSummary } from '../lib/api-client';
import type { NotificationsState } from '../lib/use-notifications';
import { conversationLabel, relativeTime } from './conversation-naming';

/**
 * Notifications as a place, not a popover.
 *
 * It was a dropdown hanging off a button in the page header, which is where a web app puts
 * notifications and not where a communication product does. Given a panel of its own it
 * can show what each item is, whether it has been read, and how many events folded into
 * it, without any of it being cramped.
 *
 * ## Reference only — no message content
 *
 * §29.2's outbox never held message bodies, so there is nothing to render here but the
 * event and a link to the thing it points at. That is deliberate: a notification list
 * carrying conversation excerpts would be a copy of the inbox with the object check
 * removed, which is the objection §30.4 makes about a search index. Opening the
 * conversation is how the message gets read, behind the authorization that guards it.
 */
export function NotificationsPanel({
  state,
  onOpenConversation,
  conversations = [],
}: {
  readonly state: NotificationsState;
  readonly onOpenConversation: (conversationId: string) => void;
  /**
   * The threads the shell already holds, purely so a row can NAME the one it points at.
   *
   * Screen 06 writes "mentioned you in # Ops — Daily standup"; §29.2's phrase is
   * "You were mentioned in a conversation" and it stays exactly that, because it is a
   * transcription and the API owns it. The room's name goes on the second line instead,
   * beside the time — which is additive, costs no request, and cannot disagree with the
   * sidebar because it is read from the same summaries.
   *
   * Absent for a conversation further back than the loaded page; then the line is the time
   * alone, as before.
   */
  readonly conversations?: readonly ConversationSummary[];
}): ReactNode {
  const { load } = state;

  const roomName = (conversationId: string | undefined): string | undefined => {
    if (conversationId === undefined) return undefined;
    const found = conversations.find((c) => c.conversationId === conversationId);
    return found === undefined ? undefined : conversationLabel(found);
  };

  // Loaded when the panel is shown rather than on every render of the shell: the list is
  // a read the badge does not need, and the badge is what polls.
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel" aria-label="Notifications">
      <header className="panel-head">
        <h2>Notifications</h2>
        <button
          type="button"
          className="panel-action"
          onClick={() => void state.markAllRead()}
          disabled={state.unread === 0}
        >
          Mark all read
        </button>
      </header>

      <div className="panel-body" aria-live="polite">
        {state.error !== undefined ? (
          <p role="alert" className="result-note result-note-error">
            {state.error}
          </p>
        ) : null}

        {state.loading && state.items.length === 0 ? (
          <ul className="notification-list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <div className="notification-row skeleton-row">
                  <span className="skeleton-line" style={{ width: '70%' }} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {!state.loading && state.items.length === 0 && state.error === undefined ? (
          <p className="state-note">
            <strong>You are all caught up</strong>
            Anything that needs you will appear here.
          </p>
        ) : null}

        <ul className="notification-list">
          {state.items.map((item) => (
            <li key={item.notificationId}>
              <button
                type="button"
                className={`notification-row${item.read ? '' : ' unread'}`}
                onClick={() => {
                  void state.markRead(item.notificationId);
                  if (item.targetRef !== undefined) onOpenConversation(item.targetRef);
                }}
              >
                {/*
                  The reference puts the ACTOR's avatar here. A notification is body-free by
                  design (§29.2) and carries no actor — it points at a conversation, it does
                  not say who did what — so the circle carries the EVENT instead: a mention,
                  a file, a reaction, a membership change. Same 36px marker, same job of
                  telling three kinds of row apart at a glance, and nothing invented.
                */}
                <span
                  className={`notification-avatar ${toneOf(item.event)}`}
                  aria-hidden="true"
                >
                  {glyphFor(item.event)}
                </span>

                <span className="notification-text">
                  {/* §29.2's own phrase, sent by the API so the wording lives in one place. */}
                  <span className="notification-subject">{item.subject}</span>
                  <span className="notification-when">
                    {roomName(item.targetRef) !== undefined ? (
                      <>
                        <span className="notification-room">{roomName(item.targetRef)}</span>
                        {item.createdAt !== undefined ? ' · ' : ''}
                      </>
                    ) : null}
                    {item.createdAt !== undefined ? relativeTime(item.createdAt) : null}
                    {/* §29.5: already the total ("3 new messages"), not the fold count. */}
                    {item.count > 1 ? `${item.createdAt !== undefined ? ' · ' : ''}${item.count} events` : ''}
                  </span>
                </span>

                {/* Unread is a dot AND a tinted row, never colour alone (NFR-ACC-3). */}
                {!item.read ? (
                  <>
                    <span className="notification-dot" aria-hidden="true" />
                    <span className="sr-only">Unread</span>
                  </>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Which of the design's three tints a notification takes.
 *
 * By EVENT, not by chance: the reference gives each kind of row a different tint, and the
 * value of that is being able to tell "somebody named me" from "somebody shared a file"
 * without reading either. An unrecognised event takes the neutral — rule 4's shape applied
 * to a colour, and the reason a new event type renders plainly rather than wrongly.
 */
function toneOf(event: string): string {
  if (event === 'MENTIONED') return 'brand';
  if (event.includes('ATTACHMENT') || event.includes('FILE')) return 'info';
  return 'neutral';
}

/** One glyph per kind, drawn rather than typed — see the rail for why not an emoji. */
function glyphFor(event: string): ReactNode {
  if (event === 'MENTIONED') {
    return (
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M16 12v1.6a2.6 2.6 0 0 0 5.2 0V12a9.2 9.2 0 1 0-3.6 7.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (event.includes('ATTACHMENT') || event.includes('FILE')) {
    return (
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
        <path
          d="M13.5 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5l-5-5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M13.5 4.5v5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M4 5.5h16v10H8.5L4 19V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
