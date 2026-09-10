/*
   Push registration tokens, one row per device.

   ## Why this table exists

   §29's PUSH channel has been a declared `NotificationChannel` with no transport since the
   contracts were written. A transport needs somewhere to send, and for FCM that is a
   registration token the browser mints — not a stable identifier of the person, and not
   something the directory can supply.

   ## The token is the key, not the person

   One employee has several: a laptop, a phone, a second browser. The primary key is the
   TOKEN, so registering the same device twice updates one row rather than accumulating
   duplicates that would each receive a copy of every notification.

   FCM reissues a token when the browser decides to — a reinstall, a cleared site, a long
   absence — so the old one keeps arriving here until FCM reports it `UNREGISTERED`. The
   transport deletes on that verdict; `last_seen_at` is what lets a sweep clear the ones
   that simply went quiet without ever being sent to.

   ## What it is not

   Not a session and not a device inventory. It answers exactly one question — "where do
   I send a push for this principal" — and `ON DELETE CASCADE` means a departing employee's
   tokens leave with their principal rather than lingering as an address for somebody who
   no longer works here.

   ## Residency

   The token is personal data about an employee's device and it stays in StarLink's own
   database, in StarLink's own region. Only the token itself crosses to Google, and only
   at the moment a push is sent — the same posture as an email address reaching an SMTP
   relay.
*/

CREATE TABLE IF NOT EXISTS identity.device_tokens (
  token         text PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES identity.principals (principal_id) ON DELETE CASCADE,
  /*
     What kind of client minted it. `WEB` is the only one today; a native app would add
     its own without a migration, and a transport that must not send a web payload to an
     Android app needs to be able to tell them apart.
  */
  platform      text NOT NULL DEFAULT 'WEB',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_tokens_token_present CHECK (length(btrim(token)) > 0),
  CONSTRAINT device_tokens_platform_known CHECK (platform IN ('WEB', 'ANDROID', 'IOS'))
);

/*
   The transport's only query: every token for one principal. Without this it is a
   sequential scan per notification, on a table that grows with headcount times devices.
*/
CREATE INDEX IF NOT EXISTS device_tokens_by_principal
  ON identity.device_tokens (principal_id);

/* For the sweep that clears tokens nothing has confirmed in a long time. */
CREATE INDEX IF NOT EXISTS device_tokens_by_last_seen
  ON identity.device_tokens (last_seen_at);

COMMENT ON TABLE identity.device_tokens IS
  'FCM registration tokens for push delivery (§29). One row per device; deleted when FCM reports the token unregistered.';
