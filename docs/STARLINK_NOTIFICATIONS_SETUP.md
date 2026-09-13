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

# Part B — Firebase push

**The build is done** (2026-09-10). This part was a list of work to do; it is now a list
of buttons to press. What exists:

| Piece | Where |
| --- | --- |
| FCM HTTP v1 sender, RS256 JWT signed with Node `crypto` — no Admin SDK | `adapters/notification-provider/src/push/fcm-sender.ts` |
| The transport, `channel = 'PUSH'` | `adapters/notification-provider/src/push/push-transport.ts` |
| Registered behind `SL_NOTIFY_TRANSPORTS` | `apps/api/src/app.module.ts` |
| Device token table | `infrastructure/database/migrations/0033_device_tokens.sql`, applied |
| Register / deregister endpoints | `apps/api/src/notifications/devices.controller.ts` |
| Browser token acquisition, reusing the EXISTING worker | `apps/employee-web/src/lib/push-client.ts` |
| `push` listener | `apps/employee-web/public/sw.js` |
| The switch, and `Notification.requestPermission()` | `apps/employee-web/src/components/notification-settings.tsx` |

## B0. Read this before you start, or you will conclude it is broken

**No event routes to `PUSH`.** `channelsFor()` in `packages/notifications/src/matrix.ts`
returns only `INAPP` and `EMAIL`; there is no rule with a push channel on it. That is
N-22's deliberate dormant state, not an oversight — *"The `PUSH` channel stays in the
`NotificationChannel` union with no §29.2 rule pointing at it, which is the correct
dormant state."*

So when the configuration below is complete, **sending a message will still not push
anything**. The chain is connected end to end and has nothing feeding it. Verifying it
therefore means driving the transport directly (B4), which proves the plumbing; routing
an event to it is a separate, business-owned decision (N-56 asks exactly this for
mentions).

**Push needs a secure context.** `https://`, or `localhost`. A LAN address
(`http://192.168.x.x:3010`) has no service worker and no push — which is the obvious way
to test on a phone and the one that cannot work. Test on the laptop at `localhost` first.

## B1. Create the project

1. <https://console.firebase.google.com> → **Create a project**.
2. Name it (`starlink-coveryou`). Firebase may append a suffix to make the *id* unique —
   the id is what you need later, not the display name.
3. **Google Analytics: off.** Nothing here uses it, and it adds a consent question about
   a third-party processor that this project does not otherwise need to answer.

## B2. Register a web app — four of the seven values

1. Project Overview → the **`</>`** (Web) icon.
2. Nickname: `StarLink employee web`. **Do not** tick Firebase Hosting — StarLink hosts
   itself, and the option sets up a deploy target nobody will use.
3. **Register app.** The `firebaseConfig` block it shows is the payload:

| Console field | Setting |
| --- | --- |
| `apiKey` | `SL_NOTIFY_PUSH_WEB_API_KEY` |
| `appId` | `SL_NOTIFY_PUSH_WEB_APP_ID` |
| `projectId` | `SL_NOTIFY_PUSH_PROJECT_ID` |
| `messagingSenderId` | `SL_NOTIFY_PUSH_SENDER_ID` |

`authDomain` and `storageBucket` are not used — StarLink uses neither Firebase Auth nor
Firebase Storage, and it should stay that way (rule 11: no second user authority).

These four are **not secrets**. They identify the project to Google and are designed to
sit in client source; they still travel through `runtime-origins-script.tsx` rather than
being inlined at build time, because a build baked with one project's ids cannot be
deployed against another.

## B3. The VAPID key and the service account — the other three

**Web Push certificate** (gear ⚙ → **Project settings** → **Cloud Messaging** tab →
*Web configuration* → **Web Push certificates** → **Generate key pair**):

| Console field | Setting |
| --- | --- |
| Key pair (starts `B`, ~87 chars) | `SL_NOTIFY_PUSH_VAPID_KEY` |

While on that tab, confirm **Firebase Cloud Messaging API (V1)** reads **Enabled**. The
sender speaks v1 only. *Cloud Messaging API (Legacy)* can stay disabled — it is
deprecated and nothing here uses it.

**Service account** (Project settings → **Service accounts** → **Generate new private
key** → downloads a JSON file):

| JSON field | Setting |
| --- | --- |
| `client_email` | `SL_NOTIFY_PUSH_CLIENT_EMAIL` |
| `private_key` | `SL_NOTIFY_PUSH_PRIVATE_KEY` |

**That file is a credential that can send to every device in the project.** It does not
go in the repository, in a commit, or in a chat message. Locally it belongs in `.local/`,
which is gitignored; in deployment it belongs in the secret store (rule 13).

The private key is multi-line PEM. In an environment variable its newlines are written
`\n` and `config.ts` unescapes them — so paste it exactly as the JSON has it, quotes and
all, and do not hand-wrap it.

## B4. Proving it works

Order matters: each step fails in a way the next one would hide.

1. **The web app offers the switch.** Settings → Notifications. Absent means the browser
   never received the web config — check `window.__SL_RUNTIME_ORIGINS__.push` in the
   console. All five fields must be non-empty.
2. **Turning it on grants permission and stores a token.** The browser prompts; accept.
   Then `select count(*) from identity.device_tokens` must be 1. Zero with the switch on
   means `getToken` failed — almost always a VAPID key mismatch or a non-secure origin.
3. **A push arrives with the tab open.** Drive the transport directly (see B0 — no event
   routes to push, so nothing in the product will do this for you).
4. **A push arrives with the browser FULLY CLOSED.** This is the whole point and the step
   most likely to be quietly broken. A push that only works with the tab open is the
   service worker not being woken, and it proves nothing that the in-app path did not
   already prove.
5. **A stale token is deleted.** Sending to a token FCM reports `UNREGISTERED` must
   remove the row. Without it the outbox fills with permanent failures and
   `starlink_notification_outbox_depth` never returns to zero — the same always-red-alert
   failure §32.4 exists to prevent.

`SL_NOTIFY_TRANSPORTS=inapp,email,push` is what admits the transport at all. Absent
credentials produce no sender rather than one that fails every send, so a half-configured
project looks undelivered rather than broken — deliberately, and the same posture email
takes.

## B5. Two constraints on the payload, which no configuration can relax

**A push may not carry message content.** `NotificationRequest.payload` is documented as
"structured, and never message content" — §29 notifications say there is something to
look at; the thing itself stays behind the authorization that guards it. A push is
delivered by Google to a device that may be locked, shared, or mirrored to a watch:

- Good: *"Rahul mentioned you in #Technology"*, with a deep link.
- Refused: the text of what Rahul wrote.

The worker therefore fetches the real content **after** the tap, through the ordinary
authenticated API where `decide()` runs. A push carrying the message would be a second
read path with no authorization on it — rule 2.

**Device tokens are personal data about employees.** IRDAI's residency rules (CLAUDE.md,
"Running the database") bite on policy and claims records rather than on a push token, so
this is not automatically a blocker — but the token table is in your database, in your
region, and only the opaque token goes to Google. Keep it that way, and get it confirmed
rather than assumed.

---

## Summary

| | State | Blocked on |
| --- | --- | --- |
| **In-app (unread, badges)** | Working | — |
| **Device notifications** | Working — the switch and the permission request landed 2026-09-10 | — |
| **Email** | Code complete, proven against a local sink | A relay host, a sending domain, SPF/DKIM |
| **Push (browser fully closed)** | Code complete | A Firebase project (B1–B3) |
| **Anything reaching you when the tab is shut** | **Not built** | An event routed to an external channel — a business decision, N-56 |

The last row is the one that matters for going live, and no amount of Firebase
configuration addresses it. Today a direct message, a group message, a channel post and
an announcement all notify **nobody**: only `MENTIONED` raises a notification at all, and
it is in-app only. Separately, `isAway()` always returns `false` until presence is
readable across processes (Part IV §52, Redis), so every "in-app + external if away" rule
resolves to in-app only — meaning even a configured email transport can currently be
triggered by exactly one thing in internal chat, a role grant or revoke.

They stack, and none makes the next harder, because every one is a transport behind the
same port.
