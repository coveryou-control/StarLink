'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { BrandMark } from './brand';
import { initialsFor } from './conversation-naming';
import { ConfirmDialog } from './confirm-dialog';

/**
 * The places StarLink has, and the two shapes they take.
 *
 * The sidebar used to be a vertical stack of unrelated panels — start-a-conversation, the
 * list, a message search, a directory, and in Stage 2 a queue and a load table — all
 * visible at once, all competing for the same column. Nothing said which of them was the
 * main thing, and on a laptop the conversation list, which is the main thing, was the part
 * that got squeezed.
 *
 * A rail fixes the hierarchy rather than the spacing: one destination is open at a time,
 * the rest are one click away, and the list gets the whole panel.
 */
/**
 * Notifications is NOT a destination.
 *
 * It was a fifth tile with an unread badge, and the panel behind it was a list of things
 * that had already happened somewhere you could go and look. A message arriving now makes
 * a sound and, when the application is not the thing you are looking at, raises a system
 * notification — which is where a person expects to be told, and it does not cost a
 * permanent tab to say it. The unread counts on the conversation rows are unchanged; §29.6
 * calls those "the unread mechanism" and nothing here touches them.
 */
export type RailSection = 'chats' | 'people' | 'announcements' | 'settings';

const SECTIONS: readonly {
  readonly id: RailSection;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  {
    id: 'chats',
    label: 'Chats',
    icon: (
      <path
        d="M4 5.5h16v10H8.5L4 19V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    ),
  },
  {
    id: 'people',
    label: 'People',
    icon: (
      <>
        <circle cx="9.5" cy="8.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M3.5 19.5c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M16.2 6.2a3 3 0 0 1 0 5.6M17.5 14.6c2 .6 3.3 2.3 3.3 4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    id: 'announcements',
    label: 'Announcements',
    /* A megaphone. Drawn rather than an emoji: an emoji renders at whatever weight and
       colour the platform decides, which is the one thing a rail icon cannot afford. */
    icon: (
      <>
        <path
          d="M4 10v4h3l7 4.5V5.5L7 10H4Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M17.5 8.6a4.6 4.6 0 0 1 0 6.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    /*
       A cog, drawn as a toothed ring — not a circle with eight spokes around it.

       The spoked version renders as a SUN at 22px, which is what a brightness control looks
       like, and the one at the foot of a dark rail read as exactly that. The reference draws
       a cog; this is a cog.
    */
    icon: (
      <>
        <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </>
    ),
  },
];

/**
 * Which destinations the bar carries, and in which group.
 *
 * ## On the rail
 *
 * Four tiles at the top, a spacer, then Settings and the avatar at the bottom — the
 * reference's own arrangement. Settings sits apart from the four because it is not a place
 * you go to work; putting it in the same run makes "where the product happens" a five-way
 * choice.
 *
 * ## On a phone
 *
 * Four, and only four: Chats, People, Announcements, You. That is the reference's bottom
 * nav, and the arithmetic is not negotiable either — five targets across a 320px screen
 * leaves 64px each, and the rule sheet's touch minimum is 44px with space to miss by.
 *
 * So Notifications is not dropped, it MOVES: on a phone it is a control in the panel's own
 * header, where it keeps its unread badge. And "You" is Settings, which is where a phone
 * expects the profile, the theme and the way out to be. Nothing in the design is missing on
 * a phone; two things are somewhere a thumb can reach.
 */
/**
 * Every destination, by name, for callers that receive one as a string.
 *
 * Exported so the shell can check an incoming `starlink:open-section` against the real list
 * rather than casting and hoping — an unknown name then does nothing instead of leaving the
 * shell in a state with no panel.
 */
export const RAIL_SECTIONS: readonly RailSection[] = [
  'chats',
  'people',
  'announcements',
  'settings',
];

const PHONE_SECTIONS: readonly RailSection[] = ['chats', 'people', 'announcements', 'settings'];

const PHONE_LABELS: Readonly<Partial<Record<RailSection, string>>> = { settings: 'You' };

/**
 * The phone's fourth tab is labelled "You" and drawn as a COG.
 *
 * It was a person for a while, on the reasoning that a cog reads as system preferences. The
 * reference draws the cog and it is the source of truth — and the screen behind the tab is a
 * settings list, so the cog is also the more honest of the two.
 *
 * The map is kept because the LABEL still changes ("Settings" on the rail, "You" on the
 * bar); the icon no longer does.
 */
const PHONE_ICONS: Readonly<Partial<Record<RailSection, ReactNode>>> = {};

export function AppRail({
  active,
  onSelect,
  unreadChats,
  displayName,
  onSignOut,
  layout = 'rail',
}: {
  readonly active: RailSection;
  readonly onSelect: (section: RailSection) => void;
  /**
   * Conversations with something unread, badged on Chats.
   *
   * Screen 02 draws the count on the chat tile, which is also the only place it can go now
   * that Notifications is not a destination. It counts CONVERSATIONS rather than messages:
   * "7" means seven threads want you, and forty messages in one thread is one thing to
   * open.
   */
  readonly unreadChats: number;
  readonly displayName: string;
  readonly onSignOut: () => void;
  /**
   * `bottom` is the phone's bar, and it is a different component wearing the same name.
   *
   * Passed in rather than read from a media query here, so the shell and the bar cannot
   * disagree about which layout is on screen — and so the sections it carries are decided in
   * the MARKUP. A destination that is not on a phone is not rendered on a phone:
   * `display: none` would leave it in the tab order, which is the class of fix that makes a
   * keyboard disagree with the picture.
   */
  readonly layout?: 'rail' | 'bottom';
}): ReactNode {
  const bottom = layout === 'bottom';
  const shown = bottom
    ? PHONE_SECTIONS.flatMap((id) => SECTIONS.filter((section) => section.id === id))
    : SECTIONS.filter((section) => section.id !== 'settings');

  return (
    <nav className="rail" aria-label="StarLink sections">
      {/* The mark, as every screen in the design draws it. It has nowhere useful to sit on a
          horizontal bar, and an installed application carries the name on the home screen. */}
      {bottom ? null : <BrandMark size={40} />}

      <ul className="rail-items">
        {shown.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="rail-item"
              onClick={() => onSelect(section.id)}
              /* Between 641px and 860px the rail is icon-only — see the stylesheet for why
                 — so the name has to be available some other way to a pointer. The
                 accessible name is unaffected either way. */
              title={section.label}
              aria-current={active === section.id ? 'page' : undefined}
              /*
                The name carries the count, so a screen reader is told what the badge means
                rather than hearing a bare number after the word "Notifications".
              */
              aria-label={
                section.id === 'chats' && unreadChats > 0
                  ? `Chats, ${unreadChats} unread`
                  : bottom
                    ? (PHONE_LABELS[section.id] ?? section.label)
                    : section.label
              }
            >
              {/*
                The glyph sits in its own pill, and the pill is what the selected state
                fills. A tint across the whole button reads as a highlighted table row;
                a pill behind the icon reads as a selected destination, which is what it
                is — and it leaves the label outside the fill, where a 10px caption
                inside a 30px pill would have made the whole thing a chip.
              */}
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                {bottom ? (PHONE_ICONS[section.id] ?? section.icon) : section.icon}
              </svg>
              {section.id === 'chats' && unreadChats > 0 ? (
                <span className="rail-badge" aria-hidden="true">
                  {unreadChats > 99 ? '99+' : unreadChats}
                </span>
              ) : null}
              {/* Visible on the rail at wide widths, and the only label on a phone's bar. */}
              <span className="rail-label">
                {bottom ? (PHONE_LABELS[section.id] ?? section.label) : section.label}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/*
        The avatar, at the far end — on the rail only.

        There WAS a cog beside it, and the menu behind the avatar offers Settings as well,
        so the rail had one destination twice: a cog you could click, and a cog-shaped item
        inside a menu one row above it. The menu wins — it is where the account already
        lives, and "Settings" reads as a word rather than as a glyph you have to hover to
        identify.

        On a phone Settings IS the fourth tab ("You") and the account menu lives inside it,
        so neither is rendered here.
      */}
      {bottom ? null : (
        <AccountControls
          displayName={displayName}
          onSignOut={onSignOut}
          onSettings={() => onSelect('settings')}
        />
      )}
    </nav>
  );
}

/**
 * Who you are signed in as, and the two things you can do about it.
 *
 * ## Why there is no menu any more
 *
 * There was one: the avatar opened a popover holding "Settings" and "Sign out". Two items
 * behind a click is a menu that exists to hold a menu. Worse, the popover was a light card
 * inheriting the dark rail's `color`, so the name inside it rendered white on white and had
 * to be given its own colour to be readable at all — a fix for a surface that did not need
 * to exist.
 *
 * Both actions are now their own control. The avatar IS the settings button, because
 * settings is the only thing behind it and the person's own face is the universal way into
 * their own preferences. Sign out is the power symbol below it, where every operating
 * system on the machine also puts it.
 *
 * ## Why sign-out asks
 *
 * It is the only control in the rail that ends the session, it sits one pixel-row below a
 * control people press often, and there is no undo. The dialog is the product's own — see
 * `confirm-dialog.tsx` for why it is not `window.confirm`.
 */
function AccountControls({
  displayName,
  onSignOut,
  onSettings,
}: {
  readonly displayName: string;
  readonly onSignOut: () => void;
  readonly onSettings: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rail-account">
      <button
        type="button"
        className="rail-avatar"
        onClick={onSettings}
        aria-label={`Settings for ${displayName}`}
      >
        <span aria-hidden="true">{initialsFor(displayName)}</span>
      </button>

      <button
        type="button"
        className="rail-power"
        onClick={() => setConfirming(true)}
        aria-label="Sign out"
        title="Sign out"
      >
        {/* The IEC 5009 power mark: a broken ring with a stroke through the gap. Drawn
            rather than typed — the character U+23FB renders as an emoji on Windows and as
            nothing at all on several Linux builds. */}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path
            d="M12 3.5v7.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M7.2 6.6a6.75 6.75 0 1 0 9.6 0"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {confirming ? (
        <ConfirmDialog
          title="Sign out?"
          body={`You are signed in as ${displayName}. Signing out ends this session on this device.`}
          choices={[{ label: 'Sign out', tone: 'danger', onChoose: onSignOut }]}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
