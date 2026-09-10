'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 * ## One control, revealed on hover
 *
 * Reply was here too and has gone into the context menu: the request asked for the smiley
 * alone. Reacting keeps the permanent target because it is the only one of the four with
 * no command-shaped alternative — it opens a picker, not an action.
 *
 * `opacity`, not `display`, so the button stays in the tab order. That is now doing more
 * work than it was: it is the row's only tab stop, and `message-list.tsx` hangs the
 * ContextMenu / Shift+F10 handler off the row so that reaching this button is also how a
 * keyboard reaches Reply, Edit and Delete. Always visible on touch, where there is no
 * hover to reveal it.
 */
export function MessageActions({
  message,
  onReact,
}: {
  readonly message: MessageView;
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
   * The strip, pulled back inside the thread column.
   *
   * ## Why the stylesheet cannot do this
   *
   * The strip is 264px wide and hangs off a 28px bar, and where that bar sits depends on
   * how wide the BUBBLE is — the bar is in the gutter beside the message, so a long message
   * puts it near the right edge of the column and a short one puts it near the left. CSS
   * can express "open rightward" or "open leftward"; it cannot ask whether there is room.
   *
   * The sheet chose per row type instead: rightward for incoming, leftward for your own.
   * That holds at 1440 and fails at 900, where an incoming message wide enough to push the
   * bar past x=636 sends the strip off the right edge — measured at 900px on two of three
   * conversations, with the last two choices unreachable. This is the same failure the
   * `internal` rule already carries a comment about, in a case that rule does not cover.
   *
   * ## What it does
   *
   * One measurement after the strip is in the DOM and before the browser paints, so there
   * is no visible correction: if either end is outside the thread column, shift by exactly
   * the overhang. A strip that already fits is not touched, and `useLayoutEffect` rather
   * than `useEffect` is what keeps a shifted one from being seen in its wrong place first.
   */
  const stripRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);

  useLayoutEffect(() => {
    if (!reactOpen) {
      setNudge(0);
      return;
    }
    const strip = stripRef.current;
    const column = strip?.closest('.thread');
    if (strip == null || column == null) return;
    const box = strip.getBoundingClientRect();
    const within = column.getBoundingClientRect();
    /* The column's 28px padding is fair game - the strip may sit in it - but the pane
       beyond it is not. `MARGIN` keeps the shadow off the edge as well as the strip. */
    const MARGIN = 8;
    const overRight = box.right - (within.right - MARGIN);
    const overLeft = within.left + MARGIN - box.left;
    const shift = overRight > 0 ? -overRight : overLeft > 0 ? overLeft : 0;
    /* Rounded, because a fractional translate blurs an emoji at these sizes. */
    setNudge(Math.round(shift));
  }, [reactOpen]);

  /**
   * A deleted message has nothing to react to or reply to.
   *
   * Showing the bar over "this message was deleted" would be two controls attached to an
   * absence. The row's context menu withholds itself on the same condition.
   */
  if (message.redactedAt !== undefined) return null;
  if (onReact === undefined) return null;

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
            <div
              className="reaction-strip"
              role="menu"
              aria-label="React"
              ref={stripRef}
              style={nudge === 0 ? undefined : { transform: `translateX(${nudge}px)` }}
            >
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

    </div>
  );
}
