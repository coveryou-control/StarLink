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
 * The two actions worth showing on hover: react, and reply.
 *
 * ## Everything else is on right-click
 *
 * There was a third control here — a kebab, whose label is "there is more" — and the menu
 * behind it is now the message's context menu. Right-clicking is what people already do,
 * it is how every desktop application offers the same list, and it costs no pixels beside
 * every message on the screen. See `message-context-menu.tsx`, which also explains why
 * moving it fixed a rendering bug rather than just tidying one.
 *
 * ## Revealed on hover, reachable by keyboard
 *
 * `opacity`, not `display`, so the controls stay in the tab order — a message list where
 * Reply is unreachable without a mouse is a message list half the accessibility
 * requirement fails on. Always visible on touch, where there is no hover to reveal them.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
}: {
  readonly message: MessageView;
  readonly onReply?: ((message: MessageView) => void) | undefined;
  readonly onReact?: ((messageId: string, emoji: string, on: boolean) => void) | undefined;
}): ReactNode {
  const [reactOpen, setReactOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reactOpen) return;
    const close = (): void => setReactOpen(false);
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
  }, [reactOpen]);

  /**
   * A deleted message has nothing to react to or reply to.
   *
   * Showing the bar over "this message was deleted" would be two controls attached to an
   * absence. The row's context menu withholds itself on the same condition.
   */
  if (message.redactedAt !== undefined) return null;
  if (onReply === undefined && onReact === undefined) return null;

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
            onClick={() => setReactOpen((was) => !was)}
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

    </div>
  );
}
