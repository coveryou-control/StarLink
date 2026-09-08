'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrandMark } from './brand';
import { initialsFor } from './conversation-naming';
import { AvatarImage } from './avatar-image';
import { useSession } from './session-provider';
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

/**
 * Which slice of the chat list the sidebar is showing.
 *
 * Three of these are FILTERS over one list and two are their own views, and the sidebar
 * deliberately does not distinguish them — asked for on 2026-09-08, and right: to a reader
 * "Groups" and "Archive" are both just places to look, and making them look different
 * because one is cheaper to implement is the implementation leaking into the product.
 */
export type ChatView = 'all' | 'unread' | 'favourites' | 'groups' | 'direct' | 'archive';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const;

/** Where the sidebar remembers whether it was collapsed. */
const SIDENAV_KEY = 'starlink.sidenav';

/** The sidebar's chat destinations, in the order they were asked for. */
export const CHAT_VIEWS: readonly {
  readonly id: ChatView;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  {
    id: 'all',
    label: 'All',
    icon: <path d="M4 5.5h16v10H8.5L4 19V5.5Z" {...stroke} strokeLinejoin="round" />,
  },
  {
    id: 'unread',
    label: 'Unread',
    icon: (
      <>
        <path d="M4 5.5h16v10H8.5L4 19V5.5Z" {...stroke} strokeLinejoin="round" />
        <circle cx="12" cy="10.5" r="1.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    id: 'favourites',
    label: 'Favourites',
    icon: (
      <path
        d="M12 4.2l2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.5-4.6 2.5.9-5.3L4.5 9.8l5.2-.7L12 4.2Z"
        {...stroke}
        strokeLinejoin="round"
      />
    ),
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: (
      <>
        <circle cx="9" cy="9" r="3" {...stroke} />
        <path d="M3.2 19c0-3 2.6-4.8 5.8-4.8s5.8 1.8 5.8 4.8" {...stroke} strokeLinecap="round" />
        <path d="M16.2 7.4a3 3 0 0 1 0 5.6M17.5 19c0-2.2-.8-3.6-2-4.5" {...stroke} strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'direct',
    label: '1:1',
    icon: (
      <>
        <circle cx="12" cy="8.6" r="3.4" {...stroke} />
        <path d="M5.5 19.5c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" {...stroke} strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'archive',
    label: 'Archive',
    icon: (
      <>
        <rect x="3.5" y="5" width="17" height="4" rx="1.2" {...stroke} />
        <path d="M5.2 9v9.2c0 .7.6 1.3 1.3 1.3h11c.7 0 1.3-.6 1.3-1.3V9" {...stroke} />
        <path d="M10 13h4" {...stroke} strokeLinecap="round" />
      </>
    ),
  },
];

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
  chatView,
  onChatView,
  onNewChat,
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
  /** Which slice of the chat list is showing. Desktop sidebar only. */
  readonly chatView?: ChatView;
  readonly onChatView?: (view: ChatView) => void;
  readonly onNewChat?: () => void;
}): ReactNode {
  const bottom = layout === 'bottom';
  const shown = bottom
    ? PHONE_SECTIONS.flatMap((id) => SECTIONS.filter((section) => section.id === id))
    : SECTIONS.filter((section) => section.id !== 'settings');

  /*
     The phone's bar and the desktop's sidebar are two different components that happen to
     hold some of the same destinations, and they are kept apart here rather than merged
     behind conditionals. The bar has four tabs and a thumb; the sidebar has labelled rows,
     a chat-view list and account controls. Trying to express both in one tree is how the
     bar ended up with the sidebar's width and four crushed labels.
  */
  if (!bottom && onChatView !== undefined) {
    return (
      <DesktopSidebar
        active={active}
        onSelect={onSelect}
        unreadChats={unreadChats}
        displayName={displayName}
        onSignOut={onSignOut}
        chatView={chatView ?? 'all'}
        onChatView={onChatView}
        {...(onNewChat !== undefined ? { onNewChat } : {})}
      />
    );
  }

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
  const me = useOwnPrincipalId();

  return (
    <div className="rail-account">
      <button
        type="button"
        className="rail-avatar"
        onClick={onSettings}
        aria-label={`Settings for ${displayName}`}
      >
        <span aria-hidden="true">{initialsFor(displayName)}</span>
        <AvatarImage principalId={me} alt="" />
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

/**
 * The desktop sidebar.
 *
 * One labelled column instead of a strip of anonymous glyphs, asked for on 2026-09-08 from
 * a reference layout. What changed is the SHAPE of the navigation, not what it reaches:
 * every destination the icon rail had is still here, and the chat list gained the views it
 * previously had no room to name.
 *
 * ## Why filters and destinations sit in one list
 *
 * "Groups" narrows a list this app already loads; "Archive" and "Favourites" are their own
 * reads. A reader does not care which is which — they are all places to look — so they are
 * one list, ordered by how often they are wanted rather than by how they are implemented.
 *
 * ## Why the account controls are pinned to the foot
 *
 * Appearance, settings and sign-out are the three things touched least and wanted in the
 * same place every time. At the bottom they never move as the list above them grows.
 */
/**
 * The signed-in principal, or `undefined` before the session resolves.
 *
 * `AvatarImage` takes `undefined` and renders nothing, so the two account tiles need no
 * loading state of their own — they show initials until the session and the stamp are both
 * in, which is what they showed before regardless.
 */
function useOwnPrincipalId(): string | undefined {
  const { state } = useSession();
  return state.status === 'SIGNED_IN' ? state.me.principalId : undefined;
}

function DesktopSidebar({
  active,
  onSelect,
  unreadChats,
  displayName,
  onSignOut,
  chatView,
  onChatView,
  onNewChat,
}: {
  readonly active: RailSection;
  readonly onSelect: (section: RailSection) => void;
  readonly unreadChats: number;
  readonly displayName: string;
  readonly onSignOut: () => void;
  readonly chatView: ChatView;
  readonly onChatView: (view: ChatView) => void;
  readonly onNewChat?: () => void;
}): ReactNode {
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const me = useOwnPrincipalId();
  /**
   * Collapsed to icons — by the reader's choice, or because the window is too narrow.
   *
   * ## Why one flag and not a media query
   *
   * The narrow-window rule and the manual toggle produce the SAME column, and expressing
   * that twice — once in CSS, once here — is how the two drift apart. The breakpoint is
   * stated once, in JavaScript, and the stylesheet has one rule keyed on one attribute.
   *
   * The reader's choice wins while the window is wide enough to honour it; below 1100px
   * there is no room for labels and the choice is moot, so the width decides.
   */
  const [chosenCollapse, setChosenCollapse] = useState<boolean | undefined>(undefined);
  const [tooNarrow, setTooNarrow] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDENAV_KEY);
      if (stored === 'collapsed' || stored === 'expanded') setChosenCollapse(stored === 'collapsed');
    } catch {
      // Site data blocked is not an error state; expanded is the right default.
    }
    const query = window.matchMedia('(max-width: 1100px)');
    const read = (): void => setTooNarrow(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);

  const collapsed = tooNarrow || chosenCollapse === true;
  const onChats = active === 'chats';
  return (
    <nav className="sidenav" aria-label="StarLink" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="sidenav-brand">
        <BrandMark size={26} />
        <span className="sidenav-wordmark">StarLink</span>
        {/*
          The collapse control, on the brand row.

          Hidden below 1100px, where the column is already icons and the button could only
          promise something the width will not allow — a control that does nothing is worse
          than no control.
        */}
        {tooNarrow ? null : (
          <button
            type="button"
            className="sidenav-collapse"
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => {
              const next = !collapsed;
              setChosenCollapse(next);
              try {
                window.localStorage.setItem(SIDENAV_KEY, next ? 'collapsed' : 'expanded');
              } catch {
                // The choice still applies to this tab; it simply will not survive a reload.
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" {...stroke} />
              <path d="M10 4.5v15" {...stroke} />
              {collapsed ? null : <path d="M7.4 10.2 5.9 12l1.5 1.8" {...stroke} strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        )}
      </div>

      {onNewChat !== undefined ? (
        <button type="button" className="sidenav-new" onClick={onNewChat}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M12 5.5v13M5.5 12h13" {...stroke} strokeLinecap="round" />
          </svg>
          New chat
        </button>
      ) : null}

      <p className="sidenav-label">Chats</p>
      <ul className="sidenav-items">
        {CHAT_VIEWS.map((view) => (
          <li key={view.id}>
            <button
              type="button"
              className="sidenav-item"
              /* Current only while the chat panel is the one on screen — otherwise two
                 things in this column claim to be the current page at once. */
              aria-current={onChats && chatView === view.id ? 'page' : undefined}
              onClick={() => {
                onSelect('chats');
                onChatView(view.id);
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                {view.icon}
              </svg>
              <span>{view.label}</span>
              {view.id === 'unread' && unreadChats > 0 ? (
                <span className="sidenav-badge">{unreadChats > 99 ? '99+' : unreadChats}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <p className="sidenav-label">Company</p>
      <ul className="sidenav-items">
        {/*
          "Connect" rather than "People" — the reference's word, and the better one: this is
          where you go to find a colleague you have not spoken to yet, which is an act
          rather than a noun.
        */}
        <li>
          <button
            type="button"
            className="sidenav-item"
            aria-current={active === 'people' ? 'page' : undefined}
            onClick={() => onSelect('people')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <circle cx="9.5" cy="8.5" r="3.2" {...stroke} />
              <path d="M3.5 19.5c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2" {...stroke} strokeLinecap="round" />
              <path d="M17 8.5h4M19 6.5v4" {...stroke} strokeLinecap="round" />
            </svg>
            <span>Connect</span>
          </button>
        </li>
        {/*
          Announcements was on the icon rail and is not on the list this sidebar was asked
          for. It stays: an existing destination with its own permission and its own panel,
          and dropping it from the navigation would remove a feature rather than restyle one.
        */}
        <li>
          <button
            type="button"
            className="sidenav-item"
            aria-current={active === 'announcements' ? 'page' : undefined}
            onClick={() => onSelect('announcements')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path d="M4 10v4h3l5 3.5v-11L7 10H4Z" {...stroke} strokeLinejoin="round" />
              <path d="M16.5 9.5a4 4 0 0 1 0 5" {...stroke} strokeLinecap="round" />
            </svg>
            <span>Announcements</span>
          </button>
        </li>
      </ul>

      {/*
        The foot: who you are, then the way out.

        Appearance lived here as a shortcut and has gone back to Settings, where the three
        choices are stated plainly — a cycling button had to be labelled with its current
        state, which is the oldest ambiguity in interface design and not worth carrying for
        a setting people change twice a year.

        Settings has no row of its own either. Your name IS the way in, which is where
        every product of this shape puts it, and it removes a row from a column whose job
        is to be scanned. Log out is last because a destructive action belongs where a
        mis-click cannot find it.
      */}
      <div className="sidenav-foot">
        <button
          type="button"
          className="sidenav-you"
          aria-current={active === 'settings' ? 'page' : undefined}
          aria-label={`Settings for ${displayName}`}
          title={displayName}
          onClick={() => onSelect('settings')}
        >
          <span className="sidenav-you-avatar" aria-hidden="true">
            {initialsFor(displayName)}
            {/* Your own face, in the one place you look to confirm who you are signed in
                as. Both account tiles drew initials unconditionally, so the person who had
                just set a picture was the only person in the product whose picture they
                could not see. */}
            <AvatarImage principalId={me} alt="" />
          </span>
          <span className="sidenav-you-name">{displayName}</span>
        </button>

        <button type="button" className="sidenav-item" onClick={() => setConfirmSignOut(true)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M14 7.5V5.8c0-.7-.6-1.3-1.3-1.3H6.3c-.7 0-1.3.6-1.3 1.3v12.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V16.5"
              {...stroke}
              strokeLinecap="round"
            />
            <path d="M10 12h9M16.2 9l3 3-3 3" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Log out</span>
        </button>
      </div>

      {confirmSignOut ? (
        <ConfirmDialog
          title="Sign out?"
          body={`You are signed in as ${displayName}. Signing out ends this session on this device.`}
          choices={[{ label: 'Sign out', tone: 'danger', onChoose: onSignOut }]}
          onCancel={() => setConfirmSignOut(false)}
        />
      ) : null}
    </nav>
  );
}
