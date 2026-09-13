/*
   Quiet hours, carried on the device token.

   ## Why here and not on the principal

   Quiet hours were a browser preference in `localStorage`, applied by the web app before
   it raised a desktop notification. That is fine for in-app and useless for push: the
   decision to send is made in the API, the delivery happens in Google's infrastructure,
   and by the time a service worker could consult a preference the phone has already lit
   up — which is the whole thing being suppressed. A service worker cannot read
   `localStorage` either.

   Per DEVICE rather than per person, deliberately. A laptop that sits on a desk all
   night and a phone on a bedside table want different answers, and the person holding
   both is the only one who knows which is which. The device token is already the row
   that means "this device", so the window belongs on it.

   ## Why a zone name and not an offset

   An offset captured at registration is silently wrong twice a year for anybody in a
   country that observes daylight saving, and it fails in the direction that wakes
   people at six in the morning. An IANA name stays correct because the rules travel
   with it.

   ## All three, or none

   A window with no zone cannot be evaluated and a zone with no window means nothing, so
   the CHECK admits only the two coherent states. Absent is the default and means "always
   deliver" — a device that has never said otherwise is not quiet, which is the failure
   direction that does not silently stop somebody's notifications.

   ## What this does not touch

   The notification row is still written and the unread count still counts it. §29.6
   makes in-app the unread mechanism rather than a preference; this suppresses the BUZZ,
   never the fact. Somebody who sleeps through a quiet window still finds everything
   waiting in the morning.
*/

ALTER TABLE identity.device_tokens
  /* `HH:MM` local to `quiet_zone`. Stored as text rather than `time` because it is a
     wall-clock intention ("eight in the evening"), not an instant — and because a
     `time` would invite somebody to compare it against a timestamp in the wrong zone. */
  ADD COLUMN IF NOT EXISTS quiet_from text,
  ADD COLUMN IF NOT EXISTS quiet_to   text,
  ADD COLUMN IF NOT EXISTS quiet_zone text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_tokens_quiet_hours_complete'
  ) THEN
    ALTER TABLE identity.device_tokens
      ADD CONSTRAINT device_tokens_quiet_hours_complete CHECK (
        (quiet_from IS NULL AND quiet_to IS NULL AND quiet_zone IS NULL)
        OR (quiet_from IS NOT NULL AND quiet_to IS NOT NULL AND quiet_zone IS NOT NULL)
      );
  END IF;
END
$$;

/*
   The shape is checked here as well as in the application, because a half-written window
   is the state that mutes a device for ever and nothing would report it.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_tokens_quiet_hours_well_formed'
  ) THEN
    ALTER TABLE identity.device_tokens
      ADD CONSTRAINT device_tokens_quiet_hours_well_formed CHECK (
        quiet_from IS NULL
        OR (quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND length(quiet_zone) BETWEEN 1 AND 64)
      );
  END IF;
END
$$;
