'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { MessageView } from '../lib/api-client';

/**
 * The quick reactions offered on the hover bar.
 *
 * Three, not a picker. The bar appears on hover over a message and its job is one tap;
 * a grid of twenty-four there would be a second decision on top of the first, and the full
 * set already exists in the composer. These are the three that carry the meanings people
 * actually need from a reaction at work — agreed, appreciated, amused.
 */
const QUICK = ['👍', '❤️', '😂'] as const;

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
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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
      {onReact !== undefined
        ? QUICK.map((emoji) => {
            const mine = message.reactions?.some((r) => r.emoji === emoji && r.mine) ?? false;
            return (
              <button
                key={emoji}
                type="button"
                className="message-action"
                onClick={() => onReact(message.messageId, emoji, !mine)}
                aria-pressed={mine}
                aria-label={`React ${emoji}`}
                title={`React ${emoji}`}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            );
          })
        : null}

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
        onClick={() => setMenuOpen((was) => !was)}
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
