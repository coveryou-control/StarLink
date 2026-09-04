/**
 * The composition root.
 *
 * This is the ONE file that knows which implementation sits behind each interface.
 * Everything else asks for a token. That is what makes "replace the adapter, don't
 * rewrite the domain" true at the Phase 9 IAM cutover and the Phase 10 CCS cutover:
 * the change lands here and in configuration, nowhere else.
 */
import { Module, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import pg from 'pg';
import { LocalIamAdapter, MockIamAdapter } from '@starlink/adapter-iam';
import { LocalEmployeeDirectory } from '@starlink/adapter-employee-directory';
import { LocalOtpIdentity } from '@starlink/adapter-customer-identity';
import { LocalObjectStorage, MockObjectStorage, S3ObjectStorage } from '@starlink/adapter-object-storage';
import { DevAttachmentScanner } from '@starlink/adapter-attachment-scanner';
import {
  EmailNotificationTransport,
  InAppNotificationTransport,
  SmtpEmailSender,
  type EmailSender,
} from '@starlink/adapter-notification-provider';
import type { AIProvider, NotificationTransport } from '@starlink/shared-contracts';
import {
  LocalWorkOrchestrator,
  MockWorkOrchestrator,
} from '@starlink/adapter-work-orchestrator';
import {
  PgAdminStore,
  PgAttachmentStore,
  PgAvailabilityReader,
  PgBusinessCalendarReader,
  PgCategoryReader,
  PgConversationReader,
  PgConversationStore,
  PgMessageReader,
  PgReactionStore,
  PgPinStore,
  PgMessageInfoStore,
  PgStatusStore,
  PgAvatarStore,
  PgHiddenMessageStore,
  PgMessageStore,
  PgNotificationOutbox,
  PgNotificationPreferences,
  PgNotificationRecipients,
  PgConversationAuthzReader,
  PgCustomerStore,
  PgReadStateStore,
  PgCaseStore,
  PgRoutingStore,
  PgTeamLoadReader,
  PgSearchProvider,
  PgSlaReader,
  createDatabase,
  databaseFromPool,
} from '@starlink/database';
import {
  ConversationListCursorCodec,
  CursorCodec,
  SessionService,
  verifyPassword,
} from '@starlink/security';
import { createLogger } from '@starlink/observability';
import { createRateLimiter } from '@starlink/search';
import type {
  EmployeeDirectoryProvider,
  IdentityAuthorizationClient,
  ObjectStorageProvider,
  UUID,
  WorkOrchestratorClient,
} from '@starlink/shared-contracts';
import { loadConfig, type ApiConfig } from './config.js';
import {
  ADMIN_STORE,
  ATTACHMENT_SCANNER,
  ATTACHMENT_STORE,
  AUDIT_WRITER,
  AUTHZ_READER,
  AVAILABILITY_READER,
  CALENDAR_READER,
  CATEGORY_ROUTING_CONFIG,
  CONFIG,
  CONVERSATION_READER,
  CATEGORY_READER,
  CONVERSATION_STORE,
  CONVERSATION_LIST_CURSOR_CODEC,
  CUSTOMER_IDENTITY,
  CUSTOMER_STORE,
  CURSOR_CODEC,
  DATABASE,
  EMPLOYEE_DIRECTORY,
  IDENTITY_CLIENT,
  LOGGER,
  MESSAGE_READER,
  REACTION_STORE,
  PIN_STORE,
  MESSAGE_INFO_STORE,
  STATUS_STORE,
  AVATAR_STORE,
  HIDDEN_MESSAGE_STORE,
  MESSAGE_STORE,
  NOTIFICATION_OUTBOX,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_RECIPIENTS,
  NOTIFICATION_TRANSPORTS,
  OBJECT_STORAGE,
  READ_STATE_STORE,
  SEARCH_PROVIDER,
  ROUTING_STORE,
  TEAM_LOAD_READER,
  CASE_STORE,
  AI_PROVIDER,
  SEARCH_RATE_LIMITER,
  SESSION_SERVICE,
  SLA_READER,
  WORK_ORCHESTRATOR,
} from './tokens.js';
import { AuditWriter } from './audit/audit-writer.js';
import { DisabledAIProvider } from '@starlink/ai-assist';
import { CorrelationMiddleware } from './edge/correlation.middleware.js';
import { SessionGuard } from './edge/session.guard.js';
import { EmployeeAuthController } from './employee/auth.controller.js';
import { EmployeeAdminController } from './employee/admin.controller.js';
import { EmployeeConversationsController } from './employee/conversations.controller.js';
import { EmployeeMessagesController } from './employee/messages.controller.js';
import { EmployeeDirectoryController } from './employee/directory.controller.js';
import { StatusController } from './employee/status.controller.js';
import { AvatarController } from './employee/avatar.controller.js';
import { EmployeeSearchController } from './employee/search.controller.js';
import { EmployeeRoutingController } from './employee/routing.controller.js';
import { EmployeeLifecycleController } from './employee/lifecycle.controller.js';
import { CustomerAuthController } from './customer/customer-auth.controller.js';
import { CustomerConversationsController } from './customer/customer-conversations.controller.js';
import { HealthController } from './health.controller.js';
import { SweepHost } from './sweeps.host.js';
import { NotificationService } from './notifications/notification-service.js';
import { NotificationRecipients } from './notifications/recipients.js';
import { ConversationNotifier } from './notifications/conversation-notifier.js';
import { NotificationAdminController } from './notifications/notification-admin.controller.js';
import { EmployeeNotificationsController } from './notifications/notifications.controller.js';
import { AttachmentService } from './attachments/attachment-service.js';
import {
  CustomerAttachmentsController,
  EmployeeAttachmentsController,
} from './attachments/attachments.controller.js';
import { DevUploadController } from './attachments/dev-upload.controller.js';
import { BusinessHours } from './routing/business-hours.js';
import {
  CategoryRoutingConfig,
  DEFAULT_FALLBACK,
} from './routing/category-routing-config.js';

const providers: Provider[] = [
  Reflector,
  { provide: CONFIG, useFactory: (): ApiConfig => loadConfig() },
  {
    provide: LOGGER,
    inject: [CONFIG],
    useFactory: (config: ApiConfig) => createLogger({ service: 'api', level: config.SL_LOG_LEVEL }),
  },
  {
    provide: DATABASE,
    inject: [CONFIG, LOGGER],
    useFactory: (config: ApiConfig, logger: ReturnType<typeof createLogger>) => {
      // Built through the database package so the §35.4 guard, TLS inference and
      // search_path handling stay in ONE place — an app that assembled its own pool
      // would be an app that could quietly skip them.
      return createDatabase({
        connectionString: config.SL_DATABASE_URL,
        maxConnections: config.SL_DB_MAX_CONNECTIONS,
        // Without this listener the pool's idle-client `'error'` event is an unhandled
        // EventEmitter error, which throws and takes the process down. See the comment
        // where it is registered: an idle connection dying is a routine event at every
        // managed provider, and the pool replaces it on the next checkout.
        onPoolError: (error) =>
          logger.error('database pool error on an idle connection', {
            operation: 'api.database',
            outcome: 'FAILED',
            errorCode: error.name,
          }),
      }).pool;
    },
  },
  {
    provide: IDENTITY_CLIENT,
    inject: [CONFIG, DATABASE],
    useFactory: (config: ApiConfig, pool: pg.Pool): IdentityAuthorizationClient => {
      switch (config.SL_ADAPTER_IAM) {
        case 'local':
          // Reuses the app's pool rather than opening a second one — a managed
          // provider counts connections, and a hidden extra pool is how a dev
          // environment quietly hits its connection ceiling.
          return new LocalIamAdapter({ db: databaseFromPool(pool), verifySecret: verifyPassword });
        case 'mock':
          return new MockIamAdapter();
        case 'remote':
          // Phase 9. Refusing loudly is better than silently falling back to the
          // interim store and calling it canonical.
          throw new Error('SL_ADAPTER_IAM=remote requires the Central IAM adapter (Phase 9)');
      }
    },
  },
  {
    provide: SESSION_SERVICE,
    inject: [CONFIG, IDENTITY_CLIENT, CUSTOMER_STORE],
    useFactory: (
      config: ApiConfig,
      identity: IdentityAuthorizationClient,
      customers: PgCustomerStore,
    ) =>
      new SessionService({
        secret: config.SL_SESSION_SECRET,
        identity,
        // This process serves customers, so it MUST supply the reader — without it every
        // customer session is refused. See the fail-closed branch in `session.ts`.
        customerSessions: customers,
        employeeTtlSeconds: config.SL_SESSION_TTL_SECONDS,
      }),
  },
  {
    provide: CURSOR_CODEC,
    inject: [CONFIG],
    // A different secret from the session key (doc §27.14).
    useFactory: (config: ApiConfig) => new CursorCodec(config.SL_CURSOR_SECRET),
  },
  {
    provide: CONVERSATION_LIST_CURSOR_CODEC,
    inject: [CONFIG],
    // Same secret, different PURPOSE string — so a message cursor cannot be presented
    // where a list cursor is expected, and vice versa.
    useFactory: (config: ApiConfig) => new ConversationListCursorCodec(config.SL_CURSOR_SECRET),
  },
  { provide: MESSAGE_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgMessageStore(pool) },
  { provide: MESSAGE_READER, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgMessageReader(pool) },
  { provide: REACTION_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgReactionStore(pool) },
  { provide: PIN_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgPinStore(pool) },
  { provide: MESSAGE_INFO_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgMessageInfoStore(pool) },
  { provide: STATUS_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgStatusStore(pool) },
  { provide: AVATAR_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgAvatarStore(pool) },
  { provide: HIDDEN_MESSAGE_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgHiddenMessageStore(pool) },
  {
    provide: CONVERSATION_STORE,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgConversationStore(pool),
  },
  {
    provide: CONVERSATION_READER,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgConversationReader(pool),
  },
  { provide: READ_STATE_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgReadStateStore(pool) },
  { provide: ADMIN_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgAdminStore(pool) },
  { provide: ROUTING_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgRoutingStore(pool) },
  {
    provide: TEAM_LOAD_READER,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgTeamLoadReader(pool),
  },
  { provide: CASE_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgCaseStore(pool) },
  {
    provide: AI_PROVIDER,
    inject: [CONFIG],
    /**
     * Part IV §68 gate 9: "human fallback works with AI entirely disabled."
     *
     * Registered even though nothing consumes it yet, and that is the point. The gate is
     * about the product running in this state, so the disabled provider is INSTALLED and
     * reported by `/readyz` rather than being a class somebody could choose. The first
     * caller to ask for AI therefore meets the refusal path by default rather than by
     * remembering to handle it.
     *
     * `remote` refuses to construct. Failing loudly beats starting with no AI while the
     * configuration claims otherwise — the same posture the Work Orchestrator takes for
     * its unbuilt remote mode.
     */
    useFactory: (config: ApiConfig): AIProvider => {
      if (config.SL_ADAPTER_AI === 'remote') {
        throw new Error(
          'SL_ADAPTER_AI=remote: no AI provider exists. N-05 (provider choice and the ' +
            'data-processing agreement) is unanswered — CTO and Legal/DPO.',
        );
      }
      return new DisabledAIProvider({ correlationId: () => crypto.randomUUID() });
    },
  },
  {
    provide: AUTHZ_READER,
    inject: [DATABASE],
    // The SAME reader the realtime gateway uses, so a subscribe and an HTTP action
    // cannot reach different conclusions about the same conversation (§38).
    useFactory: (pool: pg.Pool) => new PgConversationAuthzReader(pool),
  },
  {
    provide: EMPLOYEE_DIRECTORY,
    inject: [DATABASE],
    // Interim authority: every record it returns is stamped TEMPORARY_AUTHORITY until
    // HRMS becomes the source (§12, Phase 9).
    useFactory: (pool: pg.Pool) => new LocalEmployeeDirectory(pool),
  },
  { provide: SEARCH_PROVIDER, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgSearchProvider(pool) },
  { provide: CUSTOMER_STORE, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgCustomerStore(pool) },
  { provide: CATEGORY_READER, inject: [DATABASE], useFactory: (pool: pg.Pool) => new PgCategoryReader(pool) },
  {
    provide: CUSTOMER_IDENTITY,
    inject: [CONFIG, LOGGER],
    /**
     * Interim customer identity (ADR-019), replaced by CCS at Phase 10.
     *
     * The OTP sender is a LOG sink in dev, and that is stated rather than disguised: a
     * stub that pretended to send would make an unverified flow look verified. Nothing
     * here is the customer master — it authenticates a contact detail and returns
     * whatever reference the lookup gives, which is currently none.
     */
    useFactory: (config: ApiConfig, logger: ReturnType<typeof createLogger>) =>
      new LocalOtpIdentity({
        secret: config.SL_CURSOR_SECRET,
        sender: {
          async send(method, destination, code) {
            if (config.SL_ENV === 'production' || config.SL_ENV === 'staging') {
              // Refusing loudly beats silently logging a credential in production.
              throw new Error('no OTP transport configured; a real sender is required (Phase 8)');
            }
            logger.info('DEV OTP issued', {
              operation: 'customer.verification.send',
              outcome: 'SUCCEEDED',
              // Never the destination and never the code in a shared environment; the
              // code is printed only for local development.
              detail: { method },
            });
            // eslint-disable-next-line no-console
            console.log(`[dev-otp] ${method} -> ${destination}: ${code}`);
          },
        },
        lookup: {
          // No customer master exists yet (rule 11: never create a second one). Until
          // CCS is wired, no contact resolves to a customer, so verification yields
          // PSEUDONYMOUS — proven contact, unrecognised person. That is the honest
          // answer, and it is visibly different from VERIFIED_CUSTOMER.
          async byContact() {
            return null;
          },
        },
      }),
  },
  {
    provide: SEARCH_RATE_LIMITER,
    // In-process for V1, which doc §14.2 explicitly sanctions ("rate-limit counters
    // fit in process"). The trigger to move it to a shared store is the same one that
    // brings Redis in: the moment a second instance exists (§33.2).
    useFactory: () => createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
  },
  {
    provide: AUDIT_WRITER,
    inject: [DATABASE, LOGGER],
    useFactory: (pool: pg.Pool, logger: ReturnType<typeof createLogger>) => new AuditWriter(pool, logger),
  },
  {
    provide: CALENDAR_READER,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgBusinessCalendarReader(pool),
  },
  {
    provide: AVAILABILITY_READER,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgAvailabilityReader(pool),
  },
  {
    provide: NOTIFICATION_OUTBOX,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgNotificationOutbox(pool),
  },
  {
    provide: NOTIFICATION_TRANSPORTS,
    inject: [CONFIG, EMPLOYEE_DIRECTORY, LOGGER],
    /**
     * One transport per channel (§29.3). A channel absent from this map is not an error —
     * the worker leaves its rows queued rather than discarding them, which is what keeps
     * a notification for a not-yet-built channel recoverable once it exists.
     */
    useFactory: (
      config: ApiConfig,
      directory: EmployeeDirectoryProvider,
      logger: ReturnType<typeof createLogger>,
    ): ReadonlyMap<string, NotificationTransport> => {
      /**
       * The relay, or nothing at all.
       *
       * §36.4 left the provider unnamed — "Committing now would be inventing a business
       * answer, which the brief forbids" (§15.9) — and N-07 chose a corporate SMTP relay
       * on 2026-08-28. With no host configured there is deliberately NO sender, so the
       * transport refuses with `EMAIL_PROVIDER_NOT_CONFIGURED` and its rows queue. A stub
       * that reported DELIVERED would mark every row SENT and make the gap invisible.
       */
      const sender: EmailSender | undefined =
        config.SL_NOTIFY_EMAIL_HOST !== undefined && config.SL_NOTIFY_EMAIL_FROM !== undefined
          ? new SmtpEmailSender({
              host: config.SL_NOTIFY_EMAIL_HOST,
              port: config.SL_NOTIFY_EMAIL_PORT,
              secure: config.SL_NOTIFY_EMAIL_SECURE,
              from: config.SL_NOTIFY_EMAIL_FROM,
              ...(config.SL_NOTIFY_EMAIL_USER !== undefined
                ? { user: config.SL_NOTIFY_EMAIL_USER }
                : {}),
              ...(config.SL_NOTIFY_EMAIL_PASSWORD !== undefined
                ? { password: config.SL_NOTIFY_EMAIL_PASSWORD }
                : {}),
            })
          : undefined;

      /**
       * One entry per ENABLED channel (§35's `SL_NOTIFY_TRANSPORTS`, default `inapp`).
       *
       * The service already refuses to enqueue a disabled channel, so this map and that
       * filter say the same thing from two directions — deliberately. If a row for a
       * disabled channel ever does reach the worker (a replay of an old row, say), the
       * absent transport leaves it queued rather than discarding it.
       */
      const entries: Array<[string, NotificationTransport]> = [
        [
          'INAPP',
          new InAppNotificationTransport({
            /**
             * In-app delivery IS the outbox row reaching a SENT state — the client reads
             * its notifications from that table. There is nothing further to write, so
             * this records nothing and succeeds; the row's own transition is the delivery.
             */
            record: async () => undefined,
          }),
        ],
      ];

      const emailTransport: [string, NotificationTransport] = [
          'EMAIL',
          new EmailNotificationTransport({
            ...(sender !== undefined ? { sender } : {}),
            /**
             * §17.2's fifth operation, through the provider interface rather than a query.
             *
             * "Identity is consumed through a provider interface with five operations:
             * … resolve contact channels. V1 implements this against StarLink's own
             * store. When the HRMS arrives a second implementation satisfies the same
             * interface and no other component changes." Reading
             * `identity.principal_contacts` directly from here would work today and break
             * that promise at Phase 9.
             *
             * A principal with no contact row yields `undefined`, which the transport
             * turns into PERMANENT_FAILURE and a dead-lettered row — §29.6's "invalid
             * address … principal flagged for administrative attention". That is the
             * right surface for an unpopulated directory: visible, not silent.
             */
            addressFor: async (principalId) => {
              const contacts = await directory.resolveContactChannels(principalId as UUID);
              if (!contacts.ok) {
                logger.warn('contact channels unavailable', {
                  operation: 'notification.address',
                  outcome: 'FAILED',
                  errorCode: contacts.error.code,
                  detail: { principalId },
                });
                return undefined;
              }
              return contacts.value.email;
            },
          }),
      ];

      const enabled = new Set(config.SL_NOTIFY_TRANSPORTS);
      if (enabled.has('EMAIL')) entries.push(emailTransport);

      return new Map<string, NotificationTransport>(entries);
    },
  },
  {
    provide: NOTIFICATION_RECIPIENTS,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgNotificationRecipients(pool),
  },
  {
    provide: NOTIFICATION_PREFERENCES,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgNotificationPreferences(pool),
  },
  NotificationService,
  NotificationRecipients,
  ConversationNotifier,
  {
    provide: ATTACHMENT_STORE,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgAttachmentStore(pool),
  },
  {
    provide: OBJECT_STORAGE,
    inject: [CONFIG],
    /**
     * `local` and `mock` are DIFFERENT drivers, and conflating them broke the product.
     *
     * They were the same case in this switch, so `local` returned `MockObjectStorage`,
     * whose upload grant is `memory://upload/…` — a scheme no browser implements. The
     * client does exactly what ADR-012 prescribes and fetches the grant URL directly, so
     * an attachment could not be uploaded from any browser in any runnable configuration.
     *
     *   * `mock`  — in-memory, `memory://` URLs, no HTTP. For unit tests that never open a
     *              socket. Not a configuration to run a process on.
     *   * `local` — the development driver: real relative URLs served by the dev object
     *              endpoints, bytes still in memory. The default.
     *   * `remote` — the S3-compatible driver (N-03/A-20). Bucket and region are checked
     *              at config load, so by the time this runs they are present.
     */
    useFactory: (config: ApiConfig): ObjectStorageProvider => {
      switch (config.SL_ADAPTER_OBJECT_STORAGE) {
        case 'mock':
          return new MockObjectStorage();
        case 'local':
          return new LocalObjectStorage();
        case 'remote':
          return new S3ObjectStorage({
            bucket: config.SL_STORAGE_BUCKET!,
            region: config.SL_STORAGE_REGION!,
            ...(config.SL_STORAGE_ENDPOINT !== undefined
              ? { endpoint: config.SL_STORAGE_ENDPOINT }
              : {}),
          });
      }
    },
  },
  {
    provide: ATTACHMENT_SCANNER,
    inject: [OBJECT_STORAGE],
    /**
     * A DEV STUB. It sniffs content, verifies size and recognises EICAR, and it does not
     * detect malware — its health report says so, and §68 gate 5 should not pass on it.
     * The production scanner is N-06 and carries a recurring cost that D-07's answer
     * ("claims only") commits us to.
     */
    useFactory: (storage: ObjectStorageProvider) =>
      new DevAttachmentScanner({
        /**
         * Where the scanner gets its bytes.
         *
         * `ObjectStorageProvider` has no read method on purpose — the application never
         * streams file contents (ADR-012), so a general read would be an affordance
         * nothing should use. A real scanner reads the object itself, with its own
         * credentials; the mock exposes `readQuarantine` for dev, and this narrows to it
         * rather than casting so a driver without it fails to compile here instead of
         * returning undefined at runtime.
         */
        storage: {
          read: async (key) =>
            storage instanceof MockObjectStorage ? storage.readQuarantine(key) : undefined,
        },
      }),
  },
  AttachmentService,
  {
    provide: SLA_READER,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new PgSlaReader(pool),
  },
  {
    provide: CATEGORY_ROUTING_CONFIG,
    inject: [DATABASE],
    useFactory: (pool: pg.Pool) => new CategoryRoutingConfig(pool),
  },
  BusinessHours,
  {
    provide: WORK_ORCHESTRATOR,
    inject: [CONFIG, DATABASE, ROUTING_STORE, AVAILABILITY_READER, CATEGORY_ROUTING_CONFIG],
    /**
     * The Work Orchestrator (ADR-023, brief rule 11 — StarLink builds no second work
     * allocator; this is a stand-in behind the interface CCS will implement at Phase 10).
     *
     * Every business value the §21.8 tree needs is read from configuration here, and
     * every one of them is an open question — which is why they arrive as functions the
     * adapter calls rather than constants it holds. See `category-routing-config.ts`.
     */
    useFactory: (
      config: ApiConfig,
      pool: pg.Pool,
      routing: PgRoutingStore,
      availability: PgAvailabilityReader,
      categories: CategoryRoutingConfig,
    ): WorkOrchestratorClient => {
      switch (config.SL_ADAPTER_WORK_ORCHESTRATOR) {
        case 'mock':
          return new MockWorkOrchestrator();
        case 'remote':
          // Phase 10. Refusing loudly beats silently running the interim allocator and
          // reporting it as CCS.
          throw new Error(
            'SL_ADAPTER_WORK_ORCHESTRATOR=remote requires the CCS adapter (Phase 10)',
          );
        case 'local':
          return new LocalWorkOrchestrator({
            store: {
              enqueue: (input) => routing.enqueue(input as never),
              claimQueueEntry: (input) => routing.claimQueueEntry(input as never),
              assignFromRouting: (input) => routing.assignFromRouting(input as never),
              reserve: async (input) => {
                const expiresAt = new Date(
                  Date.parse(input.at) + input.ttlSeconds * 1000,
                ).toISOString();
                await pool.query(
                  `INSERT INTO conversation.reservations
                     (reservation_id, principal_id, ref_system, ref_type, ref_id, weight,
                      effective_from, expires_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                  [
                    input.reservationId,
                    input.principalId,
                    input.ref.system,
                    input.ref.type,
                    input.ref.id,
                    input.weight,
                    input.at,
                    expiresAt,
                  ],
                );
                return { reservationId: input.reservationId, expiresAt };
              },
              release: async (reservationId, reason, at) => {
                await pool.query(
                  `UPDATE conversation.reservations
                      SET released_at = $2, release_reason = $3
                    WHERE reservation_id = $1 AND released_at IS NULL`,
                  [reservationId, at, reason],
                );
              },
              queueMetrics: async (teamId, at) => {
                const rows = await routing.queueDepthByTeam(at as never);
                const mine = rows.filter((r) => r.teamId === teamId);
                return {
                  teamId,
                  depth: mine.reduce((n, r) => n + r.waiting, 0),
                  oldestWaitingSeconds: Math.max(0, ...mine.map((r) => r.oldestSeconds), 0),
                  byPriority: Object.fromEntries(mine.map((r) => [r.priority, r.waiting])),
                  byIntent: {},
                  // Not reported: it needs a per-person ceiling nobody has set (D-05),
                  // and a fabricated number would make an alert fire on fiction.
                  availableCapacityUnits: 0,
                };
              },
            },
            categoryRouting: (category) => categories.forCategory(category),
            reservationTtlSeconds: config.SL_RESERVATION_TTL_SECONDS,
            // Person-facts only. Whether the team is open is the adapter's to know —
            // it is the branch that got there — so it is not answerable from here.
            availabilityOf: async (principalId, at) => {
              const facts = await availability.factsFor(principalId, at as never);
              return {
                accountActive: facts.accountActive,
                onDeclaredAbsence: facts.onDeclaredAbsence,
                explicitlyUnavailable: facts.explicitlyUnavailable,
                ...(facts.capacity !== undefined ? { capacity: facts.capacity } : {}),
              };
            },
            fallbackPolicy: DEFAULT_FALLBACK,
          });
      }
    },
  },
  // Applied to every route. An operation that has not declared its surface is not
  // reachable — fail closed, the same posture as FR-AUTHZ-3.
  { provide: APP_GUARD, useClass: SessionGuard },
  // Starts on bootstrap and stops on shutdown. Before this, the sweeps existed and ran
  // nowhere — see `sweeps.host.ts`.
  SweepHost,
];

@Module({
  controllers: [
    HealthController,
    EmployeeAuthController,
    EmployeeAdminController,
    NotificationAdminController,
    EmployeeNotificationsController,
    EmployeeConversationsController,
    EmployeeMessagesController,
    EmployeeSearchController,
    EmployeeDirectoryController,
    StatusController,
    AvatarController,
    EmployeeRoutingController,
    EmployeeLifecycleController,
    EmployeeAttachmentsController,
    CustomerAuthController,
    CustomerConversationsController,
    CustomerAttachmentsController,
    // Dev-only, and it refuses to work outside SL_ENV=dev|test. Real uploads go direct
    // to object storage and never touch the API (ADR-012) — see the file header.
    DevUploadController,
  ],
  providers,
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
