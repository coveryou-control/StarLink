'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { initialsFor } from './conversation-naming';
import { useColleague } from './conversation-info';
import { useSession } from './session-provider';
import { applyTheme, type Theme } from '../lib/theme';
import {
  CHAT_BACKGROUNDS,
  CHAT_BACKGROUND_LABELS,
  applyChatBackground,
  readChatBackground,
  type ChatBackground,
} from '../lib/chat-background';
import { api, ApiError, type DeclaredStatusView } from '../lib/api-client';
import {
  DECLARED_STATUSES,
  STATUS_DURATIONS_MINUTES,
  declaredStatusLabel,
  muteDurationLabel,
} from '@starlink/shared-contracts';

const THEME_KEY = 'starlink.theme';

/**
 * Settings — and only settings that do something.
 *
 * ## Shape
 *
 * A 240px nav beside a content pane, spanning the whole application rather than sitting in
 * the 340px conversation column. That is the design's own arrangement — screen 07 is a
 * 932px surface, not a panel — and it is also the only one that fits: rows of
 * label-plus-description-plus-switch do not read in a third of a laptop's width.
 *
 * ## The sections are the design's, and every row in them is true
 *
 * Screen 07 lists Notifications, Profile, Appearance, Privacy & security, Storage & data
 * and Devices. All six are here, and so are its four notification switches — the page's own
 * subtitle is what made them buildable: "Applies to this device". They govern whether THIS
 * BROWSER raises a desktop notification and makes a noise, which is a layer above §29.6's
 * unread mechanism and the only layer a preference is allowed to touch. See
 * `device-notifications.ts`.
 *
 * "Working hours only" is here for the same reason. Rule 10 forbids inventing SLA targets,
 * the business's working hours, categories and capacity — company facts awaiting sign-off.
 * When one person's laptop should stay quiet is none of them: it is off until they turn it
 * on, and the window is two fields they set.
 *
 * One thing the reference draws is still absent, and it is stated in words on the page
 * rather than filled with something plausible: **a list of your devices**. ADR-008 makes a
 * session a signed cookie carrying a version number, checked on every request; there is no
 * per-session record and therefore nothing to enumerate. What the architecture does support
 * — ending every session everywhere, at once — is offered instead.
 *
 * A settings screen is the easiest place in a product to ship a lie. Every row below either
 * changes behaviour or states a fact.
 */

/**
 * The settings this product has, after the 2026-09-04 cull.
 *
 * Five pages, down from eight. What went, and why each one was not simply hidden:
 *
 *  - **Notifications** — the four device switches are gone. Being told a conversation
 *    needs you is not a preference (§29.6), and per-conversation quietening is now mute,
 *    which is where somebody actually reaches for it: on the conversation.
 *  - **Chat preferences** — held one switch. A page for one switch is a page.
 *  - **Storage & data** — a read-only number nobody acted on.
 *  - **Devices** — folded into Privacy & security, where "what has my account been doing"
 *    is the question somebody is already asking.
 *  - **About** — a product name and a stage label, neither of which anybody navigates to.
 *
 * `status` is new: what you say you are doing, which was previously not sayable at all.
 */
type SectionId = 'profile' | 'status' | 'appearance' | 'privacy';

const SECTIONS: readonly { readonly id: SectionId; readonly label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'status', label: 'Status' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy & security' },
];

function descriptionOf(section: SectionId): string {
  switch (section) {
    case 'profile':
      return 'Your picture, and what the company directory holds about you.';
    case 'status':
      return 'What colleagues see beside your name. You set it; nothing is guessed.';
    case 'appearance':
      return 'Applies to this device. Other devices keep their own choice.';
    case 'privacy':
      return 'Your session, where it is signed in, and how to end it everywhere at once.';
  }
}

export function SettingsPanel({
  displayName,
  compact = false,
}: {
  readonly displayName: string;
  /**
   * The phone's "You" tab — a list of destinations, then one section at a time.
   *
   * Screen 08's fourth phone is not this screen made narrower: it is a profile row, a column
   * of rows with a chevron each, and an install card. The two-column surface with a pill
   * strip along the top that used to render at 390px was a desktop layout apologising for
   * the width.
   */
  readonly compact?: boolean;
}): ReactNode {
  const [theme, setTheme] = useState<Theme>('system');
  const [chatBackground, setChatBackground] = useState<ChatBackground>('constellation');
  const [section, setSection] = useState<SectionId>('profile');
  /**
   * The caller's own declared status.
   *
   * Held on the panel rather than inside the section so the index can show it in the value
   * column — "Status · In a meeting" is the one line worth reading before opening anything.
   */
  const [myStatus, setMyStatus] = useState<DeclaredStatusView | undefined>();

  useEffect(() => {
    let live = true;
    void api
      .myStatus()
      .then((result) => {
        if (live) setMyStatus(result);
      })
      /* No status is AVAILABLE, which is also what a failed read should look like: the
         section renders its default and setting one still works. */
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  /* On a phone the list is the landing screen; on the rail a section is always open. */
  const [showIndex, setShowIndex] = useState(true);

  const { state: session } = useSession();
  const principalId = session.status === 'SIGNED_IN' ? session.me.principalId : undefined;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored);
    } catch {
      // A browser with site data blocked is not an error state; the default is correct.
    }
    setChatBackground(readChatBackground());
  }, []);

  const apply = (next: Theme): void => {
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice still applies to this tab; it simply will not survive a reload.
    }
  };

  const heading = SECTIONS.find((entry) => entry.id === section)?.label ?? 'Settings';

  if (compact && showIndex) {
    return (
      <YouPage
        displayName={displayName}
        principalId={principalId}
        theme={theme}
        onOpen={(id) => {
          setSection(id);
          setShowIndex(false);
        }}
      />
    );
  }

  return (
    <section className="settings-screen" aria-label="Settings">
      {/* The way back to the list — a phone shows one section at a time. */}
      {compact ? (
        <header className="settings-back">
          <button type="button" onClick={() => setShowIndex(true)} aria-label="Back to You">
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
          </button>
          <h2>{heading}</h2>
        </header>
      ) : null}

      <nav className="settings-nav" aria-label="Settings sections">
        <p className="settings-nav-title">Settings</p>
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`settings-nav-item${section === entry.id ? ' active' : ''}`}
            aria-current={section === entry.id ? 'page' : undefined}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <header className="settings-heading">
          <h2>{heading}</h2>
          <p>{descriptionOf(section)}</p>
        </header>

        {section === 'profile' ? <Profile principalId={principalId} displayName={displayName} /> : null}

        {section === 'status' ? (
          <DeclaredStatusSettings current={myStatus} onChanged={setMyStatus} />
        ) : null}

        {section === 'appearance' ? (
          <div className="settings-rows">
            <div className="settings-row-block">
              <span className="settings-row-label">
                <strong>Theme</strong>
                Match your machine, or pick one and keep it.
              </span>
              <div className="settings-choice" role="radiogroup" aria-label="Theme">
                {(['system', 'light', 'dark'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={theme === option}
                    onClick={() => apply(option)}
                  >
                    {option === 'system' ? 'Match system' : option === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </div>

            {/*
              The thread's own ground, separate from light/dark.

              They compose rather than multiplying: each background works in both themes,
              so this is four choices beside three rather than twelve to pick from. The
              accent is untouched by all of them — see `chat-background.ts`.
            */}
            <div className="settings-row-block">
              <span className="settings-row-label">
                <strong>Chat background</strong>
                Applies to the conversation area. Your orange stays put.
              </span>
              <div
                className="settings-choice chat-bg-choice"
                role="radiogroup"
                aria-label="Chat background"
              >
                {CHAT_BACKGROUNDS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={chatBackground === option}
                    className={`chat-bg-option chat-bg-${option}`}
                    onClick={() => {
                      setChatBackground(option);
                      applyChatBackground(option);
                    }}
                  >
                    <span className="chat-bg-swatch" aria-hidden="true" />
                    {CHAT_BACKGROUND_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {section === 'privacy' ? <Privacy /> : null}

      </div>
    </section>
  );
}

/**
 * Your own directory record, stated rather than editable.
 *
 * HRMS owns the employee record; StarLink reads it through the identity adapter and has no
 * authority to change it (rule 11), so an edit control here would write nowhere. It reads
 * the same cached lookup the information panel uses, so opening this page costs nothing if
 * you have already looked at a colleague.
 *
 * The "interim" marker is INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must
 * be unmistakable for a canonical one, and your own profile is exactly where somebody would
 * otherwise assume they were reading HR's copy.
 */
function Profile({
  principalId,
  displayName,
}: {
  readonly principalId: string | undefined;
  readonly displayName: string;
}): ReactNode {
  const entry = useColleague(principalId);

  const rows: { label: string; value: string }[] = [];
  if (entry !== undefined) {
    if (entry.employeeId !== undefined) rows.push({ label: 'Employee ID', value: entry.employeeId });
    if (entry.reportsTo !== undefined) rows.push({ label: 'Reports to', value: entry.reportsTo });
    if (entry.department !== '') rows.push({ label: 'Department', value: entry.department });
    const teams = (entry.teams ?? []).map((team) => team.displayName).join(', ');
    if (teams !== '') rows.push({ label: 'Teams', value: teams });
    if (entry.location !== undefined) rows.push({ label: 'Location', value: entry.location });
    if (entry.timezone !== undefined) rows.push({ label: 'Time zone', value: entry.timezone.replace(/_/g, ' ') });
  }

  return (
    <div className="settings-rows">
      <div className="settings-identity">
        <span className="row-avatar" aria-hidden="true">
          {initialsFor(displayName)}
        </span>
        <span className="settings-identity-text">
          <strong>{displayName}</strong>
          <span className="muted">
            {entry?.authority === 'TEMPORARY_AUTHORITY'
              ? 'From the interim directory'
              : 'From the company directory'}
          </span>
        </span>
      </div>

      {rows.map((row) => (
        <p className="settings-row" key={row.label}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </p>
      ))}

      <p className="settings-note">
        Your name, department and reporting line come from the company directory and are
        managed there — StarLink reads them and cannot change them. A field you expect to see
        and do not is one the directory has not supplied.
      </p>
    </div>
  );
}

/**
 * The one security control StarLink can actually offer, and it is a real one.
 *
 * "Sign out everywhere" is a `sessionVersion` increment: every outstanding cookie for this
 * principal stops verifying on its NEXT request, on every machine, including live sockets
 * once the gateway re-checks (FR-AUTH-2). It is not a request to other devices that they
 * might ignore.
 *
 * Two presses, because it is not undoable and it signs the person out of the browser they
 * are asking from. A single button that logs you out is a button people press by accident.
 */
function Privacy(): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [agent, setAgent] = useState<string | undefined>();
  const [session, setSession] = useState<
    { startedAt: string; expiresAt: string; ip: string | null } | undefined
  >();

  useEffect(() => {
    /* `navigator` does not exist while this renders on the server, and a guessed value
       would be wrong on exactly the machines this row is about. */
    setAgent(describeBrowser(window.navigator.userAgent));
    let live = true;
    void api
      .me()
      .then((me) => {
        if (live && me.session !== undefined) setSession(me.session);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const run = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      await api.signOutEverywhere();
      // A full navigation rather than a router push: every cached response and every open
      // socket in this tab belongs to a session that no longer exists.
      window.location.assign('/sign-in');
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? 'That did not complete. You are still signed in — try again.'
          : 'StarLink could not be reached. Nothing has changed.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="settings-rows">
      {/*
        This session, which is the whole of what ADR-008 can honestly report.

        The Devices page used to live here as its own section and say, at length, that
        StarLink cannot list your devices. That is still true — a session is a signed
        cookie carrying a version number, and nothing records the individual sessions that
        exist — but a whole page explaining an absence is a page about nothing. What it
        CAN say now sits in four rows beside the control that acts on it.

        No location row: deriving one means sending the address to a geo-IP service, which
        is a third party receiving employee network data and a data-residency question
        under the IRDAI record rules. No MAC address: a browser cannot obtain one by any
        API, so the field could only ever hold a guess.
      */}
      <p className="settings-row">
        <span>This device</span>
        <strong>{agent ?? '…'}</strong>
      </p>
      <p className="settings-row">
        <span>Signed in</span>
        <strong>{session === undefined ? '…' : whenSigned(session.startedAt)}</strong>
      </p>
      <p className="settings-row">
        <span>Session ends</span>
        <strong>{session === undefined ? '…' : whenSigned(session.expiresAt)}</strong>
      </p>
      <p className="settings-row">
        <span>Address</span>
        <strong>{session?.ip ?? '—'}</strong>
      </p>

      <p className="settings-note">
        StarLink cannot list your other devices, and would rather say so than show you a
        made-up one: a session is a signed cookie checked against your account on every
        request, so there is no per-device record to enumerate. What that gives you instead
        is below, and it is stronger than a list — it takes effect on the next request
        rather than whenever each device next checks in.
      </p>

      <div className="settings-row-block">
        <span className="settings-row-label">
          <strong>Sign out on all devices</strong>
          Ends every StarLink session for your account, everywhere, on its next request —
          including this browser. Use it if a device is lost.
        </span>
        {confirming ? (
          <span className="settings-confirm">
            <button type="button" className="danger" disabled={busy} onClick={() => void run()}>
              {busy ? 'Signing out…' : 'Yes, sign out everywhere'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Sign out everywhere
          </button>
        )}
      </div>

      {problem !== undefined ? (
        <p className="settings-note" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A user-agent string, reduced to the two facts a person recognises.
 *
 * Deliberately coarse. The full string is a fingerprint, and the question this row answers
 * is "is this the machine I am sitting at" — for which "Chrome on Windows" is enough and
 * anything more is over-collection displayed back at the collector.
 */
export function describeBrowser(userAgent: string): string {
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'This browser';

  const platform =
    /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : undefined;

  return platform === undefined ? browser : `${browser} on ${platform}`;
}

/**
 * The phone's "You" tab — screen 08's fourth device.
 *
 * A profile row, then one row per destination with a chevron and, where there is one, the
 * value on the right; then the install card. Every value is read from the thing it names, so
 * the list says what the settings actually are rather than repeating their titles.
 */
function YouPage({
  displayName,
  principalId,
  theme,
  onOpen,
}: {
  readonly displayName: string;
  readonly principalId: string | undefined;
  readonly theme: Theme;
  readonly onOpen: (section: SectionId) => void;
}): ReactNode {
  const entry = useColleague(principalId);
  /*
     The storage read is gone with the section it fed. Its value column said "1.2 GB" and
     nothing on the page could act on the number, so the request was a round trip per open
     to render a fact nobody used.
  */
  const [myStatus, setMyStatus] = useState<DeclaredStatusView | undefined>();

  useEffect(() => {
    let live = true;
    void api
      .myStatus()
      .then((result) => {
        if (live) setMyStatus(result);
      })
      /* No answer reads as Available, which is both the default and the safe fallback. */
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /**
   * What each row says on its right — the reference's "Mentions only" and "1.2 GB".
   *
   * Absent where there is nothing true to say. A value column that fills itself with "On"
   * for everything is a column of decoration.
   */
  const valueOf = (id: SectionId): string | undefined => {
    if (id === 'appearance') {
      return theme === 'system' ? 'Match system' : theme === 'dark' ? 'Dark' : 'Light';
    }
    if (id === 'status') return declaredStatusLabel(myStatus?.status ?? 'AVAILABLE');
    return undefined;
  };

  return (
    <section className="you-page" aria-label="You">
      <h2 className="you-title">You</h2>

      {/* The profile, at the top and tappable — it opens the section it summarises. */}
      <button type="button" className="you-profile" onClick={() => onOpen('profile')}>
        <span className="row-avatar" aria-hidden="true">
          {initialsFor(displayName)}
        </span>
        <span className="you-profile-text">
          <strong>{displayName}</strong>
          <span>
            {[entry?.department, entry?.employeeId].filter((part) => part !== undefined && part !== '').join(' · ')}
          </span>
        </span>
        <Chevron />
      </button>

      <div className="you-rows">
        {SECTIONS.filter((s) => s.id !== 'profile').map((s) => (
          <button key={s.id} type="button" className="you-row" onClick={() => onOpen(s.id)}>
            <span className="you-row-icon" aria-hidden="true">
              <SectionGlyph section={s.id} />
            </span>
            <span className="you-row-label">{s.label}</span>
            {/*
              A value OR a chevron, never both — which is what the reference draws and which
              is right: the chevron says "there is more through here", and a row that has
              already told you the answer is saying something else.
            */}
            {valueOf(s.id) !== undefined ? (
              <span className="you-row-value">{valueOf(s.id)}</span>
            ) : (
              <Chevron />
            )}
          </button>
        ))}
      </div>

      <InstallCard />
    </section>
  );
}

function Chevron(): ReactNode {
  return (
    <svg className="you-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="m9.5 5 7 7-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One glyph per destination, drawn rather than typed — see the rail for why not an emoji. */
function SectionGlyph({ section }: { readonly section: SectionId }): ReactNode {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;
  const paths: Partial<Record<SectionId, ReactNode>> = {
    status: (
      <>
        {/* A speech bubble with a dot: what you are saying about yourself. */}
        <path d="M4 5.5h16v10H8.5L4 19V5.5Z" {...stroke} strokeLinejoin="round" />
        <circle cx="12" cy="10.5" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
    appearance: (
      <>
        <circle cx="12" cy="12" r="4" {...stroke} />
        <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18 6l-1.5 1.5M7.5 16.5 6 18M18 18l-1.5-1.5M7.5 7.5 6 6" {...stroke} strokeLinecap="round" />
      </>
    ),
    privacy: (
      <>
        <rect x="5" y="10.5" width="14" height="9" rx="2.5" {...stroke} />
        <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" {...stroke} strokeLinecap="round" />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
      {paths[section] ?? <circle cx="12" cy="12" r="8" {...stroke} />}
    </svg>
  );
}

/**
 * "Install StarLink" — the reference's card, and only when the browser is actually offering.
 *
 * `beforeinstallprompt` fires when the installability criteria are met and the application is
 * not already installed. Rendering the card unconditionally would put a button on the screen
 * that does nothing in every browser that has already installed it, in every browser that
 * does not support installing, and on iOS — where the answer is "use Share → Add to Home
 * Screen" and no button can do it for you.
 */
function InstallCard(): ReactNode {
  const [prompt, setPrompt] = useState<{ prompt: () => Promise<void> } | undefined>();

  useEffect(() => {
    const capture = (event: Event): void => {
      event.preventDefault();
      setPrompt(event as unknown as { prompt: () => Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);

  if (prompt === undefined) return null;

  return (
    <button
      type="button"
      className="you-install"
      onClick={() => {
        void prompt.prompt();
        /* One offer. The browser refuses a second `prompt()` on the same event, so a card
           that stayed after the first press would be a button that silently stopped. */
        setPrompt(undefined);
      }}
    >
      <span className="you-install-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
          <path
            d="M12 4v10m0 0-4-4m4 4 4-4M5 18h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="you-install-text">
        <strong>Install StarLink</strong>
        Add to home screen for faster access
      </span>
    </button>
  );
}

/**
 * What you say you are doing.
 *
 * ## Set, never guessed
 *
 * Nothing here watches a keyboard or an idle timer. §21.9 forbids inferring availability
 * from a socket, and this page is the other half of that rule: if the system may not
 * guess, the person has to be able to say. Presence — the green dot — goes on doing its
 * own job beside this and the two are never merged.
 *
 * ## Everything except Available expires
 *
 * Because people forget. The colleague who set "in a meeting" on Tuesday morning is not
 * still in it on Friday, and a reader burned by that once stops believing any of them. The
 * duration is required, and Available takes none because it is the absence of a claim
 * rather than a claim of its own.
 *
 * ## Optimistic, and reverted on failure
 *
 * A control that waits for a round trip before moving reads as broken; one that moves and
 * stays moved after a refusal is a lie.
 */
function DeclaredStatusSettings({
  current,
  onChanged,
}: {
  readonly current: DeclaredStatusView | undefined;
  readonly onChanged: (next: DeclaredStatusView) => void;
}): ReactNode {
  const status = current?.status ?? 'AVAILABLE';
  const [minutes, setMinutes] = useState<number>(STATUS_DURATIONS_MINUTES[1]);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const choose = async (next: string): Promise<void> => {
    setProblem(undefined);
    setBusy(true);
    const previous = current;
    /* Moved immediately, with the expiry the server is about to compute mirrored locally
       so the "until" line does not flicker in as a second step. */
    onChanged({
      principalId: current?.principalId ?? '',
      status: next,
      setAt: new Date().toISOString(),
      ...(next === 'AVAILABLE'
        ? {}
        : { clearsAt: new Date(Date.now() + minutes * 60_000).toISOString() }),
    });
    try {
      const saved = await api.setMyStatus(next, next === 'AVAILABLE' ? undefined : minutes);
      onChanged({
        principalId: current?.principalId ?? '',
        status: saved.status,
        setAt: new Date().toISOString(),
        ...(saved.clearsAt !== null ? { clearsAt: saved.clearsAt } : {}),
      });
    } catch {
      if (previous !== undefined) onChanged(previous);
      setProblem('That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-rows">
      <div className="settings-row-block">
        <span className="settings-row-label">
          <strong>Your status</strong>
          Colleagues see this beside your name. Nothing is guessed from how long you have
          been idle.
        </span>
        <div className="settings-choice status-choice" role="radiogroup" aria-label="Status">
          {DECLARED_STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={status === option}
              disabled={busy}
              className={`status-option status-${option.toLowerCase()}`}
              onClick={() => void choose(option)}
            >
              {declaredStatusLabel(option)}
            </button>
          ))}
        </div>
      </div>

      {/*
        The duration, offered BEFORE the status is chosen rather than after.

        A second dialog asking "for how long?" turns one decision into two, and the answer
        is almost always the same one. Choosing it first means pressing "Busy" is a single
        act with a known end. Hidden while Available is selected, because that one takes no
        expiry and a disabled control here would only invite the question of why.
      */}
      {status !== 'AVAILABLE' || busy ? (
        <div className="settings-row-block">
          <span className="settings-row-label">
            <strong>For how long</strong>
            Every status ends. The longest is a working day, after which you say it again.
          </span>
          <div className="settings-choice" role="radiogroup" aria-label="Duration">
            {STATUS_DURATIONS_MINUTES.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={minutes === option}
                onClick={() => {
                  setMinutes(option);
                  if (status !== 'AVAILABLE') void choose(status);
                }}
              >
                {muteDurationLabel(option)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {current?.clearsAt !== undefined ? (
        <p className="settings-note">
          {declaredStatusLabel(status)} until{' '}
          {new Date(current.clearsAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
          . After that, colleagues see nothing beside your name.
        </p>
      ) : null}

      {problem !== undefined ? (
        <p className="settings-note" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** "4 Sep, 14:03" — a session instant, short enough for a settings row. */
function whenSigned(at: string): string {
  return new Date(at).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
