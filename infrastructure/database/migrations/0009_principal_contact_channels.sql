-- =====================================================================================
-- 0009 — contact channels, the fifth operation of the identity provider
--
-- §17.2 specifies the identity provider interface as FIVE operations: "resolve a
-- principal · list the directory · read organisational attributes · resolve reporting
-- scope · **resolve contact channels**", with "contact channels" also named in its
-- Outputs. Four were built; this is the fifth. It was not a decision left open — the
-- section states plainly that "V1 implements this against StarLink's own store. When
-- the HRMS arrives a second implementation satisfies the same interface and no other
-- component changes", and A-13 confirms the transition costs nothing: "the provider
-- interface holds either way. Already designed for (§17.2)."
--
-- ## Why a table and not a column on identity.principals
--
-- Three reasons, in order of how much they matter.
--
-- 1. **§17.2 says "channels", plural.** One column models one channel and has to be
--    migrated the first time a second is needed. A row per channel does not.
-- 2. **Contact data should not ride along with identity.** `identity.principals` is read
--    on nearly every authenticated request. A column there puts an email address into
--    the working set of every session check that has no business with it, and into the
--    result of any future `SELECT *`. Part IV §58's rule for customer contact data —
--    "raw mobile/email/PII exposure is separate capability, purpose-bound" — is about
--    customers, but the shape of the argument holds for staff: contact data is reached
--    deliberately, through an operation, not carried everywhere by default.
-- 3. **HRMS takes this over (A-13).** When it does, this table is dropped whole. A column
--    on the principal row would have to be picked out of a table that is staying.
--
-- ## Deliberately not here
--
-- No verification state, no preference, no primary/secondary flag. §17.2 asks the
-- provider to RESOLVE contact channels, not to govern them — governance is HRMS's when
-- it arrives, and inventing a verification workflow now would be building the thing the
-- provider interface exists to avoid owning. Notification preferences already have their
-- own table (0008); they are a different question and stay separate.
-- =====================================================================================

CREATE TABLE identity.principal_contacts (
  principal_id  uuid NOT NULL REFERENCES identity.principals(principal_id) ON DELETE CASCADE,
  -- The transport this address is for. Constrained rather than free text: an unknown
  -- channel silently stored is an address nothing will ever read.
  channel       text NOT NULL,
  address       text NOT NULL,
  -- Provenance, so a support question about a wrong address has an answer. 'LOCAL' is
  -- StarLink's own store per §17.2; 'HRMS' is what the Phase 9 adapter will write.
  source        text NOT NULL DEFAULT 'LOCAL',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, channel),
  CONSTRAINT principal_contacts_channel_check CHECK (channel IN ('EMAIL', 'MOBILE')),
  CONSTRAINT principal_contacts_source_check CHECK (source IN ('LOCAL', 'HRMS')),
  CONSTRAINT principal_contacts_address_present CHECK (length(btrim(address)) > 0)
);

-- No index beyond the primary key: every read is by principal, which the PK already
-- serves. An index on `address` would make this table answer "who owns this address",
-- which is a reverse lookup nothing needs and a small enumeration surface.
