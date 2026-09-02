/**
 * Configuration (ADR-017, doc §35).
 *
 * One prefix, `SL_`, and no fallback to any other product's variables. Validated once
 * at boot with EVERY problem reported together — an operator should not fix one
 * setting per restart (doc §35.3) — and production refuses to start rather than come
 * up misconfigured.
 */
import { z } from 'zod';
import { validateStartupConfiguration } from '@starlink/database';

const adapterMode = z.enum(['mock', 'local', 'remote']);

const schema = z.object({
  SL_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
  SL_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SL_API_PORT: z.coerce.number().int().positive().default(3000),

  SL_DATABASE_URL: z.string().min(1),
  SL_SESSION_SECRET: z.string().min(32),
  SL_CURSOR_SECRET: z.string().min(32),

  SL_WEB_EMPLOYEE_ORIGIN: z.string().url().default('http://localhost:3010'),
  SL_WEB_CUSTOMER_ORIGIN: z.string().url().default('http://localhost:3020'),

  SL_ADAPTER_IAM: adapterMode.default('local'),
  /**
   * Which work allocator is installed (ADR-023, brief rule 11).
   *
   * **The default is `local` and must stay durable.** It was `mock` until 2026-08-30, and
   * that one word meant the shipped default configuration accepted every customer
   * conversation, returned `ok`, and enqueued it into an in-memory `Map` inside
   * `MockWorkOrchestrator` — while the queue every agent reads is PostgreSQL. The routing
   * sweep counted the placement as `acted`, logged nothing, and no agent ever saw the
   * conversation. Nothing caught it because every integration test and `playwright.config.ts`
   * set this to `local` explicitly: the configuration that was tested and the configuration
   * that shipped were not the same configuration.
   *
   * The general rule that follows, and the reason this comment is long: a default must be a
   * value something actually runs against. `config.default-adapters.test.ts` now asserts
   * that for every adapter here.
   */
  SL_ADAPTER_WORK_ORCHESTRATOR: adapterMode.default('local'),
  SL_ADAPTER_CONSENT: adapterMode.default('mock'),
  /**
   * Which object-storage driver is installed (ADR-012).
   *
   * `local` by the same rule as the work orchestrator above: a default must be a value
   * something runs against. It was `mock`, whose upload grant is `memory://…` — a scheme
   * no browser implements — so on the shipped default an attachment could not be uploaded
   * from either surface, in any configuration. `local` serves real URLs from the dev
   * object endpoints; `mock` remains for unit tests that never open a socket.
   */
  SL_ADAPTER_OBJECT_STORAGE: adapterMode.default('local'),
  /**
   * S3 settings. Required only when `SL_ADAPTER_OBJECT_STORAGE=remote`, checked below.
   *
   * No credentials here, deliberately: the AWS SDK resolves them from the environment or
   * an instance role, which is what allows a deployment to hold no long-lived secret at
   * all. Threading them through application config would take that option away.
   *
   * `SL_STORAGE_ENDPOINT` is what makes this S3-COMPATIBLE rather than AWS-only — set it
   * to a MinIO URL for staging and leave it unset for AWS.
   */
  SL_STORAGE_BUCKET: z.string().min(1).optional(),
  SL_STORAGE_REGION: z.string().min(1).optional(),
  SL_STORAGE_ENDPOINT: z.string().url().optional(),
  SL_ADAPTER_EVENT_BUS: adapterMode.default('mock'),
  /**
   * Which AI provider is installed (INTEGRATION_CONTRACTS §11, Part IV §57).
   *
   * **`disabled` is the default and today the only supported value.** N-05 — provider
   * choice and the data-processing agreement for redacted-transcript processing — is
   * unanswered by the CTO and Legal/DPO, so there is nothing StarLink may legitimately
   * call.
   *
   * It is a setting rather than an absence because Part IV §68 gate 9 is "human fallback
   * works with AI entirely disabled", and a gate is only evidenced if the disabled state
   * is a real configuration the product runs under and reports. `/readyz` shows it.
   */
  SL_ADAPTER_AI: z.enum(['disabled', 'remote']).default('disabled'),

  SL_DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),

  // Housekeeping cadence, not a business value. How OFTEN we look for stranded work is
  // an operational choice; the target for what we find (zero) is §32.3 and not tunable.
  SL_SWEEP_INACTIVE_OWNER_SECONDS: z.coerce.number().int().positive().default(300),
  // Shorter, because a leaked hold consumes an agent's capacity the whole time it lives
  // and the reservation TTL itself is measured in a couple of minutes.
  SL_SWEEP_RESERVATION_SECONDS: z.coerce.number().int().positive().default(30),
  // Scrape-facing gauges. Shorter than a Prometheus scrape interval, so a poll never
  // reads a value older than the poll before it.
  SL_QUEUE_METRICS_SECONDS: z.coerce.number().int().positive().default(15),
  // How often unplaced conversations are looked for. Also the granularity at which an
  // after-hours conversation is picked up once the calendar opens (§23.3), so it is the
  // worst-case delay of the opening surge — not a promise to anyone, but visible to a
  // customer as the gap before anybody could have seen their message.
  SL_SWEEP_ROUTING_SECONDS: z.coerce.number().int().positive().default(20),
  // Mirrors `capacity_policies.reservation_ttl_sec`'s schema default. An operational
  // number (how long a placement hold survives a crash), not a staffing one — and see
  // N-17: nothing yet releases a hold when the work ends, so this is also, today, how
  // long a ceiling holds.
  SL_RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  // How often SLA clocks are evaluated. Not a promise to anyone — the clock is computed
  // on read, so this bounds only how late a WARNING or BREACH notification can be.
  SL_SWEEP_SLA_SECONDS: z.coerce.number().int().positive().default(60),
  SL_SWEEP_REOPEN_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * The reopen window (D-08). Section 44.3 proposes seven days and says plainly that
   * "7 days is arbitrary until the business gives a service standard", so this is
   * configuration carrying the document's own proposal rather than a number chosen here.
   */
  SL_REOPEN_WINDOW_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),

  /**
   * How long an upload grant survives unbound before the expiry sweep collects it
   * (§28.6). An operational number: long enough for a person to pick a file and for the
   * scan to finish, short enough that abandoned uploads do not accumulate.
   */
  SL_ATTACHMENT_UNBOUND_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /**
   * Download-grant lifetime. Short by design — ADR-012 permits a signed URL only if it is
   * "short-lived, scoped to one object, issued only after steps 1–5 have all passed".
   * A long-lived URL is a bearer token that can be forwarded, which is §28.4's objection.
   */
  SL_ATTACHMENT_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  SL_SWEEP_ATTACHMENT_SCAN_SECONDS: z.coerce.number().int().positive().default(10),
  SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * §29.5's "short window" for deduplicating (recipient, event, target).
   *
   * Operational, not a business value: it trades a rare duplicate against a suppressed
   * repeat. Five minutes is short enough that a genuinely new event an hour later still
   * notifies, and long enough to absorb a burst.
   */
  SL_NOTIFICATION_DEDUPE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * How often to probe the message-page query plan (§32.4's "documents-examined ratio").
   *
   * Deliberately the slowest sweep in the system. It runs EXPLAIN ANALYZE, so it is the
   * only one that does real query work purely to observe, and the thing it watches for --
   * a dropped or unused index -- changes at deployment time, not minute to minute. Five
   * minutes detects a lost index well inside any reasonable response window while costing
   * one indexed page read per tick.
   */
  SL_SWEEP_INDEX_HEALTH_SECONDS: z.coerce.number().int().positive().default(300),
  SL_SWEEP_NOTIFICATION_SECONDS: z.coerce.number().int().positive().default(15),
  /** §29.6: "not retried forever". After this many failures a row is dead-lettered. */
  SL_NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  /**
   * SMTP relay for employee notification (§35's `SL_NOTIFY_EMAIL_*`, A-21, N-07).
   *
   * The document names this prefix and leaves its value as "—"; N-07 chose a corporate
   * SMTP relay on 2026-08-28. Every field is optional, and the HOST is the switch: with
   * no host no sender is constructed, and `EmailNotificationTransport` refuses with
   * `EMAIL_PROVIDER_NOT_CONFIGURED` exactly as it does today. That refusal is the
   * designed behaviour (§29.6), not a gap — rows queue and drain on recovery rather than
   * being reported as sent.
   */
  /**
   * Which notification adapters are enabled (§35's `SL_NOTIFY_TRANSPORTS`, §29.3).
   *
   * The document gives this setting a default of **`inapp`**, and A-21 says why: "an email
   * transport is available for employee notification — if wrong: **V1-A ships with in-app
   * notification only**." So in-app alone is the sanctioned baseline and email is switched
   * on when a relay exists, rather than being attempted and failing.
   *
   * This is load-bearing, not cosmetic. Before it, an EMAIL row was written for every
   * "in-app + external" event with no provider to deliver it — the rows accumulated as
   * RETRYING forever, `starlink_notification_outbox_depth` never returned to zero, and
   * `NotificationBacklogNotDraining` was permanently red. An alert that is always red is an
   * alert people learn to ignore, which is the failure §32.4 exists to prevent.
   */
  SL_NOTIFY_TRANSPORTS: z
    .string()
    .default('inapp')
    .transform((raw) =>
      raw
        .split(',')
        .map((name) => name.trim().toUpperCase())
        .filter((name) => name.length > 0),
    ),
  SL_NOTIFY_EMAIL_HOST: z.string().min(1).optional(),
  SL_NOTIFY_EMAIL_PORT: z.coerce.number().int().positive().max(65535).default(587),
  /** Implicit TLS (465). Left false for the usual STARTTLS-on-587 relay. */
  SL_NOTIFY_EMAIL_SECURE: z.coerce.boolean().default(false),
  SL_NOTIFY_EMAIL_USER: z.string().min(1).optional(),
  SL_NOTIFY_EMAIL_PASSWORD: z.string().min(1).optional(),
  /** Envelope sender. A relay will refuse a domain it does not own. */
  SL_NOTIFY_EMAIL_FROM: z.string().email().optional(),
  SL_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(12 * 60 * 60),
});

export type ApiConfig = z.infer<typeof schema> & { readonly tls: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`StarLink API refused to start:\n  - ${problems.join('\n  - ')}`);
  }

  // The database guard and the production secret rules live in one place so the API,
  // the workers and the realtime gateway cannot drift on them (§35.3, §35.4).
  validateStartupConfiguration({
    SL_ENV: parsed.data.SL_ENV,
    SL_DATABASE_URL: parsed.data.SL_DATABASE_URL,
    SL_SESSION_SECRET: parsed.data.SL_SESSION_SECRET,
    SL_CURSOR_SECRET: parsed.data.SL_CURSOR_SECRET,
  });

  /**
   * Settings that describe a choice nobody can make yet.
   *
   * `SL_ADAPTER_CONSENT` and `SL_ADAPTER_EVENT_BUS` are declared but read by nothing —
   * no consent adapter and no event-bus client are constructed anywhere, because both
   * wait on an external decision (N-05 for consent, N-01/N-12 for the CY Brain bus). An
   * operator who set either to `local` or `remote` got the mock and no indication of it,
   * which is the failure §35.3 exists to prevent: a misconfigured system that starts.
   *
   * Refusing is the same posture `SL_ADAPTER_IAM=remote` already takes, and the setting
   * stays declared so the day the adapter lands there is one obvious place to wire it.
   */
  for (const [name, value] of [
    ['SL_ADAPTER_CONSENT', parsed.data.SL_ADAPTER_CONSENT],
    ['SL_ADAPTER_EVENT_BUS', parsed.data.SL_ADAPTER_EVENT_BUS],
  ] as const) {
    if (value !== 'mock') {
      throw new Error(
        `StarLink API refused to start:\n  - ${name}=${value} selects an adapter that does ` +
          'not exist. Only "mock" is implemented; the real one is blocked on an external ' +
          'decision (see STARLINK_OPEN_QUESTIONS.md).',
      );
    }
  }

  /**
   * A DEVELOPMENT driver may not be the storage of a deployed environment.
   *
   * `SL_ADAPTER_OBJECT_STORAGE=local` selects `LocalObjectStorage`, whose upload grants
   * point at `/v1/dev/objects/...` — endpoints `DevUploadController` refuses whenever
   * `SL_ENV` is not `dev` or `test`. So on staging or production the previous behaviour was:
   * the process starts, grants are issued, every upload is refused, and bytes live in
   * process memory until the next restart. Nothing said so.
   *
   * That is the first council's central finding wearing different clothes — a default that
   * works only in the environment it is tested in — and the honest response is to fail at
   * boot rather than at the first customer who attaches a document. `remote` already throws
   * in the DI (Phase 12, N-03/A-20), so today there is no value of this setting that works
   * in a deployment. **That is a real blocker and this refusal makes it a loud one.**
   */
  /**
   * `remote` needs a bucket and a region, and says so by name.
   *
   * Failing here rather than at first upload: a process that starts and then cannot store
   * anything is strictly worse than one that refuses to start, because the first failure
   * lands on a customer's attachment rather than on the operator's terminal.
   */
  if (parsed.data.SL_ADAPTER_OBJECT_STORAGE === 'remote') {
    const missing = (['SL_STORAGE_BUCKET', 'SL_STORAGE_REGION'] as const).filter(
      (name) => parsed.data[name] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(
        `StarLink API refused to start:
  - SL_ADAPTER_OBJECT_STORAGE=remote requires ` +
          `${missing.join(' and ')}. Set an S3 bucket and region; credentials come from ` +
          `the environment or the instance role, never from configuration.`,
      );
    }
  }

  if (
    parsed.data.SL_ADAPTER_OBJECT_STORAGE !== 'remote' &&
    (parsed.data.SL_ENV === 'staging' || parsed.data.SL_ENV === 'production')
  ) {
    throw new Error(
      `StarLink API refused to start:\n  - SL_ADAPTER_OBJECT_STORAGE=` +
        `${parsed.data.SL_ADAPTER_OBJECT_STORAGE} is a development driver. Its upload URLs are ` +
        `served by endpoints that refuse outside SL_ENV=dev|test, so every attachment upload ` +
        `would fail silently. A deployed environment needs the S3-compatible driver ` +
        `(N-03/A-20), which does not exist yet.`,
    );
  }

  return { ...parsed.data, tls: parsed.data.SL_ENV === 'production' || parsed.data.SL_ENV === 'staging' };
}
