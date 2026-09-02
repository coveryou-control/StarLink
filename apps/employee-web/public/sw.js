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

  It also does not receive push. Notifications while the application is fully CLOSED need
  Web Push: a VAPID key pair, a subscription stored per principal, and a server-side sender.
  That is real work and it is not here — what this covers is the app running and not in
  front of you, which on a phone is a backgrounded PWA and is the common case.
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
