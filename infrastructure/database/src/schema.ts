/**
 * Drizzle schema bindings (ADR-011).
 *
 * These mirror migrations/0001_foundation.sql. The SQL remains the source of truth —
 * migrations are reviewed as SQL because that is what actually runs, and because
 * constraints this system depends on (the ownership-overlap exclusion constraint, the
 * audit-immutability trigger, partial indexes) have no expression in an ORM schema.
 *
 * What Drizzle gives us is a typed query surface over those tables, with a transparent
 * escape hatch to raw SQL for the statements that carry correctness meaning —
 * `FOR UPDATE SKIP LOCKED` on the claim, `ON CONFLICT DO NOTHING RETURNING` on
 * idempotency.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const identitySchema = pgSchema('identity');
export const conversationSchema = pgSchema('conversation');
export const auditSchema = pgSchema('audit');

/* ------------------------------------------------------------------- identity */

export const principals = identitySchema.table(
  'principals',
  {
    principalId: uuid('principal_id').primaryKey(),
    kind: text('kind').notNull(),
    employeeId: text('employee_id'),
    username: text('username'),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    department: text('department'),
    branch: text('branch'),
    managerId: uuid('manager_id'),
    skills: text('skills').array().notNull().default([]),
    products: text('products').array().notNull().default([]),
    languages: text('languages').array().notNull().default([]),
    /** Bumped to revoke; checked on every request and socket message (ADR-008). */
    sessionVersion: integer('session_version').notNull().default(1),
    credentialHash: text('credential_hash'),
    /** TEMPORARY_AUTHORITY until the Central IAM cutover (INTEGRATION_CONTRACTS §12). */
    authority: text('authority').notNull().default('TEMPORARY_AUTHORITY'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeDisplay: index('principals_active_display_idx').on(table.status, table.displayName),
    manager: index('principals_manager_idx').on(table.managerId),
  }),
);

export const teams = identitySchema.table('teams', {
  teamId: text('team_id').primaryKey(),
  displayName: text('display_name').notNull(),
  department: text('department'),
  authority: text('authority').notNull().default('TEMPORARY_AUTHORITY'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamMemberships = identitySchema.table(
  'team_memberships',
  {
    teamId: text('team_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    role: text('role').notNull().default('MEMBER'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byPrincipal: index('team_memberships_principal_idx').on(table.principalId),
  }),
);

export const delegations = identitySchema.table(
  'delegations',
  {
    delegationId: uuid('delegation_id').primaryKey(),
    fromPrincipal: uuid('from_principal').notNull(),
    toPrincipal: uuid('to_principal').notNull(),
    capabilities: text('capabilities').array().notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    /** NOT NULL by design: an unbounded delegation is a permanent grant in disguise. */
    effectiveTo: timestamp('effective_to', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byRecipient: index('delegations_to_principal_idx').on(table.toPrincipal, table.effectiveTo),
  }),
);

export const roleAssignments = identitySchema.table(
  'role_assignments',
  {
    assignmentId: uuid('assignment_id').primaryKey(),
    principalId: uuid('principal_id').notNull(),
    role: text('role').notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    /** Expiry is read from the clock, never from a sweep having run (doc §17.3). */
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    grantedBy: uuid('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byPrincipal: index('role_assignments_principal_idx').on(table.principalId, table.effectiveFrom),
  }),
);

/* --------------------------------------------------------------- conversation */

export const serviceCases = conversationSchema.table(
  'service_cases',
  {
    caseId: uuid('case_id').primaryKey(),
    customerRef: text('customer_ref'),
    categoryId: text('category_id'),
    subCategoryId: text('sub_category_id'),
    priority: text('priority'),
    owningTeamId: text('owning_team_id'),
    designatedEmployeeId: uuid('designated_employee_id'),
    currentOwnerId: uuid('current_owner_id'),
    state: text('state').notNull().default('NEW'),
    /** An orthogonal axis, not a state: escalated AND waiting AND breached can co-occur. */
    escalationLevel: integer('escalation_level').notNull().default(0),
    sensitivity: text('sensitivity').notNull().default('ORDINARY'),
    afterHours: boolean('after_hours').notNull().default(false),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    outcomeCode: text('outcome_code'),
    reopenCount: integer('reopen_count').notNull().default(0),
    slaFirstResponseDue: timestamp('sla_first_response_due', { withTimezone: true }),
    slaResolutionDue: timestamp('sla_resolution_due', { withTimezone: true }),
    slaBreached: boolean('sla_breached').notNull().default(false),
    slaBreachedAt: timestamp('sla_breached_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queue: index('service_cases_queue_idx').on(table.owningTeamId, table.state, table.priority, table.createdAt),
    /** Serves "my work" and the inactive-owner gauge that must read zero. */
    ownerState: index('service_cases_owner_state_idx').on(table.currentOwnerId, table.state),
  }),
);

export const conversations = conversationSchema.table(
  'conversations',
  {
    conversationId: uuid('conversation_id').primaryKey(),
    conversationType: text('conversation_type').notNull(),
    caseId: uuid('case_id'),
    customerRef: text('customer_ref'),
    title: text('title'),
    /** NULL for internal conversations: they have no lifecycle (D-15). */
    state: text('state'),
    sensitivity: text('sensitivity').notNull().default('ORDINARY'),
    /** Per-conversation monotonic sequence for realtime gap detection (doc §20.8). */
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessagePreview: text('last_message_preview'),
    participantCount: integer('participant_count').notNull().default(0),
    tenantId: text('tenant_id').notNull().default('default'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byCase: index('conversations_case_idx').on(table.caseId),
    byActivity: index('conversations_activity_idx').on(table.lastActivityAt),
  }),
);

export const participants = conversationSchema.table(
  'participants',
  {
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    principalKind: text('principal_kind').notNull(),
    /** Rich from the first record: a flat id list would need migrating (doc §24.5). */
    role: text('role').notNull().default('PARTICIPANT'),
    replyAuthority: boolean('reply_authority').notNull().default(false),
    addedBy: uuid('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (table) => ({
    byPrincipal: index('participants_principal_idx').on(table.principalId, table.conversationId),
  }),
);

export const messages = conversationSchema.table(
  'messages',
  {
    messageId: uuid('message_id').primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /**
     * NOT NULL with no default. If the writer cannot establish visibility the insert
     * fails rather than defaulting to customer-visible (BR-27, ADR-021).
     */
    visibility: text('visibility').notNull(),
    senderPrincipalId: uuid('sender_principal_id'),
    senderKind: text('sender_kind').notNull(),
    /** Frozen at send time: a message keeps the name in force when it was sent. */
    senderDisplayName: text('sender_display_name').notNull(),
    channelBindingId: uuid('channel_binding_id'),
    messageClass: text('message_class').notNull().default('TEXT'),
    body: text('body'),
    bodyPayload: jsonb('body_payload'),
    replyToMessageId: uuid('reply_to_message_id'),
    clientMessageId: text('client_message_id'),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The message page. Keeps rows-examined proportional to rows-returned (doc §38). */
    page: index('messages_page_idx').on(table.conversationId, table.createdAt, table.messageId),
    /** Keeps the customer read path from scanning staff content. */
    visibility: index('messages_visibility_idx').on(table.conversationId, table.visibility, table.createdAt),
  }),
);

export const readState = conversationSchema.table('read_state', {
  principalId: uuid('principal_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ownershipEpisodes = conversationSchema.table(
  'ownership_episodes',
  {
    episodeId: uuid('episode_id').primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    caseId: uuid('case_id'),
    ownerId: uuid('owner_id').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    reason: text('reason'),
    assignedBy: uuid('assigned_by'),
    assignmentSource: text('assignment_source').notNull(),
    transferReason: text('transfer_reason'),
    previousOwner: uuid('previous_owner'),
    nextOwner: uuid('next_owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    history: index('ownership_episodes_history_idx').on(table.conversationId, table.effectiveFrom),
  }),
  // NOTE: the exclusion constraint that makes two overlapping episodes IMPOSSIBLE
  // lives in the SQL migration. Drizzle cannot express it, and it is the reason
  // BR-10 is a database guarantee rather than application discipline.
);

export const queueEntries = conversationSchema.table(
  'queue_entries',
  {
    queueEntryId: uuid('queue_entry_id').primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    caseId: uuid('case_id'),
    teamId: text('team_id').notNull(),
    priority: text('priority').notNull().default('NORMAL'),
    state: text('state').notNull().default('WAITING'),
    claimedBy: uuid('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    reservationId: uuid('reservation_id'),
    afterHours: boolean('after_hours').notNull().default(false),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Serves the claim: oldest first within a priority band, FOR UPDATE SKIP LOCKED. */
    claim: index('queue_entries_claim_idx').on(table.teamId, table.state, table.priority, table.enqueuedAt),
  }),
);

/* -------------------------------------------------- outbox and idempotency */

export const outbox = conversationSchema.table(
  'outbox',
  {
    outboxId: uuid('outbox_id').primaryKey(),
    eventName: text('event_name').notNull(),
    eventVersion: integer('event_version').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => ({
    /** The relay's only hot query. */
    pending: index('outbox_pending_idx').on(table.state, table.nextAttemptAt),
  }),
);

export const idempotencyRecords = conversationSchema.table('idempotency_records', {
  scope: text('scope').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  resultRef: text('result_ref'),
  resultPayload: jsonb('result_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const notificationOutbox = conversationSchema.table(
  'notification_outbox',
  {
    notificationId: uuid('notification_id').primaryKey(),
    recipientId: uuid('recipient_id').notNull(),
    recipientKind: text('recipient_kind').notNull(),
    channel: text('channel').notNull(),
    eventName: text('event_name').notNull(),
    targetRef: text('target_ref'),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: text('dedupe_key'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => ({
    pending: index('notification_outbox_pending_idx').on(table.state, table.nextAttemptAt),
    dedupe: uniqueIndex('notification_dedupe_idx').on(table.dedupeKey),
  }),
);

/* ---------------------------------------------------------------------- audit */

/**
 * Append-only. The application role holds INSERT and SELECT only, and a trigger
 * refuses UPDATE/DELETE regardless of grants — so immutability does not depend on
 * anyone remembering it (migration 0002, FR-AUD-1).
 */
export const auditLedger = auditSchema.table(
  'ledger',
  {
    eventId: uuid('event_id').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorKind: text('actor_kind').notNull(),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    correlationId: text('correlation_id').notNull(),
    /** Bounded and structured. Never message content (doc §31.3). */
    detail: jsonb('detail'),
  },
  (table) => ({
    byActor: index('audit_actor_idx').on(table.actorId, table.occurredAt),
    byTarget: index('audit_target_idx').on(table.targetKind, table.targetId, table.occurredAt),
    byAction: index('audit_action_idx').on(table.action, table.occurredAt),
  }),
);

/**
 * Held separately from the ledger with its own, shorter retention.
 *
 * A retention obligation says "delete identifying data after N days"; an audit
 * obligation says "the ledger is immutable". In one record those conflict and
 * immutability is what quietly breaks (doc §31.4).
 */
export const auditRequestContext = auditSchema.table('request_context', {
  correlationId: text('correlation_id').primaryKey(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
