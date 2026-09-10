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
| `PUSH` | declared in `NotificationChannel` | — | **Nothing. Has to be written** |
| `WHATSAPP`, `SMS` | declared | — | Nothing |

`NotificationChannel` lives in `packages/shared-contracts/src/adapters/infrastructure.ts`.

### "In-app notifications via Firebase" is two different things here

This matters before you buy anything, because it changes what you are setting up.

**In-app notification already exists and is not Firebase.** In StarLink, in-app *is* the
unread mechanism — the badge on a conversation, the count on the rail. §29.6 says it "is
not disableable", and `inapp-transport.ts` implements exactly that: delivering in-app
means writing a row the recipient's client reads when it next looks. There is no provider
to configure, nothing to switch on, and no reason to route it through Google.

**What Firebase would give you is the `PUSH` channel** — an operating-system notification
that arrives when StarLink is not the focused tab, or is closed entirely. That is the
thing StarLink cannot currently do, and it is genuinely unbuilt: there is no FCM code, no
service worker, no device-token storage, and `Notification.requestPermission()` appears
nowhere in either web application. I checked; the grep is empty.

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

## A2. Locally, against MailHog

`pnpm dev:up` already starts MailHog — it is in `infrastructure/deployment/compose.yaml`
on ports 1025 (SMTP) and 8025 (web).

```bash
SL_NOTIFY_TRANSPORTS=inapp,email
SL_NOTIFY_EMAIL_HOST=localhost
SL_NOTIFY_EMAIL_PORT=1025
SL_NOTIFY_EMAIL_SECURE=false
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
SL_NOTIFY_EMAIL_SECURE=false
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

Nothing here exists yet. This section is what has to be true, not a list of buttons.

## B1. The shape it has to take

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
- **A service worker** in `apps/employee-web/public/`, which is what receives a push when
  the tab is closed. This is the part with no equivalent anywhere in the codebase today.
- **A permission request.** `Notification.requestPermission()` appears nowhere. It must be
  asked for **after** a deliberate act — a "turn on notifications" control in Settings —
  and never on page load. A permission prompt on arrival is the reliable way to get
  permanently denied.

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

1. Token table and migration.
2. The permission request and the token registration call, behind a Settings control.
3. The service worker, and confirm a push arrives with the tab **closed** — that is the
   whole point and it is the step most likely to be quietly broken.
4. `PushNotificationTransport`, registered in `app.module.ts`.
5. `SL_NOTIFY_TRANSPORTS=inapp,email,push`.
6. Token cleanup on `UNREGISTERED`.

Steps 1–3 are the client-side half and can be built and tested before any server work: a
service worker that receives a push you send by hand from the Firebase console proves the
hard part.

---

## Summary

| | Effort | Blocked on |
| --- | --- | --- |
| **In-app** | Done | — |
| **Email** | Configuration | Relay credentials, sending domain, SPF/DKIM |
| **Push** | A feature | Firebase project, then the build in B4 |

If the immediate need is "people should know when they are mentioned while the tab is
closed", **email is one afternoon away and push is not.** They also stack: turning on
email now does not make the push work later any harder, because both are transports
behind the same port.
