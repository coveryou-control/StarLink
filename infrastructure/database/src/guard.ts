/**
 * Startup guards (doc §35.3, §35.4 — ARCHITECTURAL REQUIREMENT per §37.6).
 *
 * Doc §35.4: "the application refuses to open any database whose name does not begin
 * starlink_. That single check is what makes 'it cannot reach another product's data'
 * a property rather than a promise."
 *
 * ADR-001 changed the engine to PostgreSQL, and D-1 (approved with ADR-001) maps the
 * document's three databases onto three SCHEMAS in one database — because PostgreSQL
 * cannot commit a transaction across two databases, and both the transactional outbox
 * and FR-AUD-5 ("audit write failure fails the action") require exactly that.
 *
 * The requirement is therefore honoured in two parts rather than one:
 *   1. the DATABASE must sit in the starlink namespace (the original check), and
 *   2. only the three DECLARED SCHEMAS may be opened (the D-1 analogue of the
 *      original "three databases and no others").
 *
 * Together these preserve the property the document was protecting: StarLink cannot
 * reach another product's data, and cannot quietly acquire a fourth data area.
 *
 * Everything here runs BEFORE the first connection is opened. A misconfigured
 * production system that starts is worse than one that refuses (doc §35.3).
 */

/** The only schemas StarLink may open. Adding one is an architectural decision. */
export const ALLOWED_SCHEMAS = Object.freeze(['identity', 'conversation', 'audit'] as const);
export type AllowedSchema = (typeof ALLOWED_SCHEMAS)[number];

/**
 * `starlink` or `starlink_<suffix>`.
 *
 * The document's literal wording is "does not begin starlink_", written when the
 * design had three separate databases. Under D-1 there is one database holding the
 * three schemas, and the bare name `starlink` is the namespace root — so both forms
 * are accepted and nothing outside the namespace is.
 */
const DATABASE_NAME_PATTERN = /^starlink(_[a-z0-9_]+)?$/;

/**
 * A database somewhere other than this machine.
 *
 * The signal that a process is not a laptop, taken from a fact rather than from a
 * declaration. `SL_DATABASE_URL` has to be right for the process to work at all, so it
 * cannot be quietly wrong the way `SL_ENV` can — which is the whole point: see
 * `validateStartupConfiguration` for what was relying on `SL_ENV` alone and why that was
 * not safe.
 *
 * Deliberately NOT `requiresTls` from `client.ts`, though it looks like the same
 * question. That one honours `sslmode=disable`, because a caller may have a considered
 * reason to skip TLS; this one must not be switchable off by a query parameter, or the
 * escape hatch is one URL edit wide.
 *
 * An unparseable URL counts as remote. It will fail moments later anyway, and the safe
 * reading of "I cannot tell where this database is" is not "it is on your laptop".
 */
export function isRemoteDatabase(connectionUrl: string | undefined): boolean {
  if (connectionUrl === undefined || connectionUrl === '') return false;
  try {
    /* `URL.hostname` keeps the brackets on an IPv6 literal — `[::1]`, not `::1` — so a
       bare `'::1'` in the list below never matches and IPv6 loopback reads as remote.
       `requiresTls` in `client.ts` compares against the same unbracketed list and has
       the same blind spot; there it means demanding TLS of a local socket. */
    const host = new URL(connectionUrl).hostname.replace(/^\[|\]$/g, '');
    return !['localhost', '127.0.0.1', '::1', ''].includes(host);
  } catch {
    return true;
  }
}

/** Development defaults shipped in .env.example. Production must never start on one. */
const SHIPPED_DEV_SECRETS: readonly string[] = Object.freeze([
  'dev-only-session-secret-change-me-32chars',
  'dev-only-cursor-secret-change-me-32chars',
  'starlink_dev_only',
  'changeme',
]);

const MINIMUM_SECRET_LENGTH = 32;

export class ConfigurationRefusedError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`StarLink refused to start:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigurationRefusedError';
  }
}

/**
 * Extracts the database name from a PostgreSQL connection URL.
 *
 * Returns null rather than throwing on an unparseable URL: the caller reports it as
 * one problem among all the others, because an operator should not have to fix one
 * setting per restart (doc §35.3).
 */
export function parseDatabaseName(connectionUrl: string): string | null {
  try {
    const url = new URL(connectionUrl);
    const name = url.pathname.replace(/^\//, '');
    return name === '' ? null : decodeURIComponent(name);
  } catch {
    return null;
  }
}

export function isDatabaseNameAllowed(databaseName: string): boolean {
  return DATABASE_NAME_PATTERN.test(databaseName);
}

export function isSchemaAllowed(schema: string): schema is AllowedSchema {
  return (ALLOWED_SCHEMAS as readonly string[]).includes(schema);
}

/**
 * Refuses to open a database outside the StarLink namespace.
 *
 * Call this before creating a pool, not after — the point is that the connection is
 * never made, so a misdirected StarLink can never read another product's rows.
 */
export function assertDatabaseAllowed(connectionUrl: string): void {
  const name = parseDatabaseName(connectionUrl);
  if (name === null) {
    throw new ConfigurationRefusedError(['SL_DATABASE_URL is not a valid connection URL with a database name']);
  }
  if (!isDatabaseNameAllowed(name)) {
    throw new ConfigurationRefusedError([
      `refusing to open database "${name}": StarLink may only open databases in the starlink namespace (§35.4)`,
    ]);
  }
}

export function assertSchemaAllowed(schema: string): void {
  if (!isSchemaAllowed(schema)) {
    throw new ConfigurationRefusedError([
      `refusing to open schema "${schema}": StarLink owns only ${ALLOWED_SCHEMAS.join(', ')} (§35.4, D-1)`,
    ]);
  }
}

export interface StartupEnvironment {
  readonly SL_ENV?: string | undefined;
  readonly SL_DATABASE_URL?: string | undefined;
  readonly SL_SESSION_SECRET?: string | undefined;
  readonly SL_CURSOR_SECRET?: string | undefined;
}

/**
 * Whether the secret rules apply — the safety question, asked without trusting `SL_ENV`.
 *
 * ## What this replaced, and why
 *
 * It was `SL_ENV === 'production'`, exactly. Two consequences, both found by review
 * rather than by anything failing:
 *
 *   * **`staging` was exempt.** A staging deployment accepted
 *     `dev-only-session-secret-change-me-32chars` — and the session cookie is an HMAC
 *     over `{principalId, kind, surface, sessionVersion, expiresAt}` with that secret, so
 *     anyone holding the repository could mint a valid cookie for any employee. The
 *     realtime gateway is the process that verifies those cookies for sockets, and it
 *     calls this function; nothing else there would have caught it.
 *   * **`dev` is the escape hatch that gets used.** There is currently no `SL_ENV` value
 *     that both boots and is production-safe (the object-storage and IAM adapters refuse
 *     `staging`/`production`). So the failure mode is not hypothetical: an operator whose
 *     process exits on `production` sets `dev`, sees a healthy boot, and ships.
 *
 * So the rules now apply unless the environment is EXPLICITLY dev or test — deny by
 * default, rule 4's posture — and additionally whenever the database is not on this
 * machine, whatever `SL_ENV` says. A process talking to a remote database is not a
 * laptop, and that is a fact about the deployment rather than a claim about it.
 *
 * ## The cost, stated
 *
 * A developer using the Neon dev database (CLAUDE.md, "Running the database") must set
 * their own two secrets instead of the shipped ones. That is a one-line change to `.env`
 * and it is correct: a shared remote dev database reachable by the whole team is exactly
 * where a shipped HMAC secret lets any of them forge any other's session. The refusal
 * message says so and says what to do.
 */
export function secretRulesApply(env: StartupEnvironment): boolean {
  const declared = (env.SL_ENV ?? 'dev').toLowerCase();
  if (declared !== 'dev' && declared !== 'test') return true;
  return isRemoteDatabase(env.SL_DATABASE_URL);
}

/**
 * Validates startup configuration, reporting EVERY problem at once.
 *
 * A deployed environment additionally refuses a shipped development secret, a secret
 * below the minimum length, and a database outside the namespace (doc §35.3). What
 * counts as deployed is `secretRulesApply` above, which does not take `SL_ENV`'s word
 * for it.
 */
export function validateStartupConfiguration(env: StartupEnvironment): void {
  const problems: string[] = [];
  const deployed = secretRulesApply(env);

  const databaseUrl = env.SL_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    problems.push('SL_DATABASE_URL is not set');
  } else {
    const name = parseDatabaseName(databaseUrl);
    if (name === null) {
      problems.push('SL_DATABASE_URL is not a valid connection URL with a database name');
    } else if (!isDatabaseNameAllowed(name)) {
      problems.push(`SL_DATABASE_URL points at "${name}", which is outside the starlink namespace (§35.4)`);
    }
  }

  // Distinct secrets per purpose, so one compromise is not both (doc §27.14).
  for (const key of ['SL_SESSION_SECRET', 'SL_CURSOR_SECRET'] as const) {
    const value = env[key];
    if (value === undefined || value === '') {
      problems.push(`${key} is not set`);
      continue;
    }
    if (!deployed) continue;
    if (SHIPPED_DEV_SECRETS.includes(value)) {
      problems.push(
        `${key} is a shipped development default and must not be used outside a local ` +
          `development database. Generate one with \`openssl rand -base64 36\` and set it ` +
          `in this environment.`,
      );
    }
    if (value.length < MINIMUM_SECRET_LENGTH) {
      problems.push(`${key} is shorter than the ${MINIMUM_SECRET_LENGTH}-character minimum`);
    }
  }

  if (
    deployed &&
    env.SL_SESSION_SECRET !== undefined &&
    env.SL_SESSION_SECRET === env.SL_CURSOR_SECRET
  ) {
    problems.push('SL_SESSION_SECRET and SL_CURSOR_SECRET must differ so one compromise is not both (§27.14)');
  }

  if (problems.length > 0) throw new ConfigurationRefusedError(problems);
}
