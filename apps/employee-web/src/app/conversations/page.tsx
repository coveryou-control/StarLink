'use client';

import type { ReactNode } from 'react';

import { requestBrowseDirectory, requestNewConversation } from '../../lib/shell-actions';

/**
 * The thread pane before anything is chosen — screen 05.
 *
 * The largest area of the product in the state a returning user sees first, and it was one
 * muted sentence centred in a blank column: a screen that reads as having failed to finish
 * loading rather than one that is waiting for you.
 *
 * The reference's arrangement, in its own order: an 88px tile with a conversation glyph, the
 * state, the next move, and two buttons. The two suggestion chips below them were removed
 * on request: "Suggested · <name>" was a directory lookup rendered as a shortcut nobody
 * asked for, and "# Announcements" duplicated a destination the sidebar already names.
 * Everything on it does
 * something — see each control's note.
 */
export default function NoConversationSelected(): ReactNode {

  return (
    <div className="empty-pane">
      <div className="empty-splash">
        {/*
          A speech bubble, not the product mark.

          The design puts a conversation glyph here rather than the logo — the pane is about
          the absence of a conversation, and a brand mark in the middle of an empty screen
          reads as a splash that failed to finish. It is the one glyph on this screen in the
          brand colour, which is the reference's own choice and rule 1's: it is the subject,
          not a surface.
        */}
        <span className="empty-mark-tile" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="34" height="34" focusable="false">
            <path
              d="M1.47 15.86 0 21l5.27-1.4A10.5 10.5 0 1 0 1.47 15.86Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="empty-splash-text">
          <h2>No conversation open</h2>
          {/*
            The heading states the software's state; this line states the reader's next
            move. Naming the scope — the company directory, not customers — is the sentence
            that stops a Stage 1 pilot user assuming half the product failed to load.
          */}
          <p>
            Pick a chat from the left, or start a new one. Everyone in the company directory
            is already here.
          </p>
        </div>

        {/*
          Both do something. They reach the shell through a window event rather than a prop,
          because this is a route and the state they touch belongs to the layout above it —
          see `shell-actions.ts`.
        */}
        <div className="empty-splash-actions">
          {/* Straight into the chat search: the button says "New chat", so it opens one. */}
          <button type="button" onClick={() => requestNewConversation('chat')}>
            New chat
          </button>
          <button type="button" onClick={requestBrowseDirectory}>
            Browse directory
          </button>
        </div>

      </div>
    </div>
  );
}
