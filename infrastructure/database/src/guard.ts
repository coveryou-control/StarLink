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
 * Validates startup configuration, reporting EVERY problem at once.
 *
 * Production additionally refuses a shipped development secret, a secret below the
 * minimum length, and a database outside the namespace (doc §35.3).
 */
export function validateStartupConfiguration(env: StartupEnvironment): void {
  const problems: string[] = [];
  const isProduction = (env.SL_ENV ?? 'dev').toLowerCase() === 'production';

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
    if (!isProduction) continue;
    if (SHIPPED_DEV_SECRETS.includes(value)) {
      problems.push(`${key} is a shipped development default and must not be used in production`);
    }
    if (value.length < MINIMUM_SECRET_LENGTH) {
      problems.push(`${key} is shorter than the ${MINIMUM_SECRET_LENGTH}-character minimum`);
    }
  }

  if (
    isProduction &&
    env.SL_SESSION_SECRET !== undefined &&
    env.SL_SESSION_SECRET === env.SL_CURSOR_SECRET
  ) {
    problems.push('SL_SESSION_SECRET and SL_CURSOR_SECRET must differ so one compromise is not both (§27.14)');
  }

  if (problems.length > 0) throw new ConfigurationRefusedError(problems);
}
