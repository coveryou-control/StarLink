'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MUTE_DURATIONS_MINUTES, muteDurationLabel } from '@starlink/shared-contracts';

/**
 * The chat header's overflow menu.
 *
 * ## What is in it, and what is deliberately not
 *
 * The reference list was WhatsApp's header menu with ten of its items struck out. Of what
 * remained, these four are things StarLink can actually do:
 *
 *   - **Contact info / Group info** — the same panel the identity block opens. It is here
 *     as well because a menu that omits the one thing the header is mostly used for sends
 *     people back out of it.
 *   - **Search** — moved in from a fourth icon tile. Three 38px tiles beside a name on a
 *     390px row is what the design does not do.
 *   - **Close chat** — back to the list. On a phone the back chevron does this; at desk
 *     width there was no way to leave a conversation without opening another one.
 *   - **Mute notifications** — the same six durations the conversation's row offers, and
 *     the same second page rather than a submenu. It is here as well as on the row because
 *     the moment you want to quieten a conversation is usually the moment you are in it.
 *
 * **Select messages** is absent for a different reason. A selection mode is only worth
 * having for a bulk action, and the two it exists for elsewhere — bulk forward, bulk
 * delete — are not built. A mode you can enter and not act in is a dead end with a
 * cancel button.
 *
 * ## Why it is portalled
 *
 * Same reason as every other menu here: the header is 68px tall with `overflow` of its own
 * and its own stacking context, so an absolutely-positioned menu inside it is clipped or
 * painted over regardless of z-index. Portalled to the body and anchored to the button's
 * measured position, it has no ancestor left to be trapped by.
 */
export function ChatHeaderMenu({
  isGroup,
  anchor,
  mutedUntil,
  onOpenDetails,
  onSearch,
  onCloseChat,
  onMute,
  onDismiss,
}: {
  readonly isGroup: boolean;
  /** The trigger's viewport rect, so the menu hangs under its right edge. */
  readonly anchor: DOMRect;
  /** When this reader's mute ends; absent when the conversation is not muted. */
  readonly mutedUntil: string | undefined;
  readonly onOpenDetails: (() => void) | undefined;
  readonly onSearch: (() => void) | undefined;
  readonly onCloseChat: () => void;
  /** `null` unmutes. Minutes are always one of `MUTE_DURATIONS_MINUTES`. */
  readonly onMute: ((minutes: number | null) => void) | undefined;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: anchor.right, y: anchor.bottom + 6 });
  /** The menu's second page: the mute durations. */
  const [choosingMute, setChoosingMute] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = el.getBoundingClientRect();
    const margin = 8;
    /* Right-aligned to the trigger, which is how a menu hanging off the end of a toolbar
       reads, then pulled back inside the viewport if that would overflow. */
    setPosition({
      x: Math.max(margin, Math.min(anchor.right - box.width, window.innerWidth - box.width - margin)),
      y: Math.min(anchor.bottom + 6, window.innerHeight - box.height - margin),
    });
    /* `choosingMute` too: the duration page is taller than the three items it replaces,
       and without re-measuring it grows past the bottom of a short window. */
  }, [anchor, choosingMute]);

  useEffect(() => {
    const dismiss = (): void => onDismiss();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [onDismiss]);

  const choose = (action: () => void): void => {
    action();
    onDismiss();
  };

  return createPortal(
    <div
      ref={ref}
      className="message-menu"
      role="menu"
      aria-label="Conversation actions"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {choosingMute && onMute !== undefined ? (
        <>
          <p className="menu-heading">Mute for</p>
          {MUTE_DURATIONS_MINUTES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="menuitem"
              onClick={() => choose(() => onMute(minutes))}
            >
              {muteDurationLabel(minutes)}
            </button>
          ))}
        </>
      ) : (
        <>
          {onOpenDetails !== undefined ? (
            <button type="button" role="menuitem" onClick={() => choose(onOpenDetails)}>
              {isGroup ? 'Group info' : 'Contact info'}
            </button>
          ) : null}
          {onSearch !== undefined ? (
            <button type="button" role="menuitem" onClick={() => choose(onSearch)}>
              Search
            </button>
          ) : null}
          {onMute !== undefined ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (mutedUntil !== undefined) {
                  choose(() => onMute(null));
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
          ) : null}
          <button type="button" role="menuitem" onClick={() => choose(onCloseChat)}>
            Close chat
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
