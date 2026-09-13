'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { api, ApiError } from '../lib/api-client';
import { initialsFor, senderColour } from './conversation-naming';

interface Reactor {
  readonly principalId: string;
  readonly emoji: string;
  readonly at: string;
}

/**
 * Who reacted to one message, and with what.
 *
 * ## Fetched when it is opened, never with the page
 *
 * The message listing sends `{emoji, count, mine}` and deliberately no ids: shipping the
 * reactors for every message on every page would put a continuous profile of who is paying
 * attention to whom on the wire, to decorate a list. One request when somebody actually
 * asks is the same information at a fraction of the exposure.
 *
 * ## Names are resolved here, not on the server
 *
 * The endpoint returns principal ids. The thread already holds this conversation's
 * participants, so the name is a map read against data on the page — the same trick the
 * typing indicator uses, and it avoids a directory lookup per reactor on a request that
 * fires every time a popover opens. Somebody the summary does not list shows as "Someone",
 * which is honest: they may have left the conversation since.
 */
export function ReactionDetails({
  conversationId,
  messageId,
  participants,
  currentPrincipalId,
  initialEmoji,
  anchor,
  onClose,
  onRemoveOwn,
}: {
  readonly conversationId: string;
  readonly messageId: string;
  readonly participants: readonly { principalId: string; displayName: string }[];
  readonly currentPrincipalId: string;
  /** The chip that was clicked, pre-selected. */
  readonly initialEmoji: string;
  /**
   * Where the chip that opened this is, in `.message-stack` coordinates.
   *
   * `left` is already clamped to the column by the caller — the panel is not allowed to
   * discover it is off-screen and correct itself, because that correction would be a
   * visible jump after the panel is on screen. `caret` is the arrow's inset from the
   * panel's own left edge, which is not `left` subtracted from anything the stylesheet
   * can see once the clamp has been applied.
   */
  readonly anchor: { readonly left: number; readonly caret: number };
  readonly onClose: () => void;
  readonly onRemoveOwn: () => void;
}): ReactNode {
  const [reactors, setReactors] = useState<readonly Reactor[] | undefined>();
  const [failed, setFailed] = useState(false);
  /** `undefined` is the "All" tab. */
  const [tab, setTab] = useState<string | undefined>(initialEmoji);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const page = await api.reactors(conversationId, messageId);
        if (live) setReactors(page.reactors);
      } catch (cause) {
        if (live && !(cause instanceof ApiError && cause.isUnauthenticated)) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [conversationId, messageId]);

  /*
     Three ways out: the close button, Escape, and a click anywhere else.

     Escape alone is a trap for anybody using a mouse, and the × alone is a trap for
     anybody who does not spot it — a popover that has to be dismissed exactly one way is
     the kind of thing people report as "it will not close". Clicking away is what everyone
     tries first, so it is what closes it.

     `mousedown` rather than `click`: the panel hangs over the messages behind it, and
     waiting for a full click means the press lands on a message and only THEN dismisses,
     so the thing underneath gets pressed on the way out.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent): void => {
      if (panelRef.current?.contains(event.target as Node) === true) return;
      /* The chips are left to their own handler, which TOGGLES. Closing here first would
         make a second press on the same chip close and immediately reopen the panel. */
      if ((event.target as Element).closest?.('.reactions') !== null) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    /* Capture, so a handler that stops propagation on the way up cannot strand the panel. */
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  const nameOf = (principalId: string): string =>
    principalId === currentPrincipalId
      ? 'You'
      : (participants.find((person) => person.principalId === principalId)?.displayName ??
        'Someone');

  const all = reactors ?? [];
  /* Tabs in the order people first used them, so the row does not reshuffle between opens. */
  const emojis = [...new Set(all.map((entry) => entry.emoji))];
  const shown = tab === undefined ? all : all.filter((entry) => entry.emoji === tab);
  const mine = all.find((entry) => entry.principalId === currentPrincipalId);

  return (
    <div
      className="reaction-details"
      role="dialog"
      aria-label="Reactions"
      ref={panelRef}
      style={
        {
          left: `${anchor.left}px`,
          '--reaction-caret': `${anchor.caret}px`,
        } as CSSProperties
      }
    >
      <header className="reaction-details-head">
        <strong>{all.length === 1 ? '1 reaction' : `${all.length} reactions`}</strong>
        <button type="button" className="reaction-details-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Only worth a tab row when there is more than one thing to switch between. */}
      {emojis.length > 1 ? (
        <div className="reaction-details-tabs" role="tablist" aria-label="Filter by reaction">
          <button
            type="button"
            role="tab"
            aria-selected={tab === undefined}
            className={tab === undefined ? 'active' : undefined}
            onClick={() => setTab(undefined)}
          >
            All {all.length}
          </button>
          {emojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="tab"
              aria-selected={tab === emoji}
              className={tab === emoji ? 'active' : undefined}
              onClick={() => setTab(emoji)}
            >
              <span aria-hidden="true">{emoji}</span>{' '}
              {all.filter((entry) => entry.emoji === emoji).length}
            </button>
          ))}
        </div>
      ) : null}

      {failed ? (
        <p className="reaction-details-note" role="alert">
          Could not load who reacted.
        </p>
      ) : reactors === undefined ? (
        <p className="reaction-details-note">Loading…</p>
      ) : (
        <ul className="reaction-details-list">
          {shown.map((entry) => {
            const isMine = entry.principalId === currentPrincipalId;
            return (
              <li key={`${entry.principalId}-${entry.emoji}`}>
                <span
                  className="reaction-details-avatar"
                  aria-hidden="true"
                  style={{ color: senderColour(entry.principalId) }}
                >
                  {initialsFor(nameOf(entry.principalId))}
                </span>
                <span className="reaction-details-name">
                  {nameOf(entry.principalId)}
                  {/* Your own row says how to undo it — the one action this panel can
                      offer that the thread behind it cannot do in fewer steps. */}
                  {isMine ? (
                    <button type="button" className="reaction-details-remove" onClick={onRemoveOwn}>
                      Remove
                    </button>
                  ) : null}
                </span>
                <span className="reaction-details-emoji" aria-hidden="true">
                  {entry.emoji}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {reactors !== undefined && mine === undefined && all.length > 0 ? (
        <p className="reaction-details-note">You have not reacted to this message.</p>
      ) : null}
    </div>
  );
}
