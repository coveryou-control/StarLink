'use client';

/**
 * The notification switches, and the permission they depend on.
 *
 * ## Why this file had to exist before anything else could work
 *
 * `device-notifications.ts` has held the preferences, the quiet-hours arithmetic and the
 * `notify()` that raises a desktop notification since it was written. `use-notifications.ts`
 * calls it. `public/sw.js` is registered and handles the click. Every part was built except
 * the one that asks the browser for permission — `Notification.requestPermission()` appeared
 * nowhere in the product — and `notify()` correctly returns early unless permission is
 * already `granted`.
 *
 * So desktop notifications could not fire at all, for anybody, ever. The switches were not
 * rendered either: `DEVICE_NOTIFICATION_DEFAULTS` appeared in no `.tsx` file. A comment in
 * `device-notifications.ts` said permission "is asked for on the settings screen at the
 * moment somebody turns a switch on", describing a screen that did not exist.
 *
 * ## Asking at the right moment
 *
 * On a deliberate act, never on arrival. A permission prompt that appears because a page
 * loaded is the reliable way to be denied permanently — and `denied` cannot be undone from
 * script, so getting it wrong once costs the feature for that person until they go into
 * browser settings. The prompt here is raised by somebody turning a switch on.
 *
 * ## Three states, three different sentences
 *
 * `default` — never asked. `granted` — working. `denied` — the browser is refusing and no
 * amount of pressing will change it; only the site settings will, so the text says so
 * rather than offering a button that cannot work.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  DEVICE_NOTIFICATION_DEFAULTS,
  readDeviceNotifications,
  writeDeviceNotifications,
  type DeviceNotifications,
} from '../lib/device-notifications';

type Permission = 'unsupported' | 'default' | 'granted' | 'denied';

function currentPermission(): Permission {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as Permission;
}

export function NotificationSettings(): ReactNode {
  /*
     Read on MOUNT, not during render. `localStorage` is not available on the server and
     the defaults would otherwise be what the server renders and the client immediately
     replaces — a flash of the wrong switch positions on every visit.
  */
  const [settings, setSettings] = useState<DeviceNotifications>(DEVICE_NOTIFICATION_DEFAULTS);
  const [permission, setPermission] = useState<Permission>('unsupported');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setSettings(readDeviceNotifications());
    setPermission(currentPermission());
  }, []);

  const update = (patch: Partial<DeviceNotifications>): void => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeDeviceNotifications(next);
  };

  /**
   * Turning a switch ON is what asks the browser.
   *
   * Turning one OFF never does: somebody switching a notification off has said the
   * opposite of "please prompt me", and asking then would be the product arguing.
   */
  const enable = async (patch: Partial<DeviceNotifications>): Promise<void> => {
    update(patch);
    if (permission !== 'default' || asking) return;
    setAsking(true);
    try {
      const answer = await Notification.requestPermission();
      setPermission(answer as Permission);
    } finally {
      setAsking(false);
    }
  };

  const toggle = (key: 'direct' | 'groups' | 'sound', label: string, hint: string): ReactNode => (
    <div className="settings-row-block" key={key}>
      <span className="settings-row-label">
        <strong>{label}</strong>
        {hint}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={settings[key]}
        aria-label={label}
        className={`settings-switch${settings[key] ? ' on' : ''}`}
        onClick={() => {
          const next = !settings[key];
          if (next) void enable({ [key]: true });
          else update({ [key]: false });
        }}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className="settings-rows">
      {/*
        What the browser will allow, said before the switches rather than after.

        A person who has denied permission can set every switch below and get nothing, so
        the state of the permission is the first fact on the panel and not a footnote
        under it.
      */}
      {permission === 'denied' ? (
        <p className="settings-note" role="status">
          <strong>Your browser is blocking notifications for StarLink.</strong> The switches
          below still control what would be shown, but nothing can appear until you allow
          notifications for this site in your browser&rsquo;s settings — a page cannot ask
          again once it has been refused.
        </p>
      ) : permission === 'unsupported' ? (
        <p className="settings-note" role="status">
          This browser does not support desktop notifications. Everything still appears in
          StarLink itself — the unread counts and the bell are unaffected.
        </p>
      ) : permission === 'default' ? (
        <p className="settings-note" role="status">
          Turning any of these on will ask your browser for permission once.
        </p>
      ) : null}

      {toggle('direct', 'Direct messages', 'Notify me for every message sent only to me.')}
      {toggle('groups', 'Groups and channels', 'Only when I am mentioned or replied to.')}
      {toggle('sound', 'Sound', 'Play a short tone as well as showing the notification.')}

      <div className="settings-row-block">
        <span className="settings-row-label">
          <strong>Quiet hours</strong>
          Show nothing and play nothing between these times.
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={settings.quietHours}
          aria-label="Quiet hours"
          className={`settings-switch${settings.quietHours ? ' on' : ''}`}
          onClick={() => update({ quietHours: !settings.quietHours })}
        >
          <span aria-hidden="true" />
        </button>
      </div>

      {settings.quietHours ? (
        <div className="settings-row-block">
          <span className="settings-row-label">
            <strong>Between</strong>
            Crossing midnight is the normal case and is handled.
          </span>
          <span className="settings-times">
            <label>
              <span className="sr-only">Quiet from</span>
              <input
                type="time"
                value={settings.quietFrom}
                onChange={(event) => update({ quietFrom: event.target.value })}
              />
            </label>
            <span aria-hidden="true">to</span>
            <label>
              <span className="sr-only">Quiet until</span>
              <input
                type="time"
                value={settings.quietTo}
                onChange={(event) => update({ quietTo: event.target.value })}
              />
            </label>
          </span>
        </div>
      ) : null}

      {/*
        Applies to this device, and says so.

        These live in `localStorage`, not on the server: a notification is raised by the
        browser you are sitting at, and somebody who silences their laptop has not asked
        to be silent on their phone. §29.6's in-app notification is the opposite — a fact
        about the account, not a preference — and nothing here can turn that off.
      */}
      <p className="settings-note">
        Applies to this device. Unread counts and the bell inside StarLink are unaffected by
        these and cannot be switched off.
      </p>
    </div>
  );
}
