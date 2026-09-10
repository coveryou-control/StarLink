# Setting up notification delivery

How to turn on **email (SMTP)** and **push (Firebase)** for StarLink, written against the
code that is actually in this repository on 2026-09-10.

The two are not the same size of job, and the first thing this guide does is say so.

---

## Before anything: what already exists

| Channel | Contract | Adapter | Status |
| --- | --- | --- | --- |
| `INAPP` | `NotificationTransport` | `adapters/notification-provider/src/inapp/` | **Built and always on** |
| `EMAIL` | `NotificationTransport` | `adapters/notification-provider/src/email/` | **Built. Configuration only** |
| `PUSH` | declared in `NotificationChannel` | — | **No transport.** But see the client half below |
| `WHATSAPP`, `SMS` | declared | — | Nothing |

There is also a **device layer** in the browser that is not a `NotificationChannel` at
all, and it is further along than the table suggests — see B0.

`NotificationChannel` lives in `packages/shared-contracts/src/adapters/infrastructure.ts`.

### "In-app notifications via Firebase" is two different things here

This matters before you buy anything, because it changes what you are setting up.

**In-app notification already exists and is not Firebase.** In StarLink, in-app *is* the
unread mechanism — the badge on a conversation, the count on the rail. §29.6 says it "is
not disableable", and `inapp-transport.ts` implements exactly that: delivering in-app
means writing a row the recipient's client reads when it next looks. There is no provider
to configure, nothing to switch on, and no reason to route it through Google.

**What Firebase would give you is the `PUSH` channel** — an operating-system notification
that arrives when StarLink is **closed entirely**. There is no FCM code and no
device-token storage.

But the browser-side half is largely built already, which changes the size of the job.
See B0 before planning any of it.

So:

- If you want **badges and counts inside the app** — you already have them.
- If you want **notifications on the desktop or phone when the app is closed** — that is
  Part B, and it is a build, not a setup.

---

# Part A — SMTP (about fifteen minutes)

Everything is written. `SmtpSender` wraps nodemailer with a pooled connection;
`EmailNotificationTransport` addresses the recipient through the employee directory
adapter. You are supplying credentials, not code.

## A1. The settings

All six live in `apps/api/src/config.ts` and follow rule 13 — `SL_` prefix, no fallback to
another product's variables.

| Variable | Default | Notes |
| --- | --- | --- |
| `SL_NOTIFY_TRANSPORTS` | `inapp` | Comma-separated. **Must include `email`** or nothing is sent |
| `SL_NOTIFY_EMAIL_HOST` | — | **The switch.** No host, no sender is constructed at all |
| `SL_NOTIFY_EMAIL_PORT` | `587` | |
| `SL_NOTIFY_EMAIL_SECURE` | `false` | `true` only for implicit TLS on 465. On 587 nodemailer upgrades via STARTTLS |
| `SL_NOTIFY_EMAIL_USER` | — | Optional; omit for an unauthenticated internal relay |
| `SL_NOTIFY_EMAIL_PASSWORD` | — | Optional, as above |
| `SL_NOTIFY_EMAIL_FROM` | — | Envelope sender. A relay will refuse a domain it does not own |

`SL_NOTIFY_EMAIL_HOST` and `SL_NOTIFY_EMAIL_FROM` together are what cause the transport to
be built (`app.module.ts`). With either missing you get **no sender rather than a sender
that pretends** — rows accumulate as `RETRYING`, the backlog gauge climbs, and the
notification is visibly undelivered instead of being silently reported as sent. That is
deliberate; do not "fix" it by supplying a placeholder host.

## A2. Three things beyond the settings, or nothing arrives

Found by running the path rather than reading it. Each of these on its own is enough to
make a correct configuration deliver nothing, and none of them produces an error that
points at itself.

### The event has to be one that mails

`packages/notifications/src/matrix.ts` decides the channels per event, and **most internal
chat does not email**. A mention is `inApp: true, externalIfAway: false, externalAlways:
false` — in-app only, by design.

| Event | Emails |
| --- | --- |
| `WAITING_BEYOND_STANDARD`, `ESCALATED_TO_YOUR_FUNCTION`, `TRANSFERRED`, `ROLE_OR_ACCESS_CHANGED` | Always |
| `CONVERSATION_ASSIGNED`, `CUSTOMER_REPLIED` | Only when the recipient is away |
| `MENTIONED`, ordinary messages | **Never** |

So on a Stage 1 internal-chat workload, turning on SMTP correctly will send **almost
nothing**, and that is the matrix working. If you want mentions to email, that is a change
to `matrix.ts` and a product decision — not configuration.

### The recipient needs an address

The transport resolves one from `identity.principal_contacts`. That table was **empty**,
so an otherwise perfect setup logged "contact channels unavailable" and sent nothing.
`pnpm seed:people` now writes an `EMAIL` contact for each dev account
(`<username>@coveryou.co.in`), so re-run it once:

```bash
pnpm seed:people
```

A missing address is dead-lettered rather than retried — §29.6, "invalid address … not
retried forever" — so it fails quietly and permanently.

### `SL_NOTIFY_EMAIL_SECURE=false` used to mean `true`

Fixed on 2026-09-10. It was `z.coerce.boolean()`, which is `Boolean(value)`, and
`Boolean("false")` is `true`. The documented setting for an ordinary STARTTLS relay on 587
turned implicit TLS **on**, every send threw, and the outbox filled with `RETRYING` rows
carrying `EMAIL_SEND_FAILED` — an error that says nothing about the flag that caused it.

If you are running an API built before that fix, **omit the variable** rather than setting
it to `false`.

## A2b. The commands, in order

Run and verified on 2026-09-10 against a local sink; the mail arrived and the outbox row
reached `SENT`.

```bash
# 1. Addresses for the dev accounts (once).
pnpm seed:people

# 2. Something to receive the mail. MailHog is in the compose file, but this machine has
#    no Docker — this sink needs nothing and listens on 1025.
node .local/smtp-sink.mjs        # leave it running

# 3. The API, with the email transport on.
export SL_NOTIFY_TRANSPORTS=inapp,email
export SL_NOTIFY_EMAIL_HOST=127.0.0.1
export SL_NOTIFY_EMAIL_PORT=1025
export SL_NOTIFY_EMAIL_FROM=starlink@coveryou.co.in
#      SL_NOTIFY_EMAIL_SECURE is left UNSET on purpose — see A2 above.
node apps/api/dist/main.js

# 4. Trigger an event that actually mails, and watch the sink.
node .local/mail-proof.mjs
```

Step 4 enqueues a `ROLE_OR_ACCESS_CHANGED` row — the outbox row the application itself
would write — and everything after it is the product's own sweep, renderer, addresser and
SMTP sender. Within about fifteen seconds the sink prints the message and the row reads
`SENT`.

## A2c. Locally, against MailHog

`pnpm dev:up` already starts MailHog — it is in `infrastructure/deployment/compose.yaml`
on ports 1025 (SMTP) and 8025 (web).

```bash
SL_NOTIFY_TRANSPORTS=inapp,email
SL_NOTIFY_EMAIL_HOST=localhost
SL_NOTIFY_EMAIL_PORT=1025
SL_NOTIFY_EMAIL_FROM=starlink@coveryou.co.in
```

No user or password: MailHog accepts anything and stores it. Restart the API, trigger a
notification (assign a conversation, or mention somebody), then open
**http://localhost:8025**.

> On this machine there is no Docker, so `pnpm dev:up` does not run — see CLAUDE.md's
> local-Postgres fallback. To test SMTP without it, point the host at any relay you can
> reach, or run a throwaway catcher such as `npx maildev` on 1025/1080 and use that
> instead of MailHog. The application does not know the difference.

## A3. Against the real relay

N-07 chose **a corporate SMTP relay** on 2026-08-28, on the grounds that employee
notification is internal traffic and routing it through a third party would add a data
processing agreement for recipients who are all inside the company. That decision is
recorded in `smtp-sender.ts`; if it is being revisited, revisit it there.

```bash
SL_NOTIFY_TRANSPORTS=inapp,email
SL_NOTIFY_EMAIL_HOST=smtp.coveryou.co.in     # your relay
SL_NOTIFY_EMAIL_PORT=587
# SL_NOTIFY_EMAIL_SECURE: leave unset for STARTTLS on 587. Set it to `true` ONLY for
# implicit TLS on 465. See A2 for why writing `false` used to be actively harmful.
SL_NOTIFY_EMAIL_USER=<relay user>
SL_NOTIFY_EMAIL_PASSWORD=<relay password>
SL_NOTIFY_EMAIL_FROM=no-reply@coveryou.co.in
```

Three things the relay owner has to do, none of which are in this repository:

1. **Allow the sending domain.** `SL_NOTIFY_EMAIL_FROM` must be a domain the relay owns,
   or it will refuse the envelope.
2. **Allow the source.** The API's egress address needs to be permitted to relay.
3. **SPF/DKIM for the From domain**, or internal mail clients will file StarLink's
   notifications as spam and the feature will look broken rather than misconfigured.

SES, SendGrid and Postmark all speak SMTP, so moving to a managed provider later is a
change of host and credentials — not a rewrite. A vendor SDK (for bounce feedback, say)
would be a second implementation of the `EmailSender` interface beside `SmtpSender`.

## A4. Verifying it

```bash
pnpm exec vitest run adapters/notification-provider     # the sender's own tests
```

Then end to end, which is the part that matters:

1. Sign in as one dev account, mention another in a conversation.
2. Watch the outbox drain:

```sql
SELECT channel, state, attempts, last_error_code, created_at
  FROM conversation.notification_outbox
 ORDER BY created_at DESC
 LIMIT 10;
```

The states are `PENDING`, `PROCESSING`, `SENT`, `RETRYING` and `DEAD_LETTER`. A working
email lands on `SENT`. If it sits at `RETRYING` with a `last_error_code`, that code is the
relay talking to you and it is usually one of the three points above; after
`SL_NOTIFICATION_MAX_ATTEMPTS` (default 6) it becomes `DEAD_LETTER` and stops.

**A notification that fails must never mean a message that was not stored** (§29.1). If
you break the relay deliberately, messages must keep sending. That is worth testing once,
because it is the property the whole outbox design exists to protect.

---

# Part B — Firebase push (a build, not a setup)

## B0. What the browser side ALREADY has

Correcting an earlier draft of this guide, which said there was no service worker and no
device layer. Both exist:

| File | What it does |
| --- | --- |
| `apps/employee-web/src/lib/device-notifications.ts` | Per-device preferences — direct, groups, sound, quiet hours — in `localStorage`. Raises a system notification through `notify()` |
| `apps/employee-web/public/sw.js` | A real service worker. Registered, `skipWaiting`/`clients.claim`, and a `notificationclick` handler that focuses or opens the right conversation |
| `apps/employee-web/src/lib/use-notifications.ts` | Reads the preferences and calls `notify()` when something arrives |

The service worker exists because Chrome on Android **refuses** `new Notification(...)`
from a page — `ServiceWorkerRegistration.showNotification` is the only supported path
there. Its header is explicit that it has no `fetch` handler on purpose (rule 9:
recovery is re-fetch, and a stale cached response would show somebody a conversation as
it was ten minutes ago) and that it **does not receive push**.

So the gap to Firebase is narrower than "build a client": add a `push` listener to a
service worker that already exists, and a subscription to store.

### A confirmed defect sitting in the middle of this

`Notification.requestPermission()` is called **nowhere** — grep across `apps`, `packages`
and `adapters` returns nothing. `notify()` correctly refuses to ask (a permission prompt
raised by an incoming message is a prompt nobody grants) and returns early unless
permission is already `granted`.

Its docblock says permission "is asked for on the settings screen at the moment somebody
turns a switch on". **There is no such screen**: `quietHours` and
`DEVICE_NOTIFICATION_DEFAULTS` appear in no `.tsx` file. The switches are not rendered
anywhere.

The consequence is that **desktop notifications cannot currently fire at all**, however
the preferences are set — the permission is never requested, so `Notification.permission`
never becomes `granted`. This is worth fixing before any Firebase work, because it is
cheap, it is on the path anyway, and it makes the existing layer work:

1. Render the device switches in Settings (the preferences and defaults already exist).
2. Call `Notification.requestPermission()` when somebody turns one on — never on load.
3. Handle `denied` honestly: say the browser is blocking it and where to change that.

That alone gives notifications while the tab is open or backgrounded, which the comment
above notes "on a phone is a backgrounded PWA and is the common case". Firebase is only
needed for the application being fully closed.

## B1. The shape the transport has to take

This section is what has to be true, not a list of buttons.

`PUSH` is already a valid `NotificationChannel`. What is missing is a
`NotificationTransport` implementation for it, which means the work is bounded and lands
in the same place everything else does:

```
adapters/notification-provider/src/push/
  fcm-sender.ts        # talks to Firebase Admin
  push-transport.ts    # implements NotificationTransport, channel = 'PUSH'
```

Plus three things outside the adapter:

- **Device token storage.** A table of `(principal_id, token, platform, last_seen_at)`,
  in the `identity` schema. Tokens expire and are reissued; a token that FCM reports as
  `UNREGISTERED` must be deleted, or the backlog fills with permanent failures.
- **A `push` listener in the existing service worker.** `public/sw.js` is already
  registered and already handles `notificationclick`; what it does not have is a `push`
  event handler. This is an addition to a working file, not a new one.
- **A permission request** — see B0. It is missing today and blocks the existing device
  layer as well as this.

Register the transport in `app.module.ts` beside the email one, gated the same way:

```ts
if (enabled.has('PUSH')) entries.push(pushTransport);
```

…so `SL_NOTIFY_TRANSPORTS=inapp,email,push` is what turns it on, and an absent
configuration produces no transport rather than a pretending one.

## B2. Settings to add

Following rule 13. Service-account credentials are a secret and belong in the secret
store, never in `.env`:

| Variable | Notes |
| --- | --- |
| `SL_NOTIFY_PUSH_PROJECT_ID` | Firebase project id |
| `SL_NOTIFY_PUSH_CLIENT_EMAIL` | From the service-account JSON |
| `SL_NOTIFY_PUSH_PRIVATE_KEY` | From the service-account JSON. Newlines need unescaping |
| `SL_NOTIFY_PUSH_VAPID_KEY` | Web push certificate, needed by the browser client |

The client also needs the Firebase **web** config (apiKey, appId, messagingSenderId).
Those are not secrets — they identify the project — but they still get `SL_` names and
still travel through `runtime-origins-script.tsx`, which is how this application already hands
server-known values to the browser.

## B3. Two constraints that will shape the payload

**A push may not carry message content.** `NotificationRequest.payload` is documented as
"structured, and never message content" — §29 notifications tell somebody there is
something to look at; the thing itself stays behind the authorization that guards it. A
push notification is delivered by Google to a device that may be locked, shared, or
mirrored to a watch, so this is not a formality:

- Good: *"Rahul mentioned you in #Technology"* with a deep link.
- Refused: the text of what Rahul wrote.

This also means the service worker must fetch the real content **after** the person opens
the notification, through the ordinary authenticated API, where `decide()` runs. A push
that carried the message would be a second read path with no authorization on it — rule 2.

**Device tokens are personal data about employees.** They identify a person's device.
IRDAI's residency rules (CLAUDE.md, "Running the database") bite on policy and claims
records rather than on a push token, so this is not automatically a blocker — but the
token table is in your database, in your region, and only the token goes to Google. Keep
it that way, and get it confirmed rather than assumed.

## B4. Order of work

0. **The permission request and the Settings switches** (B0). Do this first whatever else
   happens — it is small, it unblocks the notification layer that is already built, and
   every later step depends on permission having been granted.
1. Token table and migration.
2. Token registration, from the same Settings control.
3. A `push` listener added to `public/sw.js`, and confirm a push arrives with the browser
   **fully closed** — the whole point, and the step most likely to be quietly broken.
4. `PushNotificationTransport`, registered in `app.module.ts`.
5. `SL_NOTIFY_TRANSPORTS=inapp,email,push`.
6. Token cleanup on `UNREGISTERED`.

Steps 0–3 are the client half and can be built and tested before any server work: a
service worker that receives a push sent by hand from the Firebase console proves the
hard part.

---

## Summary

| | Effort | Blocked on |
| --- | --- | --- |
| **In-app (unread, badges)** | Done | — |
| **Device notifications** | Built but **cannot fire** | The permission request and the Settings switches (B0) |
| **Email** | Configuration | Relay credentials, sending domain, SPF/DKIM |
| **Push (app fully closed)** | A feature | B0 first, then a Firebase project and the build in B4 |

If the immediate need is "people should know when they are mentioned", the cheapest real
progress is **B0 then email**, in that order — B0 is a few hours and switches on a layer
that is already written, and email is an afternoon of which most is waiting on the relay
owner. Firebase is worth doing when "the browser is closed" is the case that matters, and
it is smaller after B0 than before it.

They stack: none of these makes the next any harder, because every one of them is a
transport behind the same port.
