'use client';

import { useEffect, useState } from 'react';

/**
 * Local chat preferences.
 *
 * ## What belongs here, and what does not
 *
 * Exactly one thing so far, and the bar it had to clear is the reason this file is short:
 * a preference may live here only if StarLink can actually honour it without asking the
 * server. Everything else somebody might expect to find in a settings screen either
 * belongs to HRMS (your name, your department — rule 11) or is not disableable by design
 * (§29.6 makes in-app notification "the unread mechanism"), and a switch the product
 * ignores is worse than no switch at all.
 *
 * "Enter sends the message" qualifies. It changes one keydown branch in the composer,
 * nothing crosses the network, and the person who turns it off gets exactly the behaviour
 * they asked for on the very next keystroke.
 *
 * ## Why it is not in React context
 *
 * The composer is remounted per conversation and the settings panel lives in a different
 * subtree of the shell. A context spanning both would mean threading a provider through the
 * layout for one boolean. A module-level read plus an event is smaller and has the property
 * that matters: changing the setting in one place takes effect in the other WITHOUT a
 * reload, which a plain `localStorage` read at mount would not give.
 */

const ENTER_TO_SEND = 'starlink.enterToSend';

/** Fired on this window when a preference changes, so open surfaces re-read it. */
const CHANGED = 'starlink:preferences';

/**
 * Defaults to true, which is the behaviour every chat application has and the behaviour
 * StarLink had before this setting existed. A preference that changes what happens for
 * people who never open Settings is a preference introducing a regression.
 */
export function readEnterToSend(): boolean {
  try {
    return window.localStorage.getItem(ENTER_TO_SEND) !== 'false';
  } catch {
    // A browser with site data blocked is not an error state; the default is correct.
    return true;
  }
}

export function writeEnterToSend(value: boolean): void {
  try {
    window.localStorage.setItem(ENTER_TO_SEND, value ? 'true' : 'false');
  } catch {
    // The choice still applies to this tab; it simply will not survive a reload.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * The preference, kept current.
 *
 * Read in an effect rather than in `useState`'s initialiser: this component is rendered on
 * the server too, where `window` does not exist, and a first client render disagreeing with
 * the server's markup is a hydration mismatch. The default is what both sides render, and
 * the stored value arrives immediately afterwards.
 */
export function useEnterToSend(): boolean {
  const [value, setValue] = useState(true);

  useEffect(() => {
    const sync = (): void => setValue(readEnterToSend());
    sync();
    window.addEventListener(CHANGED, sync);
    // `storage` fires in OTHER tabs, which is where the same person changed it if they have
    // StarLink open twice.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return value;
}
