/*
  StarLink service worker — notifications only.

  ## Why one exists at all

  On Android, Chrome REFUSES `new Notification(...)` from a page: it throws
  "Illegal constructor" and the only supported path is
  `ServiceWorkerRegistration.showNotification`. So without this file the product could
  raise a system notification on a laptop and silently could not on a phone, which is the
  device where a notification is the whole point.

  ## What it deliberately does NOT do

  No caching, no offline shell, no fetch handler. A service worker that intercepts `fetch`
  starts deciding what a signed-in employee sees, and a stale cached response on a product
  whose invariant is "recovery is re-fetch" (rule 9) is a way to show somebody a
  conversation as it was ten minutes ago. There is no `fetch` listener here on purpose, and
  adding one is an architecture decision, not a performance tweak.

  It DOES receive push now, as of 2026-09-10. The paragraph that used to sit here said
  push "is real work and it is not here"; the work was done — a VAPID key, a token per
  device in `identity.device_tokens`, and `PushNotificationTransport` sending through
  FCM. What this file adds is the `push` listener at the bottom.
*/

// Take over without waiting for every tab to close, so a fixed worker is the one running.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/*
  Tapping the notification opens the conversation it came from.

  Focus an existing window if one is open — a second tab of the same workspace is not what
  somebody tapping a notification wants — and navigate it. Otherwise open one.
*/
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = event.notification.data && event.notification.data.url;
  if (!target) return;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ('focus' in client) {
            // `navigate` is not available on every client; focusing is the part that matters.
            if ('navigate' in client) return client.navigate(target).then((c) => c && c.focus());
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

/*
  A push arrived while StarLink was closed or in the background.

  ## The payload is DATA, not a notification block

  `fcm-sender.ts` sends `data` deliberately. A `notification` block makes the browser
  render the push itself, which would mean the finished words had to be in the payload
  and this worker would never see it. Rendering here is what lets the product decide what
  a notification looks like — and, more importantly, lets it show LESS than it was given.

  ## It may not contain the message

  Section 29: a notification says there is something to look at; the thing itself stays
  behind the authorization that guards it. The server never puts message text in a push,
  and this worker never asks for any: it shows the title and body it was sent, both built
  from the EVENT, and the deep link. Tapping it opens StarLink, where `decide()` runs
  before a single word of the conversation is read.

  ## Every field is defended

  A service worker cannot show a dialog when something is wrong, so a malformed payload
  must degrade to a plain notification rather than throw — a throw here is a push that
  silently never appears.
*/
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Not JSON. The defaults below are still a truthful notification.
  }

  const data = payload.data ?? payload;
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : 'StarLink';
  const body = typeof data.body === 'string' ? data.body : '';
  const url = typeof data.url === 'string' ? data.url : '/conversations';
  /* One notification per subject, per device: a second mention in the same conversation
     replaces the first rather than stacking two identical rows in the tray. */
  const tag = typeof data.tag === 'string' ? data.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
      ...(tag === undefined ? {} : { tag, renotify: true }),
    }),
  );
});
