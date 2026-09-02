'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { avatarFor, conversationLabel, initialsFor } from './conversation-naming';
import { PresenceDot, useIsOnline, useOnlineSet } from './presence';
import { useColleague } from './conversation-info';
import type { ConversationSummary } from '../lib/api-client';

/**
 * Who you are talking to, at the top of the thread.
 *
 * ## What this replaces
 *
 * The thread opened with a full-width grey strip carrying a connection dot, and nothing
 * anywhere on the screen said whose conversation it was. The person's name existed only in
 * the sidebar row you clicked to get here — so on a phone, where the sidebar is not on
 * screen at all, the thread was anonymous.
 *
 * A chat application answers "who is this" in its header. That is the whole job here —
 * plus one control that opens the details drawer, which the thread page renders beside the
 * conversation rather than over it.
 *
 * ## The connection state moved into it
 *
 * Realtime status is a property of the conversation you are in, not of the page, and a
 * dedicated strip for it gave a rare condition permanent furniture. It now sits at the end
 * of the header, quiet when healthy and coloured only when it is not.
 */
export function ChatHeader({
  conversation,
  conversationType,
  connection,
  detailsOpen = false,
  onToggleDetails,
  searchOpen = false,
  onToggleSearch,
  pinned = false,
  onTogglePin,
  compact = false,
}: {
  readonly conversation: ConversationSummary | undefined;
  readonly conversationType: string | undefined;
  /** Rendered as-is; the thread page owns what it says. */
  readonly connection: ReactNode;
  readonly detailsOpen?: boolean;
  readonly onToggleDetails?: (() => void) | undefined;
  /**
   * The reference's three header controls, and all three do something.
   *
   * Screen 02 draws a phone, a magnifier and a star. The phone is a call, which StarLink
   * does not have and is not going to — so the row is search, pin and info: the magnifier
   * and star the design draws, plus the control that opens the fourth column. Three buttons
   * in the design's own treatment, none of them a picture of a feature.
   */
  readonly searchOpen?: boolean;
  readonly onToggleSearch?: (() => void) | undefined;
  readonly pinned?: boolean;
  readonly onTogglePin?: (() => void) | undefined;
  /** A phone. The header keeps the back control, the person and one action — see below. */
  readonly compact?: boolean;
}): ReactNode {
  const name =
    conversation !== undefined ? conversationLabel(conversation) : 'Conversation';
  const others = conversation?.participants ?? [];
  const isGroup = conversationType === 'INTERNAL_GROUP' || others.length > 1;

  /**
   * A subtitle only when it says something the title does not.
   *
   * For a direct message the name IS the whole story, and "1 participant" underneath it is
   * furniture. A group earns one: the title is truncated names, so the count is the part a
   * reader cannot infer.
   */
  /**
   * A subtitle only when it says something the title does not.
   *
   * For a group that is the member count, which the title's truncated names cannot carry.
   * For a one-to-one it is "Online" while the colleague holds a lease — and NOTHING
   * otherwise, rather than "Offline": an absent signal is not a claim that somebody has
   * gone home (§21.9), and a line that alternates between two words is more distracting
   * than one that appears when there is news.
   */
  const otherIsOnline = useIsOnline(!isGroup && others.length === 1 ? others[0]?.principalId : undefined);

  /**
   * For a group, WHO is in it — not just how many.
   *
   * "3 members" answers a question nobody asked; the names answer the one they did. The
   * count is appended only when the names are truncated, which is the point at which the
   * number starts carrying information the list has stopped carrying. "You" comes first
   * because a group you are in reads as yours.
   */
  const groupSubtitle = (): string => {
    /*
       "14 members · 4 online" — the reference's own line, and a count rather than names.

       It used to list the first three names, on the reasoning that "3 members" answers a
       question nobody asked. The design disagrees and it has the better of it here: the
       FACES are on the same row now, so the names are already on screen, and three of them
       plus a "+11" is the one thing that cannot fit beside a stack of avatars.
    */
    const members = others.length + 1;
    const line = `${members} ${members === 1 ? 'member' : 'members'}`;
    return onlineCount > 0 ? `${line} · ${onlineCount} online` : line;
  };

  /**
   * How many colleagues in this group are online.
   *
   * Rendered as a second line beside the names rather than as a dot per face: a dot on
   * each avatar in a stack of four overlapping circles is four dots mostly hidden behind
   * each other. Absent when it is zero — see `people-strip.tsx` for why an absent lease is
   * not a claim that anybody has gone home (§21.9).
   */
  const onlineIds = useOnlineSet();
  const onlineCount = others.filter((person) => onlineIds.has(person.principalId)).length;

  /**
   * The colleague's department, which is what the reference puts under the name.
   *
   * Shared with the information panel through one cached lookup, so opening a conversation
   * is one directory request and not two. Absent for a group, and absent when the directory
   * does not carry a department — the line then falls back to presence alone rather than
   * showing an empty separator.
   */
  const colleague = useColleague(!isGroup && others.length === 1 ? others[0]?.principalId : undefined);
  const department =
    colleague?.department !== undefined && colleague.department !== ''
      ? colleague.department
      : undefined;

  /*
     "Marketing · Active now", degrading a piece at a time.

     Presence is still additive and still silent when it is absent: §21.9 makes a missing
     lease "we do not know", never "they have gone home", so "Active now" appears and
     nothing takes its place. With neither fact there is no line, which is the honest
     rendering of knowing nothing beyond the name already in the title.
  */
  const subtitle = isGroup
    ? groupSubtitle()
    : [department, otherIsOnline ? 'Active now' : undefined].filter(Boolean).join(' · ') ||
      undefined;

  return (
    /*
      The details panel used to be a direct child of this header, absolutely positioned
      inside a row 64px tall. It is now a drawer beside the conversation, owned by the
      thread page — so the header is one line again, and the conversation's NAME no longer
      competes with a member search field for a phone's width. It used to lose that
      competition and render as "E..".
    */
    <header className="chat-header">
      {/*
        Back to the list. Visible only on narrow screens (CSS), because on a phone the
        sidebar is not on screen and this is the only way back — a chat app that traps you
        in a thread is broken in a way no test would notice.
      */}
      <Link href="/conversations" className="chat-back" aria-label="Back to conversations">
        {/* Drawn rather than typed. It was a `‹` character, which renders at whatever
            weight the body font gives it — a hairline on the one control a phone user
            needs most. */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            d="M15 4.5 7.5 12l7.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>

      {/*
        A group shows the FACES of the people in it, overlapping; a one-to-one shows the
        one person.

        A single tile with two initials on it is a reasonable list-row shorthand and a poor
        header: the header is where you check you are in the right conversation, and four
        faces answer that faster than the letters "RR". The stack is bounded at four and
        capped with a count, because five overlapping circles stop being faces and start
        being a texture.
      */}
      {isGroup ? null : (
        <span className="avatar-wrap">
          <span className={`chat-avatar${isGroup ? ' group' : ''}`} aria-hidden="true">
            {conversation !== undefined ? avatarFor(conversation).text : initialsFor(name)}
          </span>
          {/* One person, one dot — see `conversation-list.tsx` for why a group gets none. */}
          {!isGroup && others.length === 1 ? (
            <PresenceDot principalId={others[0]?.principalId} />
          ) : null}
        </span>
      )}

      <span className="chat-identity">
        {/*
          "# Ops — Daily standup".

          The hash is the reference's marker for a channel and it is the fastest way to tell
          a group from a person in a header that is otherwise identical. Outside the accessible
          name, which is the conversation's actual title.
        */}
        <h1 className="chat-name" title={name}>
          {isGroup ? <span aria-hidden="true">#&nbsp;</span> : null}
          {name}
        </h1>
        {subtitle !== undefined && subtitle !== '' ? (
          <span className="chat-subtitle" title={subtitle}>
            {isGroup && onlineCount > 0 ? (
              <>
                <span className="chat-online">{onlineCount} online</span>
                {' · '}
              </>
            ) : null}
            {subtitle}
          </span>
        ) : null}
      </span>

      <span className="chat-header-end">
        {connection}

        {/*
          A group shows its FACES and one named button; a one-to-one shows three icon tiles.

          That is screen 03 beside screen 02, and the difference is not decoration: in a
          channel the useful question is who is in here, which four overlapping faces answer
          faster than a number, and the useful action is the one that opens the membership.
          In a one-to-one both are already answered by the avatar to the left of the name.
        */}
        {isGroup && others.length > 0 ? (
          <span className="avatar-stack" aria-hidden="true">
            {others.slice(0, 3).map((person) => (
              <span key={person.principalId} className="chat-avatar stacked">
                {initialsFor(person.displayName)}
              </span>
            ))}
            {others.length > 3 ? (
              <span className="chat-avatar stacked more">+{others.length - 3}</span>
            ) : null}
          </span>
        ) : null}

        {isGroup && onToggleDetails !== undefined ? (
          <button
            type="button"
            className="chat-header-named"
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
          >
            Group info
          </button>
        ) : null}

        {/*
          Search and pin are RAIL-WIDTH controls.

          Screen 08's phone header carries the back control, the person, and two call icons —
          two, not four. Excluding the calls leaves room for the one control that opens a
          place rather than toggling a mode, and three 38px tiles beside a name on a 390px row
          is what the design does not do.

          Not hidden with CSS: a control that is not on the screen must not be in the tab
          order either.
        */}
        {compact || isGroup || onToggleSearch === undefined ? null : (
          <button
            type="button"
            className="chat-header-action"
            onClick={onToggleSearch}
            aria-expanded={searchOpen}
            aria-label="Search in this conversation"
            title="Search in this conversation"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="m15.6 15.6 4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}

        {compact || isGroup || onTogglePin === undefined ? null : (
          <button
            type="button"
            className="chat-header-action"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin from the top of your list' : 'Pin to the top of your list'}
            title={pinned ? 'Unpin' : 'Pin to top'}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="m12 4.2 2.24 4.54 5.01.73-3.62 3.53.85 4.99L12 15.63l-4.48 2.36.85-4.99L4.75 9.47l5.01-.73L12 4.2Z"
                fill={pinned ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}

        {isGroup || onToggleDetails === undefined ? null : (
          <button
            type="button"
            className="chat-header-action chat-details-toggle"
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            aria-label={isGroup ? 'Group details' : 'Conversation details'}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <circle cx="12" cy="5" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="19" r="1.7" fill="currentColor" />
            </svg>
          </button>
        )}
      </span>

    </header>
  );
}
