'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../../lib/api-client';
import { requestBrowseDirectory, requestNewConversation } from '../../lib/shell-actions';

/**
 * The thread pane before anything is chosen — and it says one of two things.
 *
 * ## Why two, and not one with a friendlier tone
 *
 * An empty pane means two completely different situations that happen to look identical
 * from the client:
 *
 *   * **Nobody has ever talked to you here.** There is nothing in the sidebar either, and
 *     the useful thing to say is what this product is and what the four destinations do.
 *   * **You have used StarLink for months and nothing is open right now.** You know what it
 *     is. Being introduced to it again every time you close a thread is the product failing
 *     to recognise its own user, and after the second time it reads as broken.
 *
 * ## Which one, decided by the SERVER
 *
 * `api.firstRun()` asks whether this person has ever been in a conversation of their own —
 * a direct message or a group, ended participation included. Announcements and channels do
 * not count: every active employee is made a participant of every announcement the moment
 * it is posted, so counting those would mean nobody in a workspace that had ever posted one
 * would see the welcome.
 *
 * The empty LIST cannot answer this and must not be used to guess. Somebody who archived
 * their last thread this morning has an empty list and is not a new joiner.
 *
 * ## While the answer is in flight
 *
 * Neither. The quiet state renders nothing but its own frame for the length of one request,
 * because guessing and correcting is worse than either: a returning user who is welcomed for
 * 200ms and then not has seen the product mistake them for a stranger.
 */
export default function NoConversationSelected(): ReactNode {
  /** `undefined` while unknown — see the note above on why neither state is guessed. */
  const [firstTime, setFirstTime] = useState<boolean | undefined>();

  useEffect(() => {
    let live = true;
    void api
      .firstRun()
      .then((result) => {
        if (live) setFirstTime(!result.hasEverConversed);
      })
      /*
         A failed lookup falls back to the RETURNING state, deliberately.

         It is the one that is right for almost everybody and wrong in the least costly way:
         an actual new joiner gets a plain screen with the same two buttons on it, rather
         than an established user being introduced to software they have used for a year.
      */
      .catch(() => {
        if (live) setFirstTime(false);
      });
    return () => {
      live = false;
    };
  }, []);

  if (firstTime === undefined) return <div className="empty-pane" aria-busy="true" />;
  return firstTime ? <FirstRunWelcome /> : <NothingOpen />;
}

/* ------------------------------------------------------------------ the returning user */

/**
 * "No conversation selected" — the state a returning user sees, and the common one.
 *
 * Deliberately light. The heading states the software's state, the line under it states the
 * reader's next move, and the two buttons are the only two things there are to do from here.
 * The three notes at the foot name the destinations without being controls: they are the
 * shape of the product, not a second set of buttons competing with the two above them.
 */
function NothingOpen(): ReactNode {
  return (
    <div className="empty-pane">
      <div className="empty-splash">
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
          <h2>No conversation selected</h2>
          <p>Pick a conversation from the left, or start a new one.</p>
        </div>

        <div className="empty-splash-actions">
          <button type="button" onClick={() => requestNewConversation('chat')}>
            New chat
          </button>
          <button type="button" onClick={requestBrowseDirectory}>
            Browse directory
          </button>
        </div>

        {/*
          Three facts about the product, not three more buttons.

          The reference draws them as a row of small marks at the foot of the pane, and that
          is the right weight: somebody who has used StarLink before does not need them,
          and somebody hesitating over which of two buttons to press is helped by seeing
          what the place is for.
        */}
        <ul className="empty-notes" aria-label="What StarLink is for">
          <li>
            <span className="empty-note-mark" aria-hidden="true">
              <PersonGlyph />
            </span>
            <strong>Message</strong>
            <span>colleagues</span>
          </li>
          <li>
            <span className="empty-note-mark" aria-hidden="true">
              <GroupGlyph />
            </span>
            <strong>Collaborate</strong>
            <span>in groups</span>
          </li>
          <li>
            <span className="empty-note-mark" aria-hidden="true">
              <BuildingGlyph />
            </span>
            <strong>Explore</strong>
            <span>the directory</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- the first-time user */

/**
 * "Welcome to StarLink" — shown once, to somebody who has never started a conversation.
 *
 * Four cards, one per destination the sidebar offers, because on a first visit the question
 * is not "which thread" but "what is this and where do I go". Every card names something
 * that exists and is reachable; none of them is a feature being advertised ahead of itself.
 *
 * The cards are NOT buttons. The two things a new person can usefully do are underneath
 * them, and four clickable cards above two buttons would make six choices out of two.
 */
function FirstRunWelcome(): ReactNode {
  return (
    <div className="empty-pane">
      <div className="empty-splash welcome">
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
          <h2>
            Welcome to <span className="welcome-mark">StarLink</span>
          </h2>
          <p>More than chat. A more connected workplace.</p>
        </div>

        <ul className="welcome-cards">
          <li>
            <span className="welcome-card-mark" aria-hidden="true">
              <PersonGlyph />
            </span>
            <strong>Chats</strong>
            <span>One-to-one conversations with anyone in the company.</span>
          </li>
          <li>
            <span className="welcome-card-mark" aria-hidden="true">
              <GroupGlyph />
            </span>
            <strong>Groups</strong>
            <span>Private threads with the colleagues you choose.</span>
          </li>
          <li>
            <span className="welcome-card-mark" aria-hidden="true">
              <HashGlyph />
            </span>
            <strong>Channels</strong>
            <span>Team and department spaces you can find and join.</span>
          </li>
          <li>
            <span className="welcome-card-mark" aria-hidden="true">
              <MegaphoneGlyph />
            </span>
            <strong>Announcements</strong>
            <span>Company news, read by everyone and posted by a few.</span>
          </li>
        </ul>

        <div className="empty-splash-actions">
          <button type="button" onClick={() => requestNewConversation('chat')}>
            Start a new chat
          </button>
          <button type="button" onClick={requestBrowseDirectory}>
            Browse directory
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------- the glyphs */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const;

function PersonGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.6" r="3.4" {...stroke} />
      <path d="M5.5 19.5c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" {...stroke} strokeLinecap="round" />
    </svg>
  );
}

function GroupGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="9" cy="9" r="3" {...stroke} />
      <path d="M3.2 19c0-3 2.6-4.8 5.8-4.8s5.8 1.8 5.8 4.8" {...stroke} strokeLinecap="round" />
      <path d="M16.2 7.4a3 3 0 0 1 0 5.6M17.5 19c0-2.2-.8-3.6-2-4.5" {...stroke} strokeLinecap="round" />
    </svg>
  );
}

function HashGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M9.4 4 7.8 20M16.2 4l-1.6 16M4.6 9h15M3.8 15h15"
        {...stroke}
        strokeLinecap="round"
      />
    </svg>
  );
}

function MegaphoneGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M4 10v4h3l7 4.5V5.5L7 10H4Z" {...stroke} strokeLinejoin="round" />
      <path d="M17.5 8.6a4.6 4.6 0 0 1 0 6.8" {...stroke} strokeLinecap="round" />
    </svg>
  );
}

function BuildingGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M4.5 20V6.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V20" {...stroke} strokeLinejoin="round" />
      <path d="M13.5 11h5a1 1 0 0 1 1 1v8" {...stroke} strokeLinejoin="round" />
      <path d="M7.5 9h3M7.5 12.5h3M7.5 16h3M16 14.5h1M16 17.5h1M3 20h18" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
