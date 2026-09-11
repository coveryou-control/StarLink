/**
 * F-1: the namespace guard, tested.
 *
 * Doc §35.4 calls this "what makes 'it cannot reach another product's data' a property
 * rather than a promise". A promise nobody tested is still a promise, so these cases
 * exist to make it a property.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SCHEMAS,
  ConfigurationRefusedError,
  assertDatabaseAllowed,
  assertSchemaAllowed,
  isDatabaseNameAllowed,
  isRemoteDatabase,
  parseDatabaseName,
  secretRulesApply,
  validateStartupConfiguration,
} from './guard.js';

const url = (database: string): string => `postgres://user:pw@localhost:5432/${database}`;

describe('database namespace guard (§35.4)', () => {
  it('accepts the starlink namespace root and its suffixed forms', () => {
    for (const name of ['starlink', 'starlink_core', 'starlink_chat', 'starlink_audit', 'starlink_test_1']) {
      expect(isDatabaseNameAllowed(name), name).toBe(true);
    }
  });

  it('refuses another product\'s database', () => {
    // The exact scenario the requirement exists for: a misconfigured StarLink
    // pointed at a peer application's data.
    for (const name of ['northstar', 'northstar_chat', 'ccs_pro', 'postgres', 'template1', 'app']) {
      expect(isDatabaseNameAllowed(name), name).toBe(false);
      expect(() => assertDatabaseAllowed(url(name))).toThrow(ConfigurationRefusedError);
    }
  });

  it('refuses a name that merely contains "starlink" rather than beginning with it', () => {
    // `notstarlink` and `northstar_link` must not sneak through a substring check.
    for (const name of ['notstarlink', 'my_starlink', 'northstar_link', 'starlinkx']) {
      expect(isDatabaseNameAllowed(name), name).toBe(false);
    }
  });

  it('refuses a connection URL with no database name', () => {
    expect(() => assertDatabaseAllowed('postgres://user:pw@localhost:5432/')).toThrow(ConfigurationRefusedError);
    expect(() => assertDatabaseAllowed('not-a-url')).toThrow(ConfigurationRefusedError);
  });

  it('parses the database name out of a realistic URL', () => {
    expect(parseDatabaseName('postgres://starlink:pw@db.internal:5432/starlink?sslmode=require')).toBe('starlink');
  });
});

describe('schema allow-list (D-1 analogue of "three databases")', () => {
  it('permits exactly the three declared schemas', () => {
    expect([...ALLOWED_SCHEMAS]).toEqual(['identity', 'conversation', 'audit']);
    for (const schema of ALLOWED_SCHEMAS) {
      expect(() => assertSchemaAllowed(schema)).not.toThrow();
    }
  });

  it('refuses a fourth data area acquired by accident', () => {
    for (const schema of ['public', 'northstar', 'reporting', 'staging']) {
      expect(() => assertSchemaAllowed(schema), schema).toThrow(ConfigurationRefusedError);
    }
  });
});

describe('startup configuration validation (§35.3)', () => {
  const validDev = {
    SL_ENV: 'dev',
    SL_DATABASE_URL: url('starlink'),
    SL_SESSION_SECRET: 'dev-only-session-secret-change-me-32chars',
    SL_CURSOR_SECRET: 'dev-only-cursor-secret-change-me-32chars',
  };

  it('accepts development defaults in development', () => {
    // A clean checkout must start (doc §15.11), so dev tolerates the shipped values.
    expect(() => validateStartupConfiguration(validDev)).not.toThrow();
  });

  it('refuses a shipped development secret on STAGING, which used to be exempt', () => {
    /**
     * The gap this closes. The check was `SL_ENV === 'production'` exactly, so a staging
     * deployment accepted `dev-only-session-secret-change-me-32chars`. The session cookie
     * is an HMAC over the principal with that secret, so anybody holding the repository
     * could mint a valid cookie for any employee — and the realtime gateway, which is
     * what verifies those cookies for sockets, has no environment refusal of its own and
     * relies entirely on this function.
     */
    expect(() => validateStartupConfiguration({ ...validDev, SL_ENV: 'staging' })).toThrow(
      ConfigurationRefusedError,
    );
  });

  it('refuses a shipped secret against a REMOTE database even when SL_ENV says dev', () => {
    /**
     * The other half, and the one that matters most in practice. No `SL_ENV` value
     * currently both boots and is production-safe, so "set it to dev and see it start"
     * is the likely response to a failing deployment rather than an unlikely one. The
     * database host is a fact about where this process is; `SL_ENV` is a claim.
     */
    expect(() =>
      validateStartupConfiguration({
        ...validDev,
        SL_DATABASE_URL: 'postgres://user:pw@ep-cool-name.ap-south-1.aws.neon.tech:5432/starlink',
      }),
    ).toThrow(/shipped development default/);
  });

  it('still accepts the shipped defaults against a LOCAL database in dev', () => {
    // The workflow that must not break: a clean checkout against local Postgres starts
    // (§15.11). Both signals have to say "laptop" for the rules to stay off.
    /* `[::1]` bracketed, because that is the only form `new URL` accepts for an IPv6
       literal — and the form whose `hostname` keeps the brackets, which is what made the
       first version of this check call local IPv6 remote. */
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() =>
        validateStartupConfiguration({
          ...validDev,
          SL_DATABASE_URL: `postgres://user:pw@${host}:5432/starlink`,
        }),
      ).not.toThrow();
    }
  });

  it('cannot be talked out of the remote verdict with sslmode=disable', () => {
    // `requiresTls` in client.ts honours that parameter because a caller may have a
    // considered reason to skip TLS. This must not, or the exemption is one URL edit wide.
    expect(isRemoteDatabase('postgres://u:p@db.example.com:5432/starlink?sslmode=disable')).toBe(true);
  });

  it('treats an unreadable database URL as remote', () => {
    // "I cannot tell where this database is" does not safely read as "on your laptop".
    expect(isRemoteDatabase('not a url at all')).toBe(true);
  });

  it('agrees with itself about what counts as deployed', () => {
    // `config.ts` uses `secretRulesApply` for the Secure cookie flag and this function
    // uses it for the secret ban. One predicate, so the two cannot drift into
    // disagreeing about whether this is a deployment.
    expect(secretRulesApply({ SL_ENV: 'dev', SL_DATABASE_URL: url('starlink') })).toBe(false);
    expect(secretRulesApply({ SL_ENV: 'test', SL_DATABASE_URL: url('starlink') })).toBe(false);
    expect(secretRulesApply({ SL_ENV: 'staging', SL_DATABASE_URL: url('starlink') })).toBe(true);
    expect(secretRulesApply({ SL_ENV: 'production', SL_DATABASE_URL: url('starlink') })).toBe(true);
    expect(
      secretRulesApply({ SL_ENV: 'dev', SL_DATABASE_URL: 'postgres://u:p@db.example.com/starlink' }),
    ).toBe(true);
  });

  it('refuses a shipped development secret in production', () => {
    expect(() => validateStartupConfiguration({ ...validDev, SL_ENV: 'production' })).toThrow(
      ConfigurationRefusedError,
    );
  });

  it('refuses a production secret below the minimum length', () => {
    expect(() =>
      validateStartupConfiguration({
        SL_ENV: 'production',
        SL_DATABASE_URL: url('starlink'),
        SL_SESSION_SECRET: 'too-short',
        SL_CURSOR_SECRET: 'x'.repeat(40),
      }),
    ).toThrow(ConfigurationRefusedError);
  });

  it('refuses production reusing one secret for both purposes', () => {
    // Session signing and cursor signing are separate keys so one compromise is not
    // both (doc §27.14).
    const shared = 'a'.repeat(40);
    expect(() =>
      validateStartupConfiguration({
        SL_ENV: 'production',
        SL_DATABASE_URL: url('starlink'),
        SL_SESSION_SECRET: shared,
        SL_CURSOR_SECRET: shared,
      }),
    ).toThrow(/must differ/);
  });

  it('refuses a production database outside the namespace even with good secrets', () => {
    expect(() =>
      validateStartupConfiguration({
        SL_ENV: 'production',
        SL_DATABASE_URL: url('northstar'),
        SL_SESSION_SECRET: 'a'.repeat(40),
        SL_CURSOR_SECRET: 'b'.repeat(40),
      }),
    ).toThrow(/outside the starlink namespace/);
  });

  it('reports every problem at once, not one per restart', () => {
    // Doc §35.3: "An operator should not fix one setting per restart."
    try {
      validateStartupConfiguration({ SL_ENV: 'production' });
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationRefusedError);
      const { problems } = error as ConfigurationRefusedError;
      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect(problems.some((p) => p.includes('SL_DATABASE_URL'))).toBe(true);
      expect(problems.some((p) => p.includes('SL_SESSION_SECRET'))).toBe(true);
      expect(problems.some((p) => p.includes('SL_CURSOR_SECRET'))).toBe(true);
    }
  });

  it('accepts a correctly configured production environment', () => {
    expect(() =>
      validateStartupConfiguration({
        SL_ENV: 'production',
        SL_DATABASE_URL: url('starlink_core'),
        SL_SESSION_SECRET: 'a'.repeat(40),
        SL_CURSOR_SECRET: 'b'.repeat(40),
      }),
    ).not.toThrow();
  });
});
