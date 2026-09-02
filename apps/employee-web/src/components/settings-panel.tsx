'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { initialsFor } from './conversation-naming';
import { useColleague } from './conversation-info';
import { useSession } from './session-provider';
import { customerWorkspaceEnabled } from '../lib/runtime-origins';
import { readEnterToSend, writeEnterToSend } from '../lib/preferences';
import { applyTheme, type Theme } from '../lib/theme';
import { DraftStore } from '../lib/drafts';
import { formatBytes } from './attachment-picker';
import { api, ApiError } from '../lib/api-client';
import {
  DEVICE_NOTIFICATION_DEFAULTS,
  readDeviceNotifications,
  writeDeviceNotifications,
  type DeviceNotifications,
} from '../lib/device-notifications';

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

type SectionId =
  | 'notifications'
  | 'profile'
  | 'appearance'
  | 'chat'
  | 'privacy'
  | 'storage'
  | 'devices'
  | 'about';

const SECTIONS: readonly { readonly id: SectionId; readonly label: string }[] = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'chat', label: 'Chat preferences' },
  { id: 'privacy', label: 'Privacy & security' },
  { id: 'storage', label: 'Storage & data' },
  { id: 'devices', label: 'Devices' },
  { id: 'about', label: 'About' },
];

function descriptionOf(section: SectionId): string {
  switch (section) {
    case 'notifications':
      return 'Applies to this device. Mobile has its own settings.';
    case 'profile':
      return 'What the company directory holds about you.';
    case 'appearance':
      return 'Applies to this device. Other devices keep their own choice.';
    case 'chat':
      return 'How the composer behaves while you are writing.';
    case 'privacy':
      return 'Your session, and how to end it everywhere at once.';
    case 'storage':
      return 'What this account has uploaded, and what this browser is holding.';
    case 'devices':
      return 'Where you are signed in, and what StarLink can tell you about it.';
    case 'about':
      return 'What this build is.';
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
  const [enterToSend, setEnterToSend] = useState(true);
  const [section, setSection] = useState<SectionId>('notifications');
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
    setEnterToSend(readEnterToSend());
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

  const stage2 = customerWorkspaceEnabled();
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

        {section === 'notifications' ? <DeviceNotificationSettings /> : null}

        {section === 'profile' ? <Profile principalId={principalId} displayName={displayName} /> : null}

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
          </div>
        ) : null}

        {section === 'chat' ? (
          <div className="settings-rows">
            {/*
              One switch, and it is real: it changes a keydown branch in the composer, and it
              does so in an already-open composer without a reload.

              It applies to colleague threads only. A customer reply keeps its Ctrl+Enter
              chord whatever this says — that chord is a safety property rather than a habit,
              because a half-written reply landing in front of a CUSTOMER is a different kind
              of mistake from one landing in front of a colleague.
            */}
            <Toggle
              label="Enter sends the message"
              description={
                enterToSend
                  ? 'Shift + Enter starts a new line. Customer replies always need Ctrl + Enter.'
                  : 'Enter starts a new line; Ctrl + Enter sends.'
              }
              checked={enterToSend}
              onToggle={() => {
                const next = !enterToSend;
                setEnterToSend(next);
                writeEnterToSend(next);
              }}
            />
          </div>
        ) : null}

        {section === 'privacy' ? <Privacy /> : null}

        {section === 'storage' ? <Storage principalId={principalId} /> : null}

        {section === 'devices' ? <Devices /> : null}

        {section === 'about' ? (
          <div className="settings-rows">
            <p className="settings-row">
              <span>Product</span>
              <strong>StarLink</strong>
            </p>
            <p className="settings-row">
              <span>Stage</span>
              <strong>{stage2 ? 'Customer workspace enabled' : 'Internal communication'}</strong>
            </p>
            <p className="settings-note">
              Stage 1 is employee-to-employee messaging. Customer conversations are a later
              stage and are not part of this workspace.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Screen 07's Notifications page, and every switch on it does something.
 *
 * ## What these govern, and what they cannot
 *
 * The bell, its count and the unread badges are §29.6's unread MECHANISM: a fact, not a
 * preference, and nothing on this page reaches them. These four govern the layer above —
 * whether this browser raises a desktop notification and whether it makes a noise — which is
 * exactly what the design's own subtitle says ("Applies to this device").
 *
 * ## Save and Cancel are real, which is why they are here
 *
 * The reference draws a form with two buttons, and a form is what this is: the switches move
 * pending state and nothing is written until Save. Every other settings page in this product
 * applies immediately and has no buttons, because those are single choices — this one is four
 * related decisions about the same thing, which is the case a form is for.
 *
 * Permission is requested at Save, and only when something that needs it was turned on. A
 * browser prompt that appears while somebody is reading a settings page is the prompt they
 * dismiss.
 */
function DeviceNotificationSettings(): ReactNode {
  const [saved, setSaved] = useState<DeviceNotifications>(DEVICE_NOTIFICATION_DEFAULTS);
  const [draft, setDraft] = useState<DeviceNotifications>(DEVICE_NOTIFICATION_DEFAULTS);
  const [note, setNote] = useState<string | undefined>();

  useEffect(() => {
    const current = readDeviceNotifications();
    setSaved(current);
    setDraft(current);
  }, []);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const wantsDesktop = draft.direct || draft.groups;

  const save = async (): Promise<void> => {
    writeDeviceNotifications(draft);
    setSaved(draft);

    if (!wantsDesktop || typeof Notification === 'undefined') {
      setNote('Saved.');
      return;
    }
    if (Notification.permission === 'granted') {
      setNote('Saved.');
      return;
    }
    /*
       Asked once, here, because this is the moment it makes sense. A refusal is reported
       rather than swallowed: the switches stay on and would silently do nothing, and being
       told why is the difference between a broken feature and a browser setting.
    */
    const outcome = await Notification.requestPermission().catch(() => 'denied' as const);
    setNote(
      outcome === 'granted'
        ? 'Saved.'
        : 'Saved — but this browser is blocking notifications, so nothing will appear until you allow them in its site settings.',
    );
  };

  return (
    <div className="settings-rows">
      <Toggle
        label="Direct messages"
        description="Notify for every message"
        checked={draft.direct}
        onToggle={() => setDraft({ ...draft, direct: !draft.direct })}
      />
      <Toggle
        label="Group messages"
        description="Only mentions and replies"
        checked={draft.groups}
        onToggle={() => setDraft({ ...draft, groups: !draft.groups })}
      />
      <Toggle
        label="Sound"
        description="Play a tone on new messages"
        checked={draft.sound}
        onToggle={() => setDraft({ ...draft, sound: !draft.sound })}
      />
      <Toggle
        label="Working hours only"
        description={`Mute between ${draft.quietFrom} and ${draft.quietTo}`}
        checked={draft.quietHours}
        onToggle={() => setDraft({ ...draft, quietHours: !draft.quietHours })}
      />

      {/*
        The window itself, editable — which is what keeps this a personal preference rather
        than an invented working day. Rule 10 is about company facts awaiting sign-off (SLA
        targets, the business's hours, categories, capacity); when THIS laptop should stay
        quiet is none of them, and the numbers are the person's own the moment they change
        one.

        Shown only when the switch is on, because two time fields under an inactive switch
        are two controls that do nothing.
      */}
      {draft.quietHours ? (
        <div className="settings-row-block">
          <span className="settings-row-label">
            <strong>Quiet from</strong>
            Nothing will appear on this device between these times.
          </span>
          <span className="settings-times">
            <input
              type="time"
              aria-label="Quiet hours start"
              value={draft.quietFrom}
              onChange={(event) => setDraft({ ...draft, quietFrom: event.target.value })}
            />
            <span aria-hidden="true">to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={draft.quietTo}
              onChange={(event) => setDraft({ ...draft, quietTo: event.target.value })}
            />
          </span>
        </div>
      ) : null}

      <div className="settings-actions">
        <button type="button" className="primary" disabled={!dirty} onClick={() => void save()}>
          Save changes
        </button>
        <button type="button" disabled={!dirty} onClick={() => setDraft(saved)}>
          Cancel
        </button>
      </div>

      {note !== undefined ? (
        <p className="settings-note" role="status">
          {note}
        </p>
      ) : null}

      <p className="settings-note">
        These apply to this browser, and to every conversation equally. StarLink's own unread
        counts and the bell are not a preference — they are how the product tells you a
        conversation needs you (§29.6) — so nothing here can switch them off, and there is
        deliberately no way to mute a single conversation.
      </p>
    </div>
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
      <p className="settings-note">
        StarLink has no password of its own to change — you sign in with the account the
        company directory holds, and that is managed where the directory is.
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
 * Two different things called storage, kept apart.
 *
 * What the SERVER holds for this account — files you have attached that are still reachable
 * — and what THIS BROWSER holds: a theme, a keyboard preference and any unsent drafts. Only
 * the second can be cleared from here, and saying so is the point: a "clear storage" button
 * that quietly deleted colleagues' copies of a file would be a catastrophe wearing a
 * housekeeping label.
 */
function Storage({ principalId }: { readonly principalId: string | undefined }): ReactNode {
  const [usage, setUsage] = useState<{ files: number; bytes: number } | undefined>();
  const [failed, setFailed] = useState(false);
  const [cleared, setCleared] = useState<number | undefined>();

  useEffect(() => {
    let live = true;
    void api
      .storage()
      .then((result) => {
        if (live) setUsage(result);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const clearDrafts = async (): Promise<void> => {
    if (principalId === undefined) return;
    const removed = await DraftStore.clearAllFor(principalId);
    setCleared(removed);
  };

  return (
    <div className="settings-rows">
      <p className="settings-row">
        <span>Files you have shared</span>
        <strong>
          {failed
            ? 'Unavailable'
            : usage === undefined
              ? '…'
              : `${usage.files} ${usage.files === 1 ? 'file' : 'files'}`}
        </strong>
      </p>
      <p className="settings-row">
        <span>Space they take</span>
        <strong>{usage === undefined ? (failed ? '—' : '…') : formatBytes(usage.bytes)}</strong>
      </p>
      <p className="settings-note">
        Counted across every conversation, and only files that are still reachable. A file
        you shared belongs to the conversation as much as to you: deleting it here would take
        it out from under the colleagues you sent it to, so this page reports and does not
        remove.
      </p>

      <div className="settings-row-block">
        <span className="settings-row-label">
          <strong>Unsent drafts on this device</strong>
          Messages you started and have not sent are kept in this browser so a reload does
          not lose them. They never leave it.
        </span>
        <button type="button" onClick={() => void clearDrafts()} disabled={principalId === undefined}>
          Clear drafts
        </button>
      </div>

      {cleared !== undefined ? (
        <p className="settings-note" role="status">
          {cleared === 0
            ? 'There were no saved drafts to clear.'
            : `Cleared ${cleared} saved ${cleared === 1 ? 'draft' : 'drafts'}.`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Devices — what is true, not what a mock draws.
 *
 * A device list needs a record per session. ADR-008 deliberately does not keep one: a
 * StarLink session is a signed cookie carrying the principal's `sessionVersion`, and the
 * whole point of that design is that reading it costs no lookup. A row written on every
 * sign-in and read on every request is exactly the thing it exists to avoid, so a device
 * list is an architecture decision and not a screen.
 *
 * So this section says what it can: which browser is asking, and the one control that does
 * reach the others. Being told "we cannot list your devices, here is what we can do" is more
 * use than a list of two plausible rows nobody can verify.
 */
function Devices(): ReactNode {
  const [agent, setAgent] = useState<string | undefined>();

  useEffect(() => {
    // Read in an effect: `navigator` does not exist while this renders on the server, and a
    // guessed value would be wrong on exactly the machines this section is about.
    setAgent(describeBrowser(window.navigator.userAgent));
  }, []);

  return (
    <div className="settings-rows">
      <p className="settings-row">
        <span>This device</span>
        <strong>{agent ?? '…'}</strong>
      </p>

      <p className="settings-note">
        StarLink cannot show you a list of your other devices, and would rather say so than
        show you a made-up one. A session here is a signed cookie that carries a version
        number and is checked against your account on every request — there is no record of
        individual devices to list.
      </p>
      <p className="settings-note">
        What that design does give you is stronger than a list: ending every session, on every
        device, takes effect on the next request rather than whenever each device next checks
        in. It is under <strong>Privacy &amp; security</strong>.
      </p>
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

/** A label, a line of explanation, and a switch. The design's own settings row. */
function Toggle({
  label,
  description,
  checked,
  onToggle,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="settings-toggle"
      onClick={onToggle}
    >
      <span className="settings-row-label">
        <strong>{label}</strong>
        {description}
      </span>
      <span className="settings-switch" aria-hidden="true" />
    </button>
  );
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
  const [storage, setStorage] = useState<{ files: number; bytes: number } | undefined>();

  useEffect(() => {
    let live = true;
    void api
      .storage()
      .then((result) => {
        if (live) setStorage(result);
      })
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
    if (id === 'storage') return storage === undefined ? undefined : formatBytes(storage.bytes);
    if (id === 'notifications') {
      const settings = readDeviceNotifications();
      if (settings.direct) return 'All messages';
      if (settings.groups) return 'Mentions only';
      return 'Off';
    }
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
    notifications: (
      <path
        d="M12 4a5 5 0 0 1 5 5v3.2l1.5 2.8h-13L7 12.2V9a5 5 0 0 1 5-5ZM10.2 18a1.9 1.9 0 0 0 3.6 0"
        {...stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    appearance: (
      <>
        <circle cx="12" cy="12" r="4" {...stroke} />
        <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18 6l-1.5 1.5M7.5 16.5 6 18M18 18l-1.5-1.5M7.5 7.5 6 6" {...stroke} strokeLinecap="round" />
      </>
    ),
    chat: <path d="M4 5.5h16v10H8.5L4 19V5.5Z" {...stroke} strokeLinejoin="round" />,
    privacy: (
      <>
        <rect x="5" y="10.5" width="14" height="9" rx="2.5" {...stroke} />
        <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" {...stroke} strokeLinecap="round" />
      </>
    ),
    storage: (
      <path
        d="M3.5 8.5h17v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-9Zm0 0 1.2-2.6A1.5 1.5 0 0 1 6.1 5h3.3l1.6 2"
        {...stroke}
        strokeLinejoin="round"
      />
    ),
    devices: (
      <>
        <rect x="3.5" y="5.5" width="12" height="10" rx="1.5" {...stroke} />
        <rect x="16.5" y="9.5" width="4" height="9" rx="1.2" {...stroke} />
      </>
    ),
    about: (
      <>
        <circle cx="12" cy="12" r="8.2" {...stroke} />
        <path d="M12 11v5M12 8.2v.6" {...stroke} strokeLinecap="round" />
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
