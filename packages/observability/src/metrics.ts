/**
 * Metric definitions (brief §38, doc §32.3, Part IV §61).
 *
 * This is a catalogue rather than an implementation: names and meanings are declared
 * in one place so that the alert rules in infrastructure/monitoring/alerts.yml and the
 * dashboards refer to the same things the code emits. A metric renamed in code and not
 * in the alert is an alert that silently stops firing.
 *
 * Two of these are product invariants rather than infrastructure health, and both are
 * expected to read ZERO:
 *   * inactive_owner_open_conversations — any other value is unreachable customer work
 *   * message_page_rows_examined_ratio  — drifts from ~1 when a compound index is lost
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  readonly labels?: readonly string[];
  /**
   * Upper bounds, in the metric's own unit, for a histogram. Ignored for other kinds.
   *
   * Declared per metric rather than shared, because a bucket set is only useful if it
   * straddles the threshold somebody alerts on. `histogram_quantile` interpolates WITHIN
   * a bucket, so a p95 target of 300ms measured against boundaries of 0.1 and 1.0 is
   * accurate to within 900ms — which is to say, not accurate at all. Every latency
   * metric here therefore has its NFR target as an explicit boundary.
   */
  readonly buckets?: readonly number[];
}

/**
 * Default latency buckets, in seconds.
 *
 * Roughly logarithmic from 5ms to 10s. Used where a metric has no NFR target of its own;
 * anything with a target declares its own set including that target.
 */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

const define = (
  name: string,
  kind: MetricKind,
  help: string,
  labels?: readonly string[],
  buckets?: readonly number[],
): MetricDefinition => ({
  name,
  kind,
  help,
  ...(labels ? { labels } : {}),
  ...(kind === 'histogram' ? { buckets: buckets ?? DEFAULT_LATENCY_BUCKETS } : {}),
});

export const METRICS = {
  // ------------------------------------------------------------------- messaging
  messagesCreated: define('starlink_messages_created_total', 'counter', 'Messages durably persisted', [
    'conversation_type',
    'visibility',
  ]),
  messageSendAck: define(
    'starlink_message_send_ack_seconds',
    'histogram',
    'Time to acknowledge a send, excluding delivery (NFR-PRF-2 target p95 < 0.3s)',
    undefined,
    // 0.3 is an explicit boundary because `SendAckLatencyBreach` fires on the p95
    // crossing it. Without that edge the quantile would be interpolated across a bucket
    // spanning the threshold, and the alert would trigger on arithmetic rather than on
    // the SLO.
    [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5],
  ),
  messageWriteFailures: define('starlink_message_write_failures_total', 'counter', 'Failed message writes'),
  idempotentReplays: define(
    'starlink_idempotent_replays_total',
    'counter',
    'Sends that returned an existing message rather than creating a duplicate',
  ),

  // -------------------------------------------------------------------- realtime
  activeConnections: define('starlink_active_connections', 'gauge', 'Connected realtime sockets', ['node']),
  reconnectRate: define('starlink_reconnects_total', 'counter', 'Client reconnections'),
  realtimePublishLatency: define(
    'starlink_realtime_publish_seconds',
    'histogram',
    'Outbox commit to backplane publish',
  ),
  realtimePublishFailures: define('starlink_realtime_publish_failures_total', 'counter', 'Backplane publish errors'),
  sequenceGapRecoveries: define(
    'starlink_sequence_gap_recoveries_total',
    'counter',
    'Clients that re-fetched after detecting a gap',
  ),

  // ---------------------------------------------------------- queues and routing
  queueDepth: define('starlink_queue_depth', 'gauge', 'Conversations waiting', ['team', 'priority']),
  oldestWaitingSeconds: define('starlink_oldest_waiting_seconds', 'gauge', 'Age of the oldest waiting item', ['team']),
  availableCapacityUnits: define('starlink_available_capacity_units', 'gauge', 'Unreserved agent capacity', ['team']),
  unassignedConversations: define('starlink_unassigned_conversations', 'gauge', 'Conversations with no owner'),
  /**
   * A team's CONFIGURED waiting standard, exported so `CustomerWaitingBeyondStandard`
   * can compare the live wait against it rather than against a threshold baked into the
   * alert rule. The number itself is D-22/D-23 and unanswered — nothing emits this
   * series until Phase 6 gives calendars and SLA targets somewhere to come from, and
   * inventing one here would be inventing the business's promise to its customers.
   */
  /**
   * Teams that have work to place and no calendar covering now (§23.1, D-20/D-21).
   *
   * Their conversations are still queued and still visible — §23.3's invariant holds —
   * but they are acknowledged as after-hours at every hour, because nobody has said when
   * the team is open. Without this number that reads as a team that is simply never busy.
   */
  teamsWithoutCalendar: define(
    'starlink_teams_without_calendar',
    'gauge',
    'Teams with work to place and no business calendar covering the present moment',
  ),
  /**
   * Placements that THREW, as opposed to being refused.
   *
   * Distinct from the gap between `examined` and `acted`, which is dominated by ordinary
   * skips — an unmapped category, a team with no calendar, an orchestrator refusal. Those
   * are not faults. This is, and it is the one an operator must react to.
   *
   * It matters more than a per-item error usually would because of where a failed
   * placement ends up: `requestRouting` commits the queue entry in its own transaction
   * before the assign runs, and the sweep excludes anything already holding a queue entry.
   * So a failed item leaves the sweep's scope permanently — it sits WAITING, claimable by
   * hand, and nothing will ever place it automatically. Without this counter the only
   * trace is one log line at the instant it happened.
   */
  routingPlacementFailures: define(
    'starlink_routing_placement_failures_total',
    'counter',
    'Conversations whose automatic placement threw and will not be retried by the sweep',
  ),
  teamWaitingThresholdSeconds: define(
    'starlink_team_waiting_threshold_seconds',
    'gauge',
    'Configured maximum acceptable wait for a team — configuration, never a default',
    ['team'],
  ),
  timeToFirstAssignment: define('starlink_time_to_first_assignment_seconds', 'histogram', 'Intake to assignment'),
  reservationExpiries: define(
    'starlink_reservation_expiries_total',
    'counter',
    'Capacity reservations that lapsed and returned work to the queue',
  ),

  /** MUST be zero. Alerted at > 0 (BR-13). */
  inactiveOwnerConversations: define(
    'starlink_inactive_owner_open_conversations',
    'gauge',
    'Open customer conversations owned by an inactive principal — target zero',
  ),

  // ------------------------------------------------------------------ outbox/jobs
  outboxDepth: define('starlink_outbox_depth', 'gauge', 'Unpublished transactional outbox rows'),
  outboxPublished: define('starlink_outbox_published_total', 'counter', 'Outbox rows published'),
  outboxOldestAgeSeconds: define('starlink_outbox_oldest_age_seconds', 'gauge', 'Age of the oldest pending row'),
  jobQueueDepth: define('starlink_job_queue_depth', 'gauge', 'Pending jobs', ['queue']),
  deadLetter: define('starlink_dead_letter_total', 'counter', 'Jobs dead-lettered', ['queue']),
  notificationOutboxDepth: define('starlink_notification_outbox_depth', 'gauge', 'Pending notifications'),

  // ------------------------------------------------------------------------- SLA
  firstResponseLatency: define('starlink_first_response_seconds', 'histogram', 'Customer wait for a human reply', [
    'team',
  ]),
  slaAtRisk: define('starlink_sla_at_risk', 'gauge', 'Cases approaching a target', ['team', 'clock']),
  slaBreaches: define('starlink_sla_breaches_total', 'counter', 'Targets missed', ['team', 'clock']),

  // ---------------------------------------------------------------------- database
  dbQueryLatency: define('starlink_db_query_seconds', 'histogram', 'Query latency', ['operation']),
  /** Alerted when it drifts above 3. Doc §38 measured 301 vs 20,000. */
  rowsExaminedRatio: define(
    'starlink_message_page_rows_examined_ratio',
    'gauge',
    'Rows examined divided by rows returned for the message page — should sit near 1',
  ),

  // ----------------------------------------------------------- security and audit
  authFailures: define('starlink_auth_failures_total', 'counter', 'Authentication failures'),
  authzRefused: define('starlink_authz_refused_total', 'counter', 'Authorization denials', ['action', 'privileged']),
  privilegedReads: define('starlink_privileged_reads_total', 'counter', 'Privileged reads performed', ['action']),
  auditWriteFailures: define('starlink_audit_write_failures_total', 'counter', 'Audit ledger write failures'),

  // -------------------------------------------------------- channels, storage, AI
  channelSendFailures: define('starlink_channel_send_failures_total', 'counter', 'Outbound channel failures', [
    'channel',
  ]),
  channelDeliveryUnknown: define('starlink_channel_delivery_unknown', 'gauge', 'Deliveries awaiting reconciliation', [
    'channel',
  ]),
  attachmentScanBacklog: define('starlink_attachment_scan_backlog', 'gauge', 'Attachments awaiting scan'),
  aiLatency: define('starlink_ai_seconds', 'histogram', 'AI provider latency', ['capability']),
  aiFailures: define('starlink_ai_failures_total', 'counter', 'AI provider failures', ['capability']),
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = (typeof METRICS)[keyof typeof METRICS]['name'];

/** Every metric name the system may emit — used to validate alert rules against code. */
export const ALL_METRIC_NAMES: readonly string[] = Object.freeze(
  Object.values(METRICS).map((m) => m.name),
);
