'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { MessageView } from '../lib/api-client';

/**
 * The reactions the picker opens with, before search.
 *
 * These used to be rendered directly on the hover bar — three emoji, always visible the
 * moment the pointer crossed a message. Three bright glyphs appearing beside every message
 * you hover is a lot of movement for an action people take occasionally, and it made the
 * bar read as a toolbar rather than as something summoned.
 *
 * A single smiley opens them instead, which is the interaction everybody already has from
 * a phone messenger: hover, one face, click it, choose. The set is longer than three now
 * because the picker has room for a row of them.
 */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🎉'] as const;

/**
 * What you can do to a message.
 *
 * ## Every entry works
 *
 * Reply and react are server-backed; copy is a client capability that needs nothing. Edit
 * and delete are server-backed too and appear only on your OWN messages — editing somebody
 * else's words is impersonation and deleting them is moderation, and the server refuses
 * both, so offering them would be offering a refusal.
 *
 * ## Revealed on hover, reachable by keyboard
 *
 * `opacity`, not `display`, so the controls stay in the tab order — a message list where
 * Reply is unreachable without a mouse is a message list half the accessibility
 * requirement fails on. Always visible on touch, where there is no hover to reveal them.
 */
export function MessageActions({
  message,
  isMine,
  onReply,
  onReact,
  onEdit,
  onDelete,
}: {
  readonly message: MessageView;
  /** Gates edit and delete. The server checks the same thing; this stops us offering it. */
  readonly isMine: boolean;
  readonly onReply?: ((message: MessageView) => void) | undefined;
  readonly onReact?: ((messageId: string, emoji: string, on: boolean) => void) | undefined;
  readonly onEdit?: ((message: MessageView) => void) | undefined;
  readonly onDelete?: ((message: MessageView) => void) | undefined;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /*
     One dismissal for both popovers.

     Two `useEffect`s listening for the same outside click was the alternative, and the two
     would race: whichever bound last would close first, and clicking from the reaction
     strip straight onto the kebab closed the strip and then reopened nothing.
  */
  const anyOpen = menuOpen || reactOpen;
  useEffect(() => {
    if (!anyOpen) return;
    const close = (): void => {
      setMenuOpen(false);
      setReactOpen(false);
    };
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anyOpen]);

  /** Cleared on a timer so the confirmation does not become part of the menu. */
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.body);
      setCopied(true);
    } catch {
      /**
       * The clipboard API is refused outside a secure context and in some embedded
       * browsers. Silently doing nothing would look like a broken button, so the menu
       * closes and no confirmation appears — the absence of "Copied" is the signal.
       */
      setMenuOpen(false);
    }
  };

  /**
   * A deleted message has nothing to reply to, react to, copy, edit or delete again.
   *
   * Showing the bar over "this message was deleted" would be five controls attached to
   * an absence.
   */
  if (message.redactedAt !== undefined) return null;
  if (onReply === undefined && onReact === undefined) return null;

  const canEdit = isMine && onEdit !== undefined;
  const canDelete = isMine && onDelete !== undefined;

  return (
    <div className="message-actions" ref={ref}>
      {/*
        One smiley, and the reactions behind it.

        `aria-expanded` rather than a bare button: this opens something, and a screen
        reader has to be told that before the strip appears rather than after.
      */}
      {onReact !== undefined ? (
        <>
          <button
            type="button"
            className="message-action"
            onClick={() => {
              setReactOpen((was) => !was);
              setMenuOpen(false);
            }}
            aria-expanded={reactOpen}
            aria-label="React to this message"
            title="React"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="9.2" cy="10" r="1.1" fill="currentColor" />
              <circle cx="14.8" cy="10" r="1.1" fill="currentColor" />
              <path
                d="M8.4 14.4a4.3 4.3 0 0 0 7.2 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {reactOpen ? (
            <div className="reaction-strip" role="menu" aria-label="React">
              {QUICK.map((emoji) => {
                const mine = message.reactions?.some((r) => r.emoji === emoji && r.mine) ?? false;
                return (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    className={`reaction-choice${mine ? ' mine' : ''}`}
                    onClick={() => {
                      onReact(message.messageId, emoji, !mine);
                      setReactOpen(false);
                    }}
                    aria-pressed={mine}
                    aria-label={`React ${emoji}`}
                    title={emoji}
                  >
                    <span className="emoji-glyph" aria-hidden="true">
                      {emoji}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}

      {onReply !== undefined ? (
        <button
          type="button"
          className="message-action"
          onClick={() => onReply(message)}
          aria-label={`Reply to ${message.senderDisplayName}`}
          title="Reply"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
            <path
              d="M9.5 5.5 3.5 11l6 5.5V13c5 0 8 1.6 10 5-.6-5.6-4-9-10-9.6z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}

      <button
        type="button"
        className="message-action"
        onClick={() => {
          setMenuOpen((was) => !was);
          setReactOpen(false);
        }}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label="More actions"
        title="More"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="1.7" fill="currentColor" />
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
          <circle cx="19" cy="12" r="1.7" fill="currentColor" />
        </svg>
      </button>

      {menuOpen ? (
        <div className="message-menu" role="menu" aria-label="Message actions">
          <button type="button" role="menuitem" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy text'}
          </button>
          {onReply !== undefined ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onReply(message);
                setMenuOpen(false);
              }}
            >
              Reply
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onEdit(message);
                setMenuOpen(false);
              }}
            >
              Edit
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              role="menuitem"
              className="menu-danger"
              onClick={() => {
                onDelete(message);
                setMenuOpen(false);
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
