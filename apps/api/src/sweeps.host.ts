/**
 * Hosts the periodic sweeps and publishes what they find (doc §32.3, ADR-023).
 *
 * `infrastructure/sweeps` had the sweeps and the scheduler, with tests proving both.
 * Nothing ran them. A sweep that no process starts is a function with a test suite —
 * and the failure it exists to expose, work owned by someone who has left, stays
 * invisible for exactly as long as nobody notices the sweep is not running.
 *
 * Nine jobs run here, and the second point is the one that was missing:
 *
 *   * The inactive-owner sweep REPORTS. It never repairs, on purpose — a sweep that
 *     quietly reassigned a departed colleague's work would make §32.3's gauge read zero
 *     forever and the organisation would never learn that departures strand work.
 *   * Its count is written to the gauge, INCLUDING when it is zero. `alerts.yml` asks
 *     `starlink_inactive_owner_open_conversations > 0`; a series that never appears
 *     evaluates over no data and never fires, which is silence that reads as health.
 *     A published zero is a positive statement that the sweep ran and found nothing.
 *   * The reservation sweep releases lapsed holds and returns their work to the queue,
 *     and a publisher recomputes the queue gauges §32.4 alerts on.
 *   * The routing sweep places conversations intake persisted but nothing has routed —
 *     and, because it re-asks the calendar every tick, it is also what picks up an
 *     after-hours conversation when the team opens (§23.3's "next business period").
 *
 * Hosted in the API process rather than a dedicated worker because there is one process
 * today. When a second instance exists both would sweep — harmless for the reporting
 * sweep, and the reservation sweep's release is idempotent (`WHERE released_at IS
 * NULL`), so the duplicate work is wasted rather than wrong.
 *
 * These sweeps ARE ADR-006's throughput tier in its V1-A form, and that is now recorded
 * in the ADR rather than only here (amended 2026-08-28). Two things follow that are
 * easy to miss: ADR-020 classifies notification and attachment work as P1 queueable and
 * message durability as P0 protected, so running them in one process leaves that
 * separation on paper; and §33.2's trigger — "multiple API instances" — is what moves
 * them onto the fabric. The trigger is in ADR-006, not here, so there is one copy of it.
 */
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import {
  MessagePageIndexHealthSweep,
  AttachmentExpirySweep,
  AttachmentScanSweep,
  NotificationDeliverySweep,
  InactiveOwnerSweep,
  ReopenWindowClosureSweep,
  ReservationExpirySweep,
  SlaBreachSweep,
  schedule,
} from '@starlink/sweeps';
import { METRICS, metrics, type Logger } from '@starlink/observability';
import type {
  PgAttachmentStore,
  PgNotificationOutbox,
  PgBusinessCalendarReader,
  PgRoutingStore,
  PgSlaReader,
} from '@starlink/database';
import { DEFAULT_POLICY } from '@starlink/attachments';
import type {
  AttachmentScanner,
  NotificationTransport,
  ObjectStorageProvider,
} from '@starlink/shared-contracts';
import { nextOpening, type BusinessCalendar } from '@starlink/sla';
import type { Timestamp, WorkOrchestratorClient } from '@starlink/shared-contracts';
import {
  ATTACHMENT_SCANNER,
  ATTACHMENT_STORE,
  AUDIT_WRITER,
  CALENDAR_READER,
  CONFIG,
  DATABASE,
  LOGGER,
  NOTIFICATION_OUTBOX,
  NOTIFICATION_TRANSPORTS,
  OBJECT_STORAGE,
  ROUTING_STORE,
  SLA_READER,
  WORK_ORCHESTRATOR,
} from './tokens.js';
import type { ApiConfig } from './config.js';
import { BusinessHours } from './routing/business-hours.js';
import { RoutingSweep, type RoutingPort } from './routing/routing.sweep.js';
import type { AuditWriter } from './audit/audit-writer.js';
import { ConversationNotifier } from './notifications/conversation-notifier.js';
import { renderNotification } from './notifications/render.js';

@Injectable()
export class SweepHost implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #handles: Array<{ stop: () => void }> = [];

  constructor(
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(ROUTING_STORE) private readonly routing: PgRoutingStore,
    @Inject(WORK_ORCHESTRATOR) private readonly orchestrator: WorkOrchestratorClient,
    // Explicit, like every other injection here. `emitDecoratorMetadata` is off by
    // design (see the tsconfig): interfaces do not exist at runtime for metadata to
    // describe, so Nest is given the token rather than asked to infer it. A bare
    // constructor parameter resolves to `undefined` and fails at first use, not at boot.
    @Inject(BusinessHours) private readonly businessHours: BusinessHours,
    @Inject(SLA_READER) private readonly sla: PgSlaReader,
    @Inject(CALENDAR_READER) private readonly calendars: PgBusinessCalendarReader,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(ATTACHMENT_STORE) private readonly attachments: PgAttachmentStore,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageProvider,
    @Inject(ATTACHMENT_SCANNER) private readonly scanner: AttachmentScanner,
    @Inject(NOTIFICATION_OUTBOX) private readonly notifications: PgNotificationOutbox,
    @Inject(NOTIFICATION_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, NotificationTransport>,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
  ) {}

  /**
   * Delivers queued notifications (§29.3, §29.4).
   *
   * §29.3's diagram puts this after the commit point: the operation that caused the
   * notification wrote its outbox row and returned without waiting. Nothing here can fail
   * that operation, and nothing here discards a row because a provider is down — §29.6
   * names the silent backlog as "the failure mode that matters".
   */
  get notificationSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new NotificationDeliverySweep({
      outbox: this.notifications,
      transports: this.transports,
      /**
       * Rendering happens HERE, not in the transport (§29.3's contract shape).
       *
       * Deliberately body-free: the subject says there is something to look at, and the
       * thing itself stays behind the authorization that guards it. A notification
       * carrying message content would be a copy of the conversation with the
       * authorization removed — the same objection §30.4 makes about a search index.
       */
      /**
       * Rendering happens HERE, not in the transport (§29.3's contract shape), and the
       * words live in `render.ts` so they can be tested. Every subject is §29.2's own
       * phrase; the subject used to be the raw event name, which would have sent an email
       * titled `CUSTOMER_REPLIED`.
       */
      render: (row) =>
        renderNotification(row, { employeeOrigin: this.config.SL_WEB_EMPLOYEE_ORIGIN }),
      policy: { maxAttempts: this.config.SL_NOTIFICATION_MAX_ATTEMPTS },
      logger: this.logger,
    });
  }

  /**
   * Scans quarantined uploads and promotes what passes (ADR-012, §28.1).
   *
   * A sweep rather than a queued job because Redis is not here yet — a quarantined
   * attachment is a row, so the work survives a crash without a queue. It becomes a
   * BullMQ consumer with no pipeline change when the fabric arrives.
   */
  get attachmentScanSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new AttachmentScanSweep({
      store: this.attachments,
      scanner: this.scanner,
      storage: this.storage,
      policy: DEFAULT_POLICY,
      logger: this.logger,
    });
  }

  /** Collects uploads that never reached a message (§28.6). */
  get attachmentExpirySweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new AttachmentExpirySweep({
      store: this.attachments,
      storage: this.storage,
      logger: this.logger,
    });
  }

  /**
   * Closes reopen windows that have passed (§21.4, BR-22).
   *
   * The window length is D-08 and unratified — §44.3 calls seven days "arbitrary until
   * the business gives a service standard" — so it is read from configuration rather
   * than fixed here.
   */
  get reopenClosureSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new ReopenWindowClosureSweep({
      pool: this.pool,
      logger: this.logger,
      windowSeconds: this.config.SL_REOPEN_WINDOW_SECONDS,
    });
  }

  /**
   * Publishes §32.4's "documents-examined ratio" — the series `MessagePageIndexRegression`
   * alerts on and which, until 2026-08-29, nothing produced.
   *
   * An alert over an absent series never fires, which reads exactly like health. This one
   * guards §38's paging property, so its silence was the silence of the alarm designed to
   * catch a lost index.
   */
  get indexHealthSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new MessagePageIndexHealthSweep({ pool: this.pool, logger: this.logger });
  }

  /** §23.6's warning and breach stages, fired once each. */
  get slaBreachSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    return new SlaBreachSweep({
      ports: {
        openCases: (limit) => this.sla.openCases(limit),
        factsFor: (id) => this.sla.factsFor(id) as never,
        targetsFor: (scope, at) => this.sla.targetsFor(scope, at) as never,
        calendarsFor: (teamId) => this.calendars.historyFor(teamId),
        alreadyNotified: (id, clock, level) => this.sla.alreadyNotified(id, clock, level),
        recordNotification: (input) => this.sla.recordNotification(input),
      },
      /**
       * §23.5 case B: "The customer's first message becomes routable — immediately if
       * open, at opening if after hours."
       *
       * `afterHours` is read from the queue entry rather than recomputed, because §23.5
       * makes it a fact about the moment of arrival that "a calendar corrected next week
       * must not silently rewrite". The calendar is used only to find the opening that
       * followed — and where there is none within the horizon, no clock has started,
       * which is the honest answer for a team whose hours nobody has configured.
       */
      clockStartFor: (facts, calendars: readonly BusinessCalendar[]) =>
        facts.afterHours ? nextOpening(calendars, facts.arrivedAt) : facts.arrivedAt,
      notifier: {
        /**
         * §23.6: a warning is a "quiet nudge" to the owner; a breach reaches the owner
         * and the team lead.
         *
         * Both are raised through the notification pipeline now that it exists. The
         * stage is carried into the dedupe key: a case already past its target when it
         * becomes routable warns and breaches within a tick or two, and without the
         * stage the breach would land inside the warning's dedupe window and vanish.
         *
         * In-app arrives; email queues undelivered until N-07 selects a provider, which
         * is visible as backlog depth rather than as a row marked sent (§29.6).
         *
         * Neither reaches a customer. §23.6, in capitals in the source: "THE CUSTOMER IS
         * NOT NOTIFIED OF ANY OF THIS. A breach is our failure to manage, not news to
         * deliver."
         */
        warn: async ({ conversationId, clock, state }) => {
          await this.notifier.waitingBeyondStandard(conversationId, 'WARNING', clock);
          this.logger.warn('sla warning', {
            operation: 'sla.warning',
            outcome: 'SUCCEEDED',
            detail: { conversationId, clock, elapsedSeconds: state.elapsedSeconds },
          });
        },
        breach: async ({ conversationId, clock, state }) => {
          await this.notifier.waitingBeyondStandard(conversationId, 'BREACH', clock);
          this.logger.error('sla breached', {
            operation: 'sla.breach',
            outcome: 'FAILED',
            detail: {
              conversationId,
              clock,
              elapsedSeconds: state.elapsedSeconds,
              provisionalTarget: state.provisional,
            },
          });
        },
        /**
         * §23.6's third stage, and the only one that changes state: "RAISE ESCALATION
         * LEVEL · route per the escalation policy · AUDITED".
         *
         * A level, not a state — §21.4 is explicit that escalation is an orthogonal axis,
         * so a case can be escalated AND waiting AND breached at once. `raiseEscalationLevel`
         * increments it; nothing about the conversation's state changes.
         *
         * Audited with the reason the sweep supplies, because this is the one ownership-
         * category event in the system with no human behind it. An audit entry reading
         * "level raised, actor: none, reason: none" would be unanswerable six months later.
         */
        escalate: async ({ conversationId, state, reason }) => {
          const at = new Date().toISOString() as Timestamp;
          const raised = await this.routing.raiseEscalationLevel({ conversationId, reason, at });
          await this.audit.record({
            // No `actorId`: the system raised it. Naming a person for something nobody
            // did is worse than recording plainly that it was automatic.
            actorKind: 'SYSTEM',
            action: 'conversation.escalate',
            targetKind: 'conversation',
            targetId: conversationId,
            outcome: 'SUCCEEDED',
            reason,
            correlationId: conversationId,
            detail: {
              level: raised.level,
              automatic: true,
              elapsedSeconds: state.elapsedSeconds,
            },
          });
          this.logger.warn('escalation level raised automatically', {
            operation: 'sla.escalate',
            outcome: 'SUCCEEDED',
            detail: { conversationId, level: raised.level, reason },
          });
        },
      },
      /**
       * D-25, as answered on 2026-08-27: automatic for Claims and Grievance, a lead's
       * decision everywhere else — §44.5's own recommendation, with its reason that
       * "automatic everywhere risks escalation becoming noise the leads learn to ignore".
       *
       * Matched on the category's ROOT, so `claims.new` and `claims.status` inherit it
       * without needing a row each. A category this does not recognise does not escalate:
       * the failure direction is a human decision rather than an automatic one nobody
       * asked for.
       */
      autoEscalates: (categoryId) =>
        categoryId !== undefined &&
        ['claims', 'grievance'].includes(categoryId.split('.')[0] ?? ''),
      logger: this.logger,
    });
  }

  /**
   * Places conversations intake persisted but nothing has routed (§21.8, §23.3).
   *
   * Intake is forbidden from waiting on this (P-05, NFR-PRF-2), and a fire-and-forget
   * call after the response would lose a conversation to any crash in between. Driving
   * it from committed state makes the recovery path and the happy path the same code.
   */
  get routingSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    const sweep = new RoutingSweep({
      pool: this.pool,
      orchestrator: this.orchestrator as RoutingPort,
      businessHours: this.businessHours,
      /**
       * §29.2's two placement rows. The service decides channels and writes rows; it
       * never delivers, and it never throws into this sweep.
       */
      notifier: {
        assigned: async ({ principalId, conversationId }) => {
          await this.notifier.assigned(conversationId, principalId);
        },
        queued: async ({ teamId, conversationId }) => {
          /**
           * "Team" is the recipient §29.2 names, and a team is not a principal.
           *
           * Fanning out to every member here would need the roster and would write N rows
           * per queued conversation — which is the storm §29.5's coalescing exists to
           * prevent, created deliberately. The team-scope notification needs a recipient
           * model StarLink does not have yet, so this records the intent and stops:
           * §29.2's row is honoured by the queue view, which shows the work, rather than
           * by a notification nobody has designed the addressing for.
           */
          this.logger.info('team queue notification not yet addressable', {
            operation: 'notification.team_queue',
            outcome: 'SUCCEEDED',
            detail: { teamName: teamId, conversationId, pendingRecipientModel: true },
          });
        },
      },
      logger: this.logger,
    });

    /**
     * Wrapped so `failed` reaches an operator.
     *
     * The sweep counts placements that threw, and this getter's declared return type is
     * `{ examined, acted }` — structurally assignable, so `failed` was silently dropped
     * here and read by nothing in the process. `schedule()` discards the result entirely,
     * so the number existed only inside a unit test.
     *
     * That is the failure this file's own header is written against: a count that is
     * computed, returned, and never surfaced is indistinguishable from a system where
     * nothing went wrong. `PlacementFailures` alerts on this series.
     */
    return {
      run: async () => {
        const result = await sweep.run();
        if (result.failed > 0) {
          metrics.increment(METRICS.routingPlacementFailures, result.failed);
        }
        return { examined: result.examined, acted: result.acted };
      },
    };
  }

  /** The inactive-owner sweep, wrapped so its count reaches the gauge. */
  get inactiveOwnerSweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    const sweep = new InactiveOwnerSweep({ pool: this.pool, logger: this.logger });
    return {
      run: async () => {
        const result = await sweep.run();
        // Written on EVERY run, zero included. See the header.
        metrics.set(METRICS.inactiveOwnerConversations, result.stranded.length);
        return { examined: result.examined, acted: result.acted };
      },
    };
  }

  get reservationExpirySweep(): { run: () => Promise<{ examined: number; acted: number }> } {
    const sweep = new ReservationExpirySweep({ pool: this.pool, logger: this.logger });
    return {
      run: async () => {
        const result = await sweep.run();
        if (result.acted > 0) metrics.increment(METRICS.reservationExpiries, result.acted);
        return result;
      },
    };
  }

  /**
   * Publishes the queue gauges §32.4 alerts on.
   *
   * Not a sweep — it repairs nothing and examines nothing — but it runs on the same
   * timer machinery for the same reason: a gauge recomputed from a query cannot drift,
   * while one maintained by events silently goes wrong on the first missed increment.
   *
   * `starlink_available_capacity_units` is deliberately NOT published. It would need a
   * ceiling per person, and D-05 has not set one — an unconfigured ceiling means no
   * ceiling, so the honest value is "unbounded", which is not a number. Publishing a
   * zero or a guess would make `UnassignedConversationsGrowing` fire on fiction.
   */
  get queueMetricsPublisher(): { run: () => Promise<{ examined: number; acted: number }> } {
    return {
      run: async () => {
        const at = new Date().toISOString() as Timestamp;
        const rows = await this.routing.queueDepthByTeam(at);
        for (const row of rows) {
          metrics.set(METRICS.queueDepth, row.waiting, { team: row.teamId, priority: row.priority });
          metrics.set(METRICS.oldestWaitingSeconds, row.oldestSeconds, { team: row.teamId });
        }
        metrics.set(METRICS.unassignedConversations, await this.routing.unassignedConversationCount());

        /**
         * The other half of `CustomerWaitingBeyondStandard`.
         *
         * The rule compares the oldest wait against a configured threshold, and until
         * D-22 had somewhere to live there was nothing to compare against — the alert
         * named a series nothing produced. Published from the FIRST_RESPONSE target so
         * the comparison is against what the business actually promised, per team.
         */
        for (const [team, seconds] of await this.sla.firstResponseTargetsByTeam(at)) {
          metrics.set(METRICS.teamWaitingThresholdSeconds, seconds, { team });
        }

        return { examined: rows.length, acted: 0 };
      },
    };
  }

  onApplicationBootstrap(): void {
    // Publish the zero before the first tick. Between boot and the first sweep the
    // series would otherwise be absent, and an alert evaluating over an absent series
    // is the silence this whole mechanism exists to avoid.
    metrics.set(METRICS.inactiveOwnerConversations, 0);

    this.#handles.push(
      schedule(
        this.inactiveOwnerSweep,
        this.config.SL_SWEEP_INACTIVE_OWNER_SECONDS * 1000,
        this.logger,
        'inactive-owner',
      ),
      schedule(
        this.reservationExpirySweep,
        this.config.SL_SWEEP_RESERVATION_SECONDS * 1000,
        this.logger,
        'reservation-expiry',
      ),
      schedule(
        this.queueMetricsPublisher,
        this.config.SL_QUEUE_METRICS_SECONDS * 1000,
        this.logger,
        'queue-metrics',
      ),
      schedule(
        this.routingSweep,
        this.config.SL_SWEEP_ROUTING_SECONDS * 1000,
        this.logger,
        'routing',
      ),
      schedule(this.slaBreachSweep, this.config.SL_SWEEP_SLA_SECONDS * 1000, this.logger, 'sla'),
      schedule(
        this.reopenClosureSweep,
        this.config.SL_SWEEP_REOPEN_SECONDS * 1000,
        this.logger,
        'reopen-closure',
      ),
      schedule(
        this.attachmentScanSweep,
        this.config.SL_SWEEP_ATTACHMENT_SCAN_SECONDS * 1000,
        this.logger,
        'attachment-scan',
      ),
      schedule(
        this.attachmentExpirySweep,
        this.config.SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS * 1000,
        this.logger,
        'attachment-expiry',
      ),
      schedule(
        this.notificationSweep,
        this.config.SL_SWEEP_NOTIFICATION_SECONDS * 1000,
        this.logger,
        'notification-delivery',
      ),
      schedule(
        this.indexHealthSweep,
        this.config.SL_SWEEP_INDEX_HEALTH_SECONDS * 1000,
        this.logger,
        'index-health',
      ),
    );

    this.logger.info('sweeps scheduled', {
      operation: 'sweeps.start',
      outcome: 'SUCCEEDED',
      detail: {
        inactiveOwnerSeconds: this.config.SL_SWEEP_INACTIVE_OWNER_SECONDS,
        reservationSeconds: this.config.SL_SWEEP_RESERVATION_SECONDS,
        queueMetricsSeconds: this.config.SL_QUEUE_METRICS_SECONDS,
        routingSeconds: this.config.SL_SWEEP_ROUTING_SECONDS,
        slaSeconds: this.config.SL_SWEEP_SLA_SECONDS,
        reopenSeconds: this.config.SL_SWEEP_REOPEN_SECONDS,
        attachmentScanSeconds: this.config.SL_SWEEP_ATTACHMENT_SCAN_SECONDS,
        attachmentExpirySeconds: this.config.SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS,
        notificationSeconds: this.config.SL_SWEEP_NOTIFICATION_SECONDS,
        indexHealthSeconds: this.config.SL_SWEEP_INDEX_HEALTH_SECONDS,
      },
    });
  }

  onApplicationShutdown(): void {
    for (const handle of this.#handles) handle.stop();
    this.#handles.length = 0;
  }
}
