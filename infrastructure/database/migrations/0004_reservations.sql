-- =====================================================================================
-- 0004 · Capacity reservations (ADR-023, doc §21.9, brief §12)
--
-- A reservation is a HOLD on an agent's capacity while they are being given work. It
-- exists so that two conversations routed to the same person in the same second cannot
-- both succeed against a capacity of one.
--
-- Three properties, each with a reason:
--
--   * **It expires.** `expires_at` is NOT NULL. A reservation that outlives the attempt
--     it was made for silently consumes capacity forever — the agent looks busy, the
--     router stops sending them work, and nobody can see why. Expiry returns the work to
--     the queue (ADR-023).
--   * **It is weighted.** Never a hard-coded "5 chats" (brief §12): a claim conversation
--     costs more than a renewal question, and the weights are configuration
--     (`capacity_policies.work_weights`).
--   * **It is released, not deleted.** `released_at` is set rather than the row removed,
--     so "why was this agent at capacity at 14:05" stays answerable — the same
--     discipline as ownership episodes and role grants (§17.3).
--
-- Live capacity is therefore a query over this table, not a counter. A counter drifts;
-- a query cannot.
-- =====================================================================================

CREATE TABLE conversation.reservations (
  reservation_id  uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES identity.principals(principal_id),
  -- The work being held for. A CanonicalRef flattened, so a reservation can point at a
  -- conversation, a case, or an upstream object without a column per kind.
  ref_system      text NOT NULL,
  ref_type        text NOT NULL,
  ref_id          text NOT NULL,
  weight          integer NOT NULL CHECK (weight > 0),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz,
  release_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_window_valid CHECK (expires_at > effective_from)
);

-- The capacity question: "what does this person currently hold?" Partial, because a
-- released reservation is history and never part of the sum.
CREATE INDEX reservations_live_idx
  ON conversation.reservations (principal_id, expires_at)
  WHERE released_at IS NULL;

-- One live reservation per (principal, work). A retried routing attempt must not stack
-- two holds for the same conversation and push the agent over a ceiling they are not
-- actually at.
CREATE UNIQUE INDEX reservations_unique_live_work_idx
  ON conversation.reservations (principal_id, ref_system, ref_type, ref_id)
  WHERE released_at IS NULL;
