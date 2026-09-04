'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MUTE_DURATIONS_MINUTES, muteDurationLabel } from '@starlink/shared-contracts';

/**
 * What you can do to a conversation from its row in the list, on right-click.
 *
 * ## Why a portal and `position: fixed`, again
 *
 * The same reason `message-context-menu.tsx` needs them, and worth restating because the
 * failure looks like a z-index problem and is not one. Each `<li>` in the list paints in
 * document order; a menu that overflows its own row is painted over by every row below it,
 * whatever index it asks for, because z-index only orders siblings inside one stacking
 * context. Portalled to `document.body` there is no ancestor left to be trapped by — and
 * no scroller left to be clipped by, which is the same defect in different clothes.
 *
 * ## Why the list is short
 *
 * Archive, block, clear chat and delete chat are all absent, and none of them is an
 * oversight. StarLink is the record of what colleagues said to each other; a control that
 * lets one side remove their copy of it is a control for disagreeing with the audit
 * ledger, which is append-only by rule 8. What is here instead are the two things that are
 * genuinely about YOUR view of the list and nobody else's: where it sits, and whether it
 * is allowed to interrupt you.
 *
 * ## Mute opens a second step rather than a submenu
 *
 * Six durations do not belong on the first screen of a two-item menu, and a hover-out
 * submenu is the control people miss on a trackpad. Pressing "Mute" replaces the menu's
 * contents in place — same box, same position — which is one click either way and cannot
 * be lost by moving the pointer diagonally.
 */
export function ConversationRowMenu({
  conversationId,
  label,
  pinned,
  mutedUntil,
  at,
  onTogglePin,
  onMute,
  onClose,
}: {
  readonly conversationId: string;
  readonly label: string;
  readonly pinned: boolean;
  /** When the mute ends; absent when the conversation is not muted. */
  readonly mutedUntil: string | undefined;
  /** Viewport coordinates of the click that opened it. */
  readonly at: { readonly x: number; readonly y: number };
  readonly onTogglePin: (conversationId: string, next: boolean) => void;
  /** `null` unmutes. Minutes are always one of `MUTE_DURATIONS_MINUTES`. */
  readonly onMute: (conversationId: string, minutes: number | null) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);
  /** The menu's second page. There is no third. */
  const [choosingMute, setChoosingMute] = useState(false);

  /* Measured and pulled inside the viewport BEFORE the browser paints, so a right-click
     near the foot of the list does not open a menu whose last item is off the screen —
     and does not visibly jump after opening, which a `useEffect` would give.

     `choosingMute` is a dependency because the duration page is taller than the two items
     it replaces: without it, a menu opened near the bottom grows off the screen the
     moment somebody presses Mute. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = el.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.min(at.x, window.innerWidth - box.width - margin),
      y: Math.min(at.y, window.innerHeight - box.height - margin),
    });
  }, [at, choosingMute]);

  useEffect(() => {
    const dismiss = (): void => onClose();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    /* Capture, so a scroll inside the list closes it too: a menu pinned to viewport
       coordinates is wrong the moment the row it points at moves. */
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="message-menu"
      role="menu"
      aria-label={`Actions for ${label}`}
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {choosingMute ? (
        <>
          <p className="menu-heading">Mute for</p>
          {MUTE_DURATIONS_MINUTES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="menuitem"
              onClick={() => {
                onMute(conversationId, minutes);
                onClose();
              }}
            >
              {muteDurationLabel(minutes)}
            </button>
          ))}
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onTogglePin(conversationId, !pinned);
              onClose();
            }}
          >
            {pinned ? 'Unpin chat' : 'Pin chat'}
          </button>

          {/*
             The label says WHEN it ends, not just that it is muted.

             "Muted" is a state somebody has to remember setting; "Muted until 15:40" is a
             fact they can act on — and it is the only place the end of the lease is
             visible, because a muted conversation looks exactly like any other in the list
             (§29.6: the unread count is not a preference).
          */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (mutedUntil !== undefined) {
                onMute(conversationId, null);
                onClose();
                return;
              }
              setChoosingMute(true);
            }}
          >
            {mutedUntil !== undefined
              ? `Unmute (until ${new Date(mutedUntil).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })})`
              : 'Mute notifications'}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
