'use client';

/**
 * Registering this browser for push, and unregistering it.
 *
 * ## Where this sits
 *
 * `device-notifications.ts` decides whether a notification should be RAISED on this
 * device and is entirely local. This is the other half: getting a token from Firebase so
 * the server can reach the browser when StarLink is not open at all. The two are separate
 * because they fail separately — permission can be granted with no Firebase project
 * configured, and a project can be configured for somebody who has denied permission.
 *
 * ## Imported lazily, and that is not an optimisation
 *
 * `firebase/messaging` is a few hundred kilobytes and is needed by the small number of
 * people who turn push on, at the moment they turn it on. A static import would put it in
 * the bundle every employee downloads to read a message. `await import()` keeps it out of
 * the critical path entirely, and the settings panel is the only caller.
 *
 * ## What it never does
 *
 * It does not ask for permission. `notification-settings.tsx` owns that, because the
 * prompt must follow a deliberate act and this module is also called on start-up to
 * refresh an existing token — a refresh that raised a prompt would be the thing the
 * permission rule exists to prevent.
 */
import { api } from './api-client';
import { readDeviceNotifications } from './device-notifications';
import { pushConfig } from './runtime-origins';

/** Where the last registered token is remembered, so it can be unregistered later. */
const TOKEN_KEY = 'starlink.push-token';

export type PushOutcome =
  | 'REGISTERED'
  | 'NOT_CONFIGURED'
  | 'NO_PERMISSION'
  | 'UNSUPPORTED'
  | 'FAILED';

function remembered(): string | undefined {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(token: string | undefined): void {
  try {
    if (token === undefined) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* A browser with site data blocked can still receive a push this session; it will
       simply register again next time rather than reusing the remembered token. */
  }
}

/**
 * Mints a token for this browser and tells the server about it.
 *
 * Safe to call on every start-up: Firebase hands back the same token for the same
 * browser most of the time, and the server's upsert turns a repeat into a
 * `last_seen_at` touch rather than a second device.
 */
export async function registerForPush(): Promise<PushOutcome> {
  const config = pushConfig();
  if (config === undefined) return 'NOT_CONFIGURED';

  if (
    typeof window === 'undefined' ||
    typeof Notification === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return 'UNSUPPORTED';
  }
  /* Asking here is forbidden — see the header. A person who has not granted permission
     is simply not registered, and turning the switch on is what changes that. */
  if (Notification.permission !== 'granted') return 'NO_PERMISSION';

  try {
    const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all(
      [import('firebase/app'), import('firebase/messaging')],
    );
    if (!(await isSupported())) return 'UNSUPPORTED';

    /* One app instance per page. `getApps()` because React's development double-render
       and a settings panel opened twice would otherwise initialise it repeatedly. */
    const app =
      getApps()[0] ??
      initializeApp({
        apiKey: config.apiKey,
        appId: config.appId,
        projectId: config.projectId,
        messagingSenderId: config.senderId,
      });

    /*
       The EXISTING service worker, not a second one.

       `getToken` registers `/firebase-messaging-sw.js` by default. StarLink already has
       a worker at `/sw.js` that owns `notificationclick`, and two workers on one scope
       is a race over which handles the tap. Handing the registration in keeps one.
    */
    const registration =
      (await navigator.serviceWorker.getRegistration('/')) ??
      (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));

    const token = await getToken(getMessaging(app), {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: registration,
    });
    if (token === '') return 'FAILED';

    /*
       The quiet window goes UP with the token.

       Read from this device's own settings, and the zone from this browser's `Intl`, so
       the server can evaluate "is it 23:40 where that phone is" without storing an
       offset that would be wrong twice a year. Sent on every registration including
       when quiet hours are off, because switching them off has to clear the stored
       window rather than leave yesterday's in place.
    */
    const device = readDeviceNotifications();
    const quiet = device.quietHours
      ? {
          from: device.quietFrom,
          to: device.quietTo,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
      : undefined;

    /* What this browser thought it was registered as, BEFORE this attempt. Read here
       because `remember` below overwrites it, and the comparison needs the old value. */
    const previous = remembered();

    const first = await api.registerDevice(token, 'WEB', quiet);
    remember(token);

    /*
       A token this browser remembered, that the server did not have, is a DEAD token.

       FCM invalidates a registration on its own schedule — a reinstall, cleared site
       data, a long absence. The transport is told `UNREGISTERED` and deletes the row;
       the browser goes on presenting the same token from the SDK's own cache, for ever.
       Client and server then disagree in silence and this device never receives another
       push. It happened twice during setup, and the only thing that fixed it was wiping
       the browser profile, which is not something a person can be asked to do.

       `wasKnown: false` on a token we had already stored is exactly that signature —
       the server is telling us it had to insert what we thought was already there. The
       remedy is the one Firebase documents: delete the cached token so `getToken` is
       forced to mint a new one, then register that.

       Only when `previous` matches what we just sent. A FIRST registration is also
       unknown to the server, and re-minting then would churn a token that is perfectly
       good on every new device.
    */
    if (first.wasKnown === false && previous === token) {
      const { deleteToken } = await import('firebase/messaging');
      await deleteToken(getMessaging(app)).catch(() => undefined);
      const minted = await getToken(getMessaging(app), {
        vapidKey: config.vapidKey,
        serviceWorkerRegistration: registration,
      });
      /* A re-mint that returns the same string means FCM still considers it live and
         the disagreement is not staleness. Registering it again would loop. */
      if (minted !== '' && minted !== token) {
        await api.registerDevice(minted, 'WEB', quiet);
        remember(minted);
        /* Retire the dead one. The POST above re-inserted it a moment ago — that is how
           we learned it was dead — and leaving it would have the server push to a token
           FCM has already rejected, once, until the transport is told `UNREGISTERED`
           again and deletes it. Harmless but pointless, and it leaves this device
           looking like two devices in the meantime. */
        await api.forgetDevice(token).catch(() => undefined);
      }
    }

    return 'REGISTERED';
  } catch {
    /* A Firebase failure must not break the settings panel. The switch stays where the
       person put it and the panel says push could not be set up. */
    return 'FAILED';
  }
}

/**
 * Stops push to this browser.
 *
 * The server row goes first: if deleting the Firebase token then fails, the worst case is
 * a token Google still knows about that StarLink will never send to — which is silent and
 * harmless. The reverse order would leave the server sending to a token that no longer
 * exists, which is noise in the outbox.
 */
export async function unregisterFromPush(): Promise<void> {
  const token = remembered();
  if (token !== undefined) {
    await api.forgetDevice(token).catch(() => undefined);
    remember(undefined);
  }
  try {
    const config = pushConfig();
    if (config === undefined) return;
    const [{ getApps }, { getMessaging, deleteToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);
    const app = getApps()[0];
    if (app !== undefined) await deleteToken(getMessaging(app));
  } catch {
    /* Already unreachable from StarLink's side, which is the part that matters. */
  }
}
