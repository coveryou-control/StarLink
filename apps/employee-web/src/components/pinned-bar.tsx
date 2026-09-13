'use client';

import { useState } from 'react';

import type { PinnedMessage } from '../lib/api-client';

/**
 * What is pinned in this conversation, above the thread.
 *
 * ## One line, not a list
 *
 * A conversation can hold several pins, and showing all of them would give the thread a
 * second scrolling region competing with the first. The newest is shown; a counter says
 * how many there are and expands to the rest. That is the shape every messenger converged
 * on for the same reason: the pin somebody needs is almost always the one just set, and
 * the others are a lookup rather than a reading surface.
 *
 * ## A deleted pin still shows
 *
 * The store returns pins whose message has since been redacted, with an empty body. They
 * render as "This message was deleted" rather than vanishing, because a pin that
 * disappears leaves the group wondering whether they imagined setting it — and because
 * the row is the only place with an unpin control to clear it.
 *
 * ## Clicking jumps to the message
 *
 * A pin nobody can get back to is a quotation. The jump is a scroll within the loaded
 * page; a pin older than what is loaded cannot be reached that way and is reported rather
 * than silently doing nothing, which is the difference between "not loaded yet" and "your
 * click did not work".
 */
export function PinnedBar({
  pins,
  onJump,
  onUnpin,
}: {
  readonly pins: readonly PinnedMessage[];
  /** Scrolls the thread to a message. Returns false when it is not on the loaded page. */
  readonly onJump: (messageId: string) => boolean;
  readonly onUnpin: (messageId: string) => void;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [missed, setMissed] = useState<string | undefined>();

  if (pins.length === 0) return null;

  const shown = expanded ? pins : pins.slice(0, 1);

  return (
    <section className="pinned-bar" aria-label={`${pins.length} pinned`}>
      {shown.map((pin) => (
        <div key={pin.messageId} className="pinned-row">
          <span className="pinned-icon" aria-hidden="true">
            {/* A pushpin, drawn rather than typed: 📌 renders as a colour emoji at a size
                the row cannot absorb, and U+1F4CC has no monochrome presentation. */}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M14.8 2.6a1 1 0 0 0-1.5 1.3l.3.4-4.4 3.2-2.6-.6a1 1 0 0 0-1 1.6l3 3-4.4 5.6a.6.6 0 0 0 .9.8l5.5-4.4 3 3a1 1 0 0 0 1.7-1l-.6-2.6 3.2-4.4.4.3a1 1 0 0 0 1.3-1.5Z" />
            </svg>
          </span>

          <button
            type="button"
            className="pinned-text"
            onClick={() => {
              setMissed(onJump(pin.messageId) ? undefined : pin.messageId);
            }}
            /* The accessible name carries who pinned it, which the visible row has no
               width for. Without it every pinned row reads simply "pinned message". */
            aria-label={`Pinned by ${pin.pinnedByName}: ${
              pin.redacted ? 'this message was deleted' : pin.body
            }`}
          >
            {pin.redacted ? (
              <em className="muted">This message was deleted</em>
            ) : (
              <>
                {pin.senderDisplayName !== undefined ? (
                  <strong>{pin.senderDisplayName}: </strong>
                ) : null}
                {pin.body}
              </>
            )}
          </button>

          <button
            type="button"
            className="pinned-unpin"
            onClick={() => onUnpin(pin.messageId)}
            aria-label="Unpin this message"
            title="Unpin"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}

      {pins.length > 1 ? (
        <button
          type="button"
          className="pinned-more"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : `${pins.length - 1} more pinned`}
        </button>
      ) : null}

      {/*
        Said out loud rather than swallowed. A click that scrolls nowhere is
        indistinguishable from a broken control, and the reason — the message is older
        than the loaded page — is one the person can act on by loading more.
      */}
      {missed !== undefined ? (
        <p className="pinned-note" role="status">
          That message is further back. Load older messages to jump to it.
        </p>
      ) : null}
    </section>
  );
}
