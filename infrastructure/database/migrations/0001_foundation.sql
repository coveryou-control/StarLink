-- =====================================================================================
-- StarLink migration 0001 — foundation
--
-- Establishes the three schemas, the core conversation domain, the transactional
-- outbox, the audit ledger, and the interim identity projection.
--
-- Shapes fixed here are the ones doc §24.5 identifies as expensive to change later:
--   * participants carry role/added_by/added_at/expiry from the first record
--   * ownership is an append-only episode table, never a column on the conversation
--   * message visibility is a NOT NULL column, never an inferred or nullable flag
--   * audit request context is separate from the ledger from the first record
--
-- Expand -> migrate -> contract (brief §55). This migration is expand-only.
-- =====================================================================================

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS audit;

-- btree_gist backs the no-overlapping-ownership exclusion constraint below.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =====================================================================================
-- ENUMS
-- =====================================================================================

CREATE TYPE conversation.conversation_type AS ENUM (
  'INTERNAL_DIRECT', 'INTERNAL_GROUP',
  'CUSTOMER_SERVICE', 'CUSTOMER_SALES', 'CUSTOMER_RENEWAL',
  'CUSTOMER_CLAIM', 'CUSTOMER_GRIEVANCE', 'CUSTOMER_GENERAL',
  'SYSTEM_INTERACTION', 'AI_HANDOFF'
);

-- Deliberately no TRANSFERRED: transfer is an event, escalation is a level (doc K-02).
-- WAITING is split per brief §24 so that waiting-on-customer can pause the resolution
-- clock while waiting-on-internal does not.
CREATE TYPE conversation.conversation_state AS ENUM (
  'NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE',
  'WAITING_CUSTOMER', 'WAITING_INTERNAL',
  'RESOLVED', 'CLOSED'
);

-- The most security-critical type in the product (ADR-021).
CREATE TYPE conversation.message_visibility AS ENUM ('INTERNAL', 'CUSTOMER_VISIBLE');

CREATE TYPE conversation.principal_kind AS ENUM ('EMPLOYEE', 'CUSTOMER', 'SYSTEM', 'AI');

CREATE TYPE conversation.channel_kind AS ENUM (
  'WEBSITE', 'APP', 'WHATSAPP', 'EMAIL', 'SMS', 'VOICE_LINK', 'PUSH', 'INTERNAL'
);

CREATE TYPE conversation.sensitivity_class AS ENUM (
  'ORDINARY', 'FINANCIAL', 'MEDICAL', 'LEGAL', 'GRIEVANCE'
);

CREATE TYPE conversation.assurance AS ENUM (
  'ANONYMOUS', 'PSEUDONYMOUS', 'VERIFIED_CUSTOMER', 'AUTHENTICATED_CUSTOMER'
);

CREATE TYPE conversation.outbox_state AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER');

CREATE TYPE conversation.notification_state AS ENUM (
  'PENDING', 'PROCESSING', 'SENT', 'RETRYING', 'DEAD_LETTER'
);

CREATE TYPE conversation.attachment_state AS ENUM (
  'UPLOAD_GRANTED', 'QUARANTINED', 'SCANNING', 'CLEAN', 'INFECTED', 'REJECTED', 'BOUND', 'EXPIRED'
);

CREATE TYPE conversation.assignment_source AS ENUM (
  'ROUTED', 'CLAIMED', 'LEAD_ASSIGNED', 'REASSIGNED_ON_EXIT', 'COVER', 'ESCALATION', 'TRANSFER'
);

-- =====================================================================================
-- IDENTITY (interim projection — TEMPORARY_AUTHORITY until Central IAM cutover)
--
-- Every row here is stamped so that no dashboard, export or incident review can mistake
-- this for canonical employee truth (brief §48, INTEGRATION_CONTRACTS §12).
-- =====================================================================================

CREATE TABLE identity.principals (
  principal_id      uuid PRIMARY KEY,
  kind              conversation.principal_kind NOT NULL,
  employee_id       text UNIQUE,
  username          text UNIQUE,
  display_name      text NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE',
  department        text,
  branch            text,
  manager_id        uuid REFERENCES identity.principals(principal_id),
  skills            text[] NOT NULL DEFAULT '{}',
  products          text[] NOT NULL DEFAULT '{}',
  languages         text[] NOT NULL DEFAULT '{}',
  -- Bumped to revoke. Checked on every request and socket message (ADR-008).
  session_version   integer NOT NULL DEFAULT 1,
  credential_hash   text,
  authority         text NOT NULL DEFAULT 'TEMPORARY_AUTHORITY',
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principals_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXITED'))
);

CREATE INDEX principals_active_display_idx ON identity.principals (status, display_name);
CREATE INDEX principals_manager_idx ON identity.principals (manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX principals_department_idx ON identity.principals (department) WHERE department IS NOT NULL;

CREATE TABLE identity.teams (
  team_id       text PRIMARY KEY,
  display_name  text NOT NULL,
  department    text,
  authority     text NOT NULL DEFAULT 'TEMPORARY_AUTHORITY',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.team_memberships (
  team_id       text NOT NULL REFERENCES identity.teams(team_id),
  principal_id  uuid NOT NULL REFERENCES identity.principals(principal_id),
  role          text NOT NULL DEFAULT 'MEMBER',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, principal_id)
);

CREATE INDEX team_memberships_principal_idx ON identity.team_memberships (principal_id);

CREATE TABLE identity.role_assignments (
  assignment_id   uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES identity.principals(principal_id),
  role            text NOT NULL,
  scope_kind      text NOT NULL,
  scope_id        text,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  -- Expiry is read from the clock; no sweep job's failure can extend access (doc §17.3).
  effective_to    timestamptz,
  granted_by      uuid NOT NULL REFERENCES identity.principals(principal_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_scope_kind_check CHECK (scope_kind IN ('GLOBAL', 'DEPARTMENT', 'TEAM', 'CONVERSATION'))
);

CREATE INDEX role_assignments_principal_idx ON identity.role_assignments (principal_id, effective_from DESC);

CREATE TABLE identity.delegations (
  delegation_id   uuid PRIMARY KEY,
  from_principal  uuid NOT NULL REFERENCES identity.principals(principal_id),
  to_principal    uuid NOT NULL REFERENCES identity.principals(principal_id),
  capabilities    text[] NOT NULL,
  scope_kind      text NOT NULL,
  scope_id        text,
  effective_from  timestamptz NOT NULL,
  -- NOT NULL by design: an unbounded delegation is a permanent grant in disguise.
  effective_to    timestamptz NOT NULL,
  reason          text NOT NULL,
  granted_by      uuid NOT NULL REFERENCES identity.principals(principal_id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delegations_to_principal_idx ON identity.delegations (to_principal, effective_to DESC)
  WHERE revoked_at IS NULL;

-- =====================================================================================
-- CONFIGURATION (business values are data, never code — brief §57)
--
-- Seeded values are marked FAKE/DEV and are NOT business-approved (D-17..D-26).
-- =====================================================================================

CREATE TABLE conversation.categories (
  category_id           text PRIMARY KEY,
  parent_id             text REFERENCES conversation.categories(category_id),
  display_name          text NOT NULL,
  owning_team_id        text REFERENCES identity.teams(team_id),
  relationship_shaped   boolean NOT NULL DEFAULT false,
  default_priority      text,
  active                boolean NOT NULL DEFAULT true,
  is_seed_placeholder   boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation.business_calendars (
  calendar_id           uuid PRIMARY KEY,
  team_id               text NOT NULL REFERENCES identity.teams(team_id),
  timezone              text NOT NULL,
  -- Versioned + effective-dated so a corrected calendar re-derives SLA history
  -- rather than leaving it wrong (doc §23.5, NFR-PRF-7).
  version               integer NOT NULL DEFAULT 1,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  working_windows       jsonb NOT NULL,
  holidays              jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions            jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_seed_placeholder   boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX business_calendars_team_idx ON conversation.business_calendars (team_id, effective_from DESC);

CREATE TABLE conversation.sla_targets (
  sla_target_id         uuid PRIMARY KEY,
  scope_kind            text NOT NULL,
  scope_id              text NOT NULL,
  clock                 text NOT NULL,
  target_seconds        integer NOT NULL,
  basis                 text NOT NULL,
  warning_pct           integer NOT NULL DEFAULT 80,
  version               integer NOT NULL DEFAULT 1,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  is_seed_placeholder   boolean NOT NULL DEFAULT false,
  CONSTRAINT sla_clock_check CHECK (clock IN ('FIRST_RESPONSE', 'RESOLUTION', 'ESCALATION')),
  CONSTRAINT sla_basis_check CHECK (basis IN ('BUSINESS_HOURS', 'CALENDAR_24X7'))
);

CREATE TABLE conversation.capacity_policies (
  policy_id             uuid PRIMARY KEY,
  scope_kind            text NOT NULL,
  scope_id              text NOT NULL,
  capacity_units        integer NOT NULL,
  -- Never a hard-coded "5 chats" (brief §12): weights per work type, configurable.
  work_weights          jsonb NOT NULL,
  reservation_ttl_sec   integer NOT NULL DEFAULT 120,
  is_seed_placeholder   boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation.feature_flags (
  flag_key      text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  targeting     jsonb NOT NULL DEFAULT '{}'::jsonb,
  description   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================================
-- SERVICE CASE  (one case, many conversations — doc §22.4)
-- =====================================================================================

CREATE TABLE conversation.service_cases (
  case_id                 uuid PRIMARY KEY,
  customer_ref            text,
  category_id             text REFERENCES conversation.categories(category_id),
  sub_category_id         text REFERENCES conversation.categories(category_id),
  priority                text,
  owning_team_id          text REFERENCES identity.teams(team_id),
  designated_employee_id  uuid REFERENCES identity.principals(principal_id),
  current_owner_id        uuid REFERENCES identity.principals(principal_id),
  state                   conversation.conversation_state NOT NULL DEFAULT 'NEW',
  -- An orthogonal axis, not a state: a case can be escalated AND waiting AND breached.
  escalation_level        integer NOT NULL DEFAULT 0,
  sensitivity             conversation.sensitivity_class NOT NULL DEFAULT 'ORDINARY',
  after_hours             boolean NOT NULL DEFAULT false,
  first_response_at       timestamptz,
  resolved_at             timestamptz,
  outcome_code            text,
  reopen_count            integer NOT NULL DEFAULT 0,
  sla_first_response_due  timestamptz,
  sla_resolution_due      timestamptz,
  sla_breached            boolean NOT NULL DEFAULT false,
  sla_breached_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Queue view: oldest first within a priority band (doc §23.4).
CREATE INDEX service_cases_queue_idx
  ON conversation.service_cases (owning_team_id, state, priority, created_at);
-- "My work", and the inactive-owner alert that must read zero (doc §32.3).
CREATE INDEX service_cases_owner_state_idx ON conversation.service_cases (current_owner_id, state);
CREATE INDEX service_cases_designated_idx
  ON conversation.service_cases (designated_employee_id, customer_ref)
  WHERE designated_employee_id IS NOT NULL;
CREATE INDEX service_cases_customer_idx ON conversation.service_cases (customer_ref, created_at DESC);
CREATE INDEX service_cases_breach_idx ON conversation.service_cases (sla_breached, state) WHERE sla_breached;
-- Partial index: the SLA sweep touches only live clocks, never every case ever created.
CREATE INDEX service_cases_running_clock_idx
  ON conversation.service_cases (sla_first_response_due)
  WHERE state IN ('NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_INTERNAL')
    AND sla_first_response_due IS NOT NULL;
CREATE INDEX service_cases_after_hours_idx
  ON conversation.service_cases (after_hours, owning_team_id) WHERE after_hours;

-- =====================================================================================
-- CONVERSATION
-- =====================================================================================

CREATE TABLE conversation.conversations (
  conversation_id     uuid PRIMARY KEY,
  conversation_type   conversation.conversation_type NOT NULL,
  case_id             uuid REFERENCES conversation.service_cases(case_id),
  customer_ref        text,
  title               text,
  state               conversation.conversation_state,
  sensitivity         conversation.sensitivity_class NOT NULL DEFAULT 'ORDINARY',
  -- Per-conversation monotonic sequence for realtime gap detection (doc §20.8).
  -- Global ordering is deliberately not attempted; nothing compares two timelines.
  last_seq            bigint NOT NULL DEFAULT 0,
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  last_message_preview text,
  participant_count   integer NOT NULL DEFAULT 0,
  tenant_id           text NOT NULL DEFAULT 'default',
  created_by          uuid REFERENCES identity.principals(principal_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Internal conversations have no lifecycle (D-15); customer conversations must have one.
  CONSTRAINT conversations_state_presence CHECK (
    (conversation_type IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP') AND state IS NULL)
    OR (conversation_type NOT IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP') AND state IS NOT NULL)
  )
);

CREATE INDEX conversations_case_idx ON conversation.conversations (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX conversations_customer_activity_idx
  ON conversation.conversations (customer_ref, last_activity_at DESC) WHERE customer_ref IS NOT NULL;
CREATE INDEX conversations_activity_idx ON conversation.conversations (last_activity_at DESC);

CREATE TABLE conversation.participants (
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  principal_id      uuid NOT NULL,
  principal_kind    conversation.principal_kind NOT NULL,
  -- Rich from the first record (doc §24.5): a flat id list would need migrating before
  -- anyone could hold a role or a time-boxed view.
  role              text NOT NULL DEFAULT 'PARTICIPANT',
  reply_authority   boolean NOT NULL DEFAULT false,
  added_by          uuid,
  added_at          timestamptz NOT NULL DEFAULT now(),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,
  PRIMARY KEY (conversation_id, principal_id)
);

-- The dominant employee read: "my threads, newest activity first".
CREATE INDEX participants_principal_idx ON conversation.participants (principal_id, conversation_id);
CREATE INDEX participants_active_idx ON conversation.participants (principal_id) WHERE effective_to IS NULL;

CREATE TABLE conversation.channel_bindings (
  binding_id          uuid PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  channel             conversation.channel_kind NOT NULL,
  external_thread_id  text,
  external_identity   text,
  assurance           conversation.assurance,
  session_started_at  timestamptz NOT NULL DEFAULT now(),
  session_ended_at    timestamptz,
  adapter_version     text,
  transport_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX channel_bindings_external_idx
  ON conversation.channel_bindings (channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
CREATE INDEX channel_bindings_conversation_idx ON conversation.channel_bindings (conversation_id);

CREATE TABLE conversation.business_links (
  link_id           uuid PRIMARY KEY,
  conversation_id   uuid REFERENCES conversation.conversations(conversation_id),
  case_id           uuid REFERENCES conversation.service_cases(case_id),
  -- A reference plus a display cache. Never an authoritative copy (brief §2, §21).
  ref_system        text NOT NULL,
  ref_type          text NOT NULL,
  ref_id            text NOT NULL,
  relation          text NOT NULL,
  cached_context    jsonb,
  cached_at         timestamptz,
  cache_ttl_seconds integer,
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_links_target_present CHECK (conversation_id IS NOT NULL OR case_id IS NOT NULL)
);

CREATE INDEX business_links_ref_idx ON conversation.business_links (ref_system, ref_type, ref_id);
CREATE INDEX business_links_conversation_idx ON conversation.business_links (conversation_id);

-- =====================================================================================
-- MESSAGES
-- =====================================================================================

CREATE TABLE conversation.messages (
  message_id          uuid PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  seq                 bigint NOT NULL,
  -- NOT NULL, no default: if the writer cannot establish visibility, the insert fails
  -- rather than defaulting to customer-visible (BR-27, ADR-021).
  visibility          conversation.message_visibility NOT NULL,
  sender_principal_id uuid,
  sender_kind         conversation.principal_kind NOT NULL,
  -- Frozen at send time. A message keeps the name in force when it was sent, because
  -- it is a historical record someone may later have to argue from (doc §24.9).
  sender_display_name text NOT NULL,
  channel_binding_id  uuid REFERENCES conversation.channel_bindings(binding_id),
  message_class       text NOT NULL DEFAULT 'TEXT',
  body                text,
  body_payload        jsonb,
  reply_to_message_id uuid REFERENCES conversation.messages(message_id),
  client_message_id   text,
  redacted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

-- The message page. This exact index shape is what keeps rows-examined proportional to
-- rows-returned; doc §38 measured 301 vs 20,000 when it was absent. Monitored, not hoped.
CREATE INDEX messages_page_idx ON conversation.messages (conversation_id, created_at DESC, message_id DESC);
-- Keeps the customer read path from scanning staff content.
CREATE INDEX messages_visibility_idx ON conversation.messages (conversation_id, visibility, created_at DESC);
-- Idempotency: a retried send returns the original rather than creating a second message.
CREATE UNIQUE INDEX messages_client_idempotency_idx
  ON conversation.messages (conversation_id, sender_principal_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX messages_reply_idx ON conversation.messages (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE conversation.message_revisions (
  revision_id   uuid PRIMARY KEY,
  message_id    uuid NOT NULL REFERENCES conversation.messages(message_id),
  revision_kind text NOT NULL,
  previous_body text,
  actor_id      uuid,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revision_kind_check CHECK (revision_kind IN ('CORRECTION', 'REDACTION', 'TOMBSTONE'))
);

CREATE INDEX message_revisions_message_idx ON conversation.message_revisions (message_id, created_at);

CREATE TABLE conversation.read_state (
  principal_id      uuid NOT NULL,
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  last_read_seq     bigint NOT NULL DEFAULT 0,
  last_read_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, conversation_id)
);

CREATE TABLE conversation.delivery_state (
  message_id      uuid NOT NULL REFERENCES conversation.messages(message_id),
  destination     text NOT NULL,
  channel         conversation.channel_kind NOT NULL,
  status          text NOT NULL,
  provider_ref    text,
  attempts        integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, destination),
  -- UNKNOWN is first-class: an ambiguous provider result triggers reconciliation
  -- rather than optimistic success (doc Part IV §53).
  CONSTRAINT delivery_status_check CHECK (
    status IN ('QUEUED', 'ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN', 'SUPERSEDED')
  )
);

CREATE INDEX delivery_state_unknown_idx ON conversation.delivery_state (status, updated_at)
  WHERE status = 'UNKNOWN';

-- =====================================================================================
-- ROUTING: ownership episodes, queue, events
-- =====================================================================================

CREATE TABLE conversation.ownership_episodes (
  episode_id        uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  case_id           uuid REFERENCES conversation.service_cases(case_id),
  owner_id          uuid NOT NULL REFERENCES identity.principals(principal_id),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,
  reason            text,
  assigned_by       uuid REFERENCES identity.principals(principal_id),
  assignment_source conversation.assignment_source NOT NULL,
  transfer_reason   text,
  previous_owner    uuid REFERENCES identity.principals(principal_id),
  next_owner        uuid REFERENCES identity.principals(principal_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ownership_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- BR-10 as a DATABASE guarantee, not an application convention: two overlapping
  -- episodes for one conversation cannot be committed, so a concurrent transfer race
  -- cannot produce two simultaneous owners.
  CONSTRAINT ownership_no_overlap EXCLUDE USING gist (
    conversation_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE INDEX ownership_episodes_history_idx
  ON conversation.ownership_episodes (conversation_id, effective_from DESC);
CREATE INDEX ownership_episodes_current_idx
  ON conversation.ownership_episodes (owner_id) WHERE effective_to IS NULL;

CREATE TABLE conversation.queue_entries (
  queue_entry_id    uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  case_id           uuid REFERENCES conversation.service_cases(case_id),
  team_id           text NOT NULL REFERENCES identity.teams(team_id),
  priority          text NOT NULL DEFAULT 'NORMAL',
  state             text NOT NULL DEFAULT 'WAITING',
  claimed_by        uuid REFERENCES identity.principals(principal_id),
  claimed_at        timestamptz,
  reservation_id    uuid,
  after_hours       boolean NOT NULL DEFAULT false,
  enqueued_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_state_check CHECK (state IN ('WAITING', 'RESERVED', 'CLAIMED', 'CANCELLED'))
);

-- Serves the claim query: oldest first within a priority band, FOR UPDATE SKIP LOCKED.
CREATE INDEX queue_entries_claim_idx
  ON conversation.queue_entries (team_id, state, priority, enqueued_at)
  WHERE state = 'WAITING';
CREATE UNIQUE INDEX queue_entries_conversation_idx
  ON conversation.queue_entries (conversation_id) WHERE state IN ('WAITING', 'RESERVED');

CREATE TABLE conversation.transfer_events (
  transfer_id       uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  case_id           uuid REFERENCES conversation.service_cases(case_id),
  from_principal    uuid REFERENCES identity.principals(principal_id),
  to_principal      uuid REFERENCES identity.principals(principal_id),
  to_team           text REFERENCES identity.teams(team_id),
  reason            text NOT NULL,
  actor_id          uuid NOT NULL REFERENCES identity.principals(principal_id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transfer_events_conversation_idx ON conversation.transfer_events (conversation_id, created_at DESC);

CREATE TABLE conversation.escalation_events (
  escalation_id     uuid PRIMARY KEY,
  case_id           uuid NOT NULL REFERENCES conversation.service_cases(case_id),
  conversation_id   uuid REFERENCES conversation.conversations(conversation_id),
  from_level        integer NOT NULL,
  to_level          integer NOT NULL,
  to_team           text REFERENCES identity.teams(team_id),
  reason            text NOT NULL,
  actor_id          uuid REFERENCES identity.principals(principal_id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX escalation_events_case_idx ON conversation.escalation_events (case_id, to_level);

CREATE TABLE conversation.temporary_access_grants (
  grant_id        uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES identity.principals(principal_id),
  conversation_id uuid REFERENCES conversation.conversations(conversation_id),
  case_id         uuid REFERENCES conversation.service_cases(case_id),
  capability      text NOT NULL,
  reason          text NOT NULL,
  granted_by      uuid NOT NULL REFERENCES identity.principals(principal_id),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX temporary_grants_lookup_idx
  ON conversation.temporary_access_grants (principal_id, conversation_id, effective_to)
  WHERE revoked_at IS NULL;

-- =====================================================================================
-- ATTACHMENTS
-- =====================================================================================

CREATE TABLE conversation.attachments (
  attachment_id     uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  message_id        uuid REFERENCES conversation.messages(message_id),
  uploader_id       uuid,
  uploader_kind     conversation.principal_kind NOT NULL,
  declared_mime     text NOT NULL,
  sniffed_mime      text,
  declared_bytes    bigint NOT NULL,
  actual_bytes      bigint,
  original_filename text,
  quarantine_key    text,
  clean_key         text,
  state             conversation.attachment_state NOT NULL DEFAULT 'UPLOAD_GRANTED',
  classification    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz
);

CREATE INDEX attachments_conversation_idx ON conversation.attachments (conversation_id, created_at DESC);
-- Unbound uploads are reachable by nobody and expire on a schedule (doc §28.1/§28.6).
CREATE INDEX attachments_unbound_idx ON conversation.attachments (state, expires_at)
  WHERE message_id IS NULL;

CREATE TABLE conversation.attachment_scan_results (
  scan_id         uuid PRIMARY KEY,
  attachment_id   uuid NOT NULL REFERENCES conversation.attachments(attachment_id),
  verdict         text NOT NULL,
  scanner         text NOT NULL,
  scanner_version text,
  detail          jsonb,
  scanned_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_verdict_check CHECK (verdict IN ('CLEAN', 'INFECTED', 'SUSPICIOUS', 'FAILED'))
);

CREATE INDEX attachment_scan_results_attachment_idx ON conversation.attachment_scan_results (attachment_id);

-- =====================================================================================
-- OUTBOX, IDEMPOTENCY, NOTIFICATIONS
-- =====================================================================================

-- The transactional outbox: written in the SAME transaction as the state change it
-- describes, so a committed business fact and its event can never drift (brief §17).
CREATE TABLE conversation.outbox (
  outbox_id       uuid PRIMARY KEY,
  event_name      text NOT NULL,
  event_version   integer NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  correlation_id  text NOT NULL,
  causation_id    text,
  state           conversation.outbox_state NOT NULL DEFAULT 'PENDING',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);

-- The relay's only hot query.
CREATE INDEX outbox_pending_idx ON conversation.outbox (state, next_attempt_at)
  WHERE state IN ('PENDING', 'PROCESSING');
CREATE INDEX outbox_aggregate_idx ON conversation.outbox (aggregate_type, aggregate_id);

CREATE TABLE conversation.idempotency_records (
  scope           text NOT NULL,
  idempotency_key text NOT NULL,
  result_ref      text,
  result_payload  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX idempotency_expiry_idx ON conversation.idempotency_records (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE conversation.notification_outbox (
  notification_id   uuid PRIMARY KEY,
  recipient_id      uuid NOT NULL,
  recipient_kind    conversation.principal_kind NOT NULL,
  channel           text NOT NULL,
  event_name        text NOT NULL,
  target_ref        text,
  payload           jsonb NOT NULL,
  state             conversation.notification_state NOT NULL DEFAULT 'PENDING',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  dedupe_key        text,
  last_error_code   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);

CREATE INDEX notification_outbox_pending_idx ON conversation.notification_outbox (state, next_attempt_at)
  WHERE state IN ('PENDING', 'RETRYING', 'PROCESSING');
-- Deduplication of noisy notifications (brief §34).
CREATE UNIQUE INDEX notification_dedupe_idx ON conversation.notification_outbox (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state <> 'DEAD_LETTER';

-- =====================================================================================
-- AUDIT
--
-- Two stores, deliberately (doc §31.4). A retention obligation says "delete identifying
-- data after N days"; an audit obligation says "the ledger is immutable". Held in one
-- record those conflict and immutability is what quietly breaks. Split, both hold.
-- =====================================================================================

CREATE TABLE audit.ledger (
  event_id        uuid PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,
  actor_kind      conversation.principal_kind NOT NULL,
  action          text NOT NULL,
  target_kind     text NOT NULL,
  target_id       text NOT NULL,
  outcome         text NOT NULL,
  reason          text,
  correlation_id  text NOT NULL,
  -- Bounded, structured, and never message content (doc §31.3).
  detail          jsonb,
  CONSTRAINT audit_outcome_check CHECK (outcome IN ('SUCCEEDED', 'REFUSED', 'FAILED'))
);

-- The four forensic queries (doc §31.5). Separate indexes: these do not combine.
CREATE INDEX audit_actor_idx ON audit.ledger (actor_id, occurred_at DESC);
CREATE INDEX audit_target_idx ON audit.ledger (target_kind, target_id, occurred_at DESC);
CREATE INDEX audit_action_idx ON audit.ledger (action, occurred_at DESC);
CREATE INDEX audit_correlation_idx ON audit.ledger (correlation_id);

CREATE TABLE audit.request_context (
  correlation_id  text PRIMARY KEY,
  ip_address      inet,
  user_agent      text,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  -- Own, shorter retention. The ledger stays meaningful after this expires:
  -- "who did what" survives, "from which address" does not.
  expires_at      timestamptz NOT NULL
);

CREATE INDEX request_context_expiry_idx ON audit.request_context (expires_at);
