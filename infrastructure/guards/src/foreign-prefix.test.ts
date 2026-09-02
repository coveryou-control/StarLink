/**
 * F-3 — the configuration naming boundary (doc §35.1).
 *
 * "Every StarLink setting carries the SL_ prefix. There is exactly one prefix and no
 * fallback to any other product's variables… A fallback chain — read SL_MONGO_URL, and
 * if absent try something else — is precisely how a 'standalone' system acquires a
 * dependency nobody declared. One prefix, no fallback, and a build-time test that
 * fails if a foreign prefix appears anywhere in the application."
 *
 * This is that test.
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './source-scan.js';

/**
 * Standard runtime variables that are not "another product's configuration".
 *
 * Kept deliberately short. Anything StarLink itself needs to configure gets an SL_
 * name; this list is for the platform's own vocabulary.
 */
const PERMITTED_NON_SL_VARIABLES = new Set([
  'NODE_ENV',
  'CI',
  'PATH',
  'HOME',
  'PORT',
  'TZ',
  'npm_package_name',
  'npm_package_version',
  // Provided by GitHub Actions / container runtimes, never read for business config.
  'GITHUB_ACTIONS',
  'RUNNER_OS',
]);

/** Prefixes belonging to other platforms. Their presence is the failure §35.1 names. */
const FOREIGN_PREFIXES = ['NS_', 'NORTHSTAR_', 'CCS_', 'CYBRAIN_', 'CY_BRAIN_', 'BRAIN_'];

const ENV_ACCESS = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/g;

describe('configuration naming boundary (§35.1)', () => {
  const files = collectSourceFiles();

  it('finds source to scan', () => {
    // A guard that silently scans nothing passes forever.
    expect(files.length).toBeGreaterThan(10);
  });

  it('reads no environment variable outside the SL_ namespace', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // The guard describes the rule it enforces, so exclude it from its own scan.
      if (file.path.startsWith('infrastructure/guards/')) continue;
      for (const match of file.content.matchAll(ENV_ACCESS)) {
        const variable = match[1] ?? match[2];
        if (variable === undefined) continue;
        if (variable.startsWith('SL_')) continue;
        if (PERMITTED_NON_SL_VARIABLES.has(variable)) continue;
        offenders.push(`${file.path}: process.env.${variable}`);
      }
    }
    expect(offenders, `variables outside the SL_ namespace:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * A prefix only means anything at the START of a name.
   *
   * This was a bare `includes`, which reads any occurrence anywhere as a violation — so
   * `__STARLINK_ORIGINS__` failed the build, because "ORIGI**NS_**" contains `NS_`. The
   * same false positive waits inside `MAX_CONNECTIONS_`, `PATTERNS_`, `OPTIONS_` and any
   * other plural ending in "ns". A guard that fires on innocent names is a guard people
   * start editing around, which is how it stops protecting anything.
   *
   * Every real case survives: `process.env.NS_URL` is preceded by a dot, `NORTHSTAR_HOST`
   * by a line start or a quote. Only a prefix buried mid-identifier — which is not a
   * prefix — is let through.
   */
  const startsAnIdentifier = (content: string, prefix: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9_])${prefix}`).test(content);

  it('contains no foreign configuration prefix anywhere in the application', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path.startsWith('infrastructure/guards/')) continue;
      for (const prefix of FOREIGN_PREFIXES) {
        if (startsAnIdentifier(file.content, prefix)) {
          offenders.push(`${file.path}: contains "${prefix}"`);
        }
      }
    }
    expect(offenders, `foreign prefixes found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('still catches a foreign prefix where one would really appear', () => {
    // The positive control for the narrowing above. Without it, a future tightening could
    // reduce this check to nothing and every run would stay green while proving less.
    for (const sample of [
      'const url = process.env.NS_DATABASE_URL;',
      'NORTHSTAR_API_TOKEN=abc',
      '  CY_BRAIN_ENDPOINT: z.string(),',
    ]) {
      expect(
        FOREIGN_PREFIXES.some((prefix) => startsAnIdentifier(sample, prefix)),
        `should have been flagged: ${sample}`,
      ).toBe(true);
    }

    // And the name that prompted the narrowing: a word merely ending in "ns_" is not one.
    expect(
      FOREIGN_PREFIXES.some((prefix) => startsAnIdentifier("'__STARLINK_ORIGINS__'", prefix)),
      'an identifier that only ends in "ns_" is not a foreign prefix',
    ).toBe(false);
  });

  it('declares no fallback chain from an SL_ variable to a foreign one', () => {
    // The specific pattern §35.1 warns about: read ours, and if absent try theirs.
    const fallback = /process\.env\.SL_[A-Z0-9_]+\s*\?\?\s*process\.env\.(?!SL_)[A-Za-z_]/g;
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path.startsWith('infrastructure/guards/')) continue;
      if (fallback.test(file.content)) offenders.push(file.path);
      fallback.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
