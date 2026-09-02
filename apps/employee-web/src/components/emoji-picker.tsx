'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * A small emoji picker.
 *
 * ## Why this is honest to build
 *
 * It adds no capability the backend does not have. An emoji is a character; inserting one
 * puts UTF-8 into the same `body` field every other character goes into, and the message
 * that results is an ordinary message. Nothing here implies a reaction, a status or a
 * notification — those would all be claims the API cannot support.
 *
 * ## Why a fixed list rather than a library
 *
 * The full Unicode set needs search, skin-tone variants, categories and about 200KB of
 * data, and none of that earns its place in a workplace chat where the realistic use is
 * acknowledging a message. These are the ones people actually send at work, in one grid,
 * with no dependency added.
 */
const EMOJI = [
  '👍', '🙏', '👏', '🎉', '✅', '❌',
  '🙂', '😄', '😅', '🤔', '😐', '😞',
  '🔥', '⚡', '⭐', '💡', '📌', '📎',
  '⏰', '📅', '☕', '🚀', '👀', '💬',
] as const;

export function EmojiPicker({ onPick }: { readonly onPick: (emoji: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="emoji" ref={ref}>
      <button
        type="button"
        className="emoji-toggle"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Insert an emoji"
      >
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
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

      {open ? (
        <div className="emoji-panel" role="dialog" aria-label="Emoji">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onPick(emoji);
                // Closed after one pick: the common case is a single acknowledgement, and
                // a panel that stays open covers the message you are writing.
                setOpen(false);
              }}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
