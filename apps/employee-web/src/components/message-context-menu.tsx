'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { MessageView } from '../lib/api-client';

/**
 * What you can do to a message, on right-click.
 *
 * ## Why right-click, and why the three dots are gone
 *
 * The hover bar carried a kebab, and a kebab is a button whose label is "there is more".
 * Right-clicking a message is what people already do — it is how every desktop application
 * and every desktop messenger offers the same list — and it costs no pixels beside every
 * message on the screen. The smiley and the reply arrow stay on hover, because those are
 * the two actions worth making visible; the rest lives here.
 *
 * ## Why a portal, which is the actual bug fix
 *
 * The menu used to be `position: absolute` inside `.message-actions`, and it rendered
 * BEHIND the messages below it. `z-index: 30` did not help and could not: `.message-actions`
 * sits inside a `.message-row`, each row paints in document order, and a later row paints
 * over an earlier row's overflowing child whatever z-index that child asks for — the index
 * only orders siblings within one stacking context.
 *
 * Portalled to `document.body` and positioned `fixed`, the menu has no ancestor left to be
 * trapped by. It also means it can never be clipped by a scroller, which is the same defect
 * wearing different clothes.
 *
 * ## Placed at the pointer, then pulled back on screen
 *
 * A context menu belongs where the click was. `useLayoutEffect` measures it and nudges it
 * inside the viewport before the browser paints, so a right-click near the bottom of the
 * thread does not open a menu with its last item off the screen — and does not visibly jump
 * after opening either, which is what a `useEffect` would give.
 */
export function MessageContextMenu({
  message,
  at,
  canEdit,
  canDelete,
  onReply,
  onEdit,
  onDelete,
  onClose,
}: {
  readonly message: MessageView;
  /** Viewport coordinates of the click that opened it. */
  readonly at: { readonly x: number; readonly y: number };
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onReply?: ((message: MessageView) => void) | undefined;
  readonly onEdit?: ((message: MessageView) => void) | undefined;
  readonly onDelete?: ((message: MessageView) => void) | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = el.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.min(at.x, window.innerWidth - box.width - margin),
      y: Math.min(at.y, window.innerHeight - box.height - margin),
    });
  }, [at]);

  useEffect(() => {
    const dismiss = (): void => onClose();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    /*
       `pointerdown` anywhere closes it, including inside the menu — the item's own click
       fires first and does what it does. Scroll and resize close it too: a menu pinned to
       viewport coordinates is wrong the moment the thing it points at moves.
    */
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
  }, [onClose]);

  /** Cleared on a timer, so the confirmation does not become part of the menu. */
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.body);
      setCopied(true);
    } catch {
      /**
       * The clipboard API is refused outside a secure context and in some embedded
       * browsers. Silently doing nothing would look like a broken item, so the menu closes
       * and no confirmation appears — the absence of "Copied" is the signal.
       */
      onClose();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="message-menu"
      role="menu"
      aria-label="Message actions"
      style={{ left: position.x, top: position.y }}
      /* The menu is inside the dismiss listener's document, so a click on an ITEM must not
         also be read as a click outside one. */
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy text'}
      </button>
      {onReply !== undefined ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onReply(message);
            onClose();
          }}
        >
          Reply
        </button>
      ) : null}
      {canEdit && onEdit !== undefined ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onEdit(message);
            onClose();
          }}
        >
          Edit
        </button>
      ) : null}
      {canDelete && onDelete !== undefined ? (
        <button
          type="button"
          role="menuitem"
          className="menu-danger"
          onClick={() => {
            onDelete(message);
            onClose();
          }}
        >
          Delete
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
