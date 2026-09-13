-- ---------------------------------------------------------------------------------------
-- 0027 — one reaction per person per message
--
-- Asked for on 2026-09-08: a person could stack several reactions on the same message, so a
-- single message showed "❤️ 1  👍 1" from one colleague. A reaction is a person's response
-- to a message, and a person has one response — picking a second should REPLACE the first,
-- the way it does in every product that has this control.
--
-- ## Why the key changes rather than the application checking first
--
-- 0011 made the primary key `(message_id, principal_id, emoji)`, which is precisely what
-- permits the stack: the tuple is unique, so three emoji from one person are three legal
-- rows. Narrowing the key to `(message_id, principal_id)` makes a second reaction from the
-- same person impossible to store rather than merely unusual — the same reasoning rule 6
-- applies to conversation ownership. A read-then-write in the route would be a race between
-- two taps on two devices, and the loser would be a duplicate row nobody could explain.
--
-- The emoji stays a plain column. It is now a property of the person's reaction rather than
-- part of its identity, which is exactly what "one reaction, whose value can change" means.
--
-- ## Existing rows
--
-- Anything already stacked has to collapse before the key can narrow. The survivor is the
-- most recent, because that is the one the person chose last and the behaviour this
-- migration installs going forward — `created_at` then `emoji` so the choice is
-- deterministic even for rows written inside the same tick.
-- ---------------------------------------------------------------------------------------

BEGIN;

DELETE FROM conversation.message_reactions AS victim
 USING (
   SELECT message_id,
          principal_id,
          emoji,
          ROW_NUMBER() OVER (
            PARTITION BY message_id, principal_id
            ORDER BY created_at DESC, emoji DESC
          ) AS rank
     FROM conversation.message_reactions
 ) AS ranked
 WHERE victim.message_id = ranked.message_id
   AND victim.principal_id = ranked.principal_id
   AND victim.emoji = ranked.emoji
   AND ranked.rank > 1;

ALTER TABLE conversation.message_reactions
  DROP CONSTRAINT message_reactions_pkey;

ALTER TABLE conversation.message_reactions
  ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, principal_id);

COMMIT;
