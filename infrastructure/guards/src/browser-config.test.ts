/**
 * The browser surfaces may not read configuration from `process.env` (§37.7, §35.3).
 *
 * ## The bug this guard exists to prevent recurring
 *
 * Both web apps used to resolve their API and realtime origins with
 * `process.env.SL_API_ORIGIN` at module scope, made to work by an `env:` map in
 * `next.config.mjs`. That looks like ordinary configuration and is not. Next inlines
 * `env` through DefinePlugin at BUILD time: the compiled chunk holds the literal string
 * and no longer mentions the variable, so setting it at deploy time changes nothing.
 *
 * §37.7 lists "Configuration: injected per environment; values only, never code paths" as
 * an ARCHITECTURAL REQUIREMENT, alongside the proposed artefact "built once, promoted
 * between environments". A build-inlined origin cannot satisfy both — promoting one image
 * from staging to production would leave the production surface calling staging's API, and
 * nothing would report an error because the bundle is doing exactly what it was compiled
 * to do.
 *
 * The origins are now read server-side per request and written into the document. This
 * test fails if anything drifts back: a client module reading `process.env`, or an `env:`
 * map reappearing in either Next config.
 *
 * `NEXT_PUBLIC_` is not the escape hatch — it inlines at build time too, and would put a
 * foreign prefix in front of the SL_ namespace §35.1 reserves.
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './source-scan.js';

const BROWSER_ROOTS = ['apps/employee-web/src/', 'apps/customer-web/src/'] as const;

/**
 * The one file per surface allowed to read the environment: a server component, whose
 * whole job is to read it at request time and hand the values to the document.
 */
const SERVER_INJECTORS = [
  'apps/employee-web/src/components/runtime-origins-script.tsx',
  'apps/customer-web/src/components/runtime-origins-script.tsx',
] as const;

const ENV_READ = /process\.env\b/;

/**
 * Comments are stripped before scanning.
 *
 * `runtime-origins.ts` explains the defect it exists to prevent, and explaining it means
 * writing `process.env.SL_API_ORIGIN` in prose — which the first version of this guard
 * read as the violation itself. A guard that punishes a file for documenting the bug it
 * fixes teaches people to delete the explanation.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('browser configuration is injected, not compiled in (§37.7)', () => {
  const files = collectSourceFiles();

  it('finds the browser sources it claims to scan', () => {
    // A guard whose glob silently stops matching passes forever while proving nothing.
    const scanned = files.filter((f) => BROWSER_ROOTS.some((root) => f.path.startsWith(root)));
    expect(scanned.length).toBeGreaterThan(10);
  });

  it('has a server-side origin injector on both surfaces', () => {
    for (const injector of SERVER_INJECTORS) {
      expect(
        files.some((f) => f.path === injector),
        `${injector} is missing — without it the surface silently falls back to localhost`,
      ).toBe(true);
    }
  });

  it('reads no environment variable from a browser module', () => {
    const offenders = files
      .filter((f) => BROWSER_ROOTS.some((root) => f.path.startsWith(root)))
      .filter((f) => !SERVER_INJECTORS.includes(f.path as (typeof SERVER_INJECTORS)[number]))
      // A test file runs in Node, never in the browser bundle.
      .filter((f) => !f.path.endsWith('.test.ts') && !f.path.endsWith('.test.tsx'))
      .filter((f) => ENV_READ.test(withoutComments(f.content)))
      .map((f) => f.path);

    expect(
      offenders,
      `these run in the browser, where process.env is compiled away:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('declares no build-time `env` map in either Next config', () => {
    const offenders = files
      .filter((f) => /^apps\/(employee|customer)-web\/next\.config\.mjs$/.test(f.path))
      .filter((f) => /^\s*env:\s*\{/m.test(f.content))
      .map((f) => f.path);

    expect(
      offenders,
      `an \`env:\` map inlines its values at build time, which is not configuration:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
