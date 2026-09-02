/**
 * Where the browser bundle finds the API (§37.7, §35.3).
 *
 * ## The defect this replaces
 *
 * These origins were read as `process.env.SL_API_ORIGIN` at module scope inside a
 * `'use client'` module, made to work by an `env:` block in `next.config.mjs`. That block
 * inlines the value **at build time** — the built chunk contains the literal string and no
 * longer mentions the variable at all (verified by grepping `.next/static`: `localhost:3000`
 * present, `SL_API_ORIGIN` absent).
 *
 * §37.7 makes "Configuration: injected per environment; values only, never code paths" an
 * ARCHITECTURAL REQUIREMENT, and proposes a deployment artefact "built once, promoted
 * between environments". A build-time origin cannot satisfy both: the hostname is welded
 * into the image, so promoting one artefact from staging to production would point the
 * production surface at staging's API. The failure is silent and total — every request from
 * the browser goes to the wrong host.
 *
 * ## Why a rendered script rather than `NEXT_PUBLIC_`
 *
 * `NEXT_PUBLIC_` inlines at build time too, so it moves the prefix without fixing the
 * problem. The server layout reads the `SL_`-prefixed variables per request and writes
 * their values into the document; this reads them back. The names stay server-side, so
 * §35.1's single-prefix rule is untouched and no foreign prefix is introduced.
 */
export const RUNTIME_ORIGINS_KEY = '__STARLINK_ORIGINS__';

export interface RuntimeOrigins {
  readonly api: string;
}

/** The ports this app's own `dev` scripts bind. §35.3: every setting has a working default. */
export const FALLBACK_ORIGINS: RuntimeOrigins = {
  api: 'http://localhost:3000',
};

/**
 * Read lazily on every call, never captured at module scope.
 *
 * The injected script and the app bundle have no guaranteed evaluation order, and a
 * module-scope read would capture the fallback permanently if the bundle happened to run
 * first — reintroducing exactly the hardcoded-localhost bug this file exists to remove.
 */
export function runtimeOrigins(): RuntimeOrigins {
  const injected = (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY];
  if (typeof injected !== 'object' || injected === null) return FALLBACK_ORIGINS;
  const candidate = injected as Partial<RuntimeOrigins>;
  const pick = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value !== '' ? value : fallback;
  return {
    api: pick(candidate.api, FALLBACK_ORIGINS.api),
  };
}
