/**
 * Where the browser bundle finds the API and the realtime gateway (§37.7, §35.3).
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
  readonly realtime: string;
}

/** The ports this app's own `dev` scripts bind. §35.3: every setting has a working default. */
export const FALLBACK_ORIGINS: RuntimeOrigins = {
  api: 'http://localhost:3000',
  realtime: 'http://localhost:3100',
};

/**
 * Read lazily on every call, never captured at module scope.
 *
 * The injected script and the app bundle have no guaranteed evaluation order, and a
 * module-scope read would capture the fallback permanently if the bundle happened to run
 * first — reintroducing exactly the hardcoded-localhost bug this file exists to remove.
 */
/**
 * Is the customer workspace visible in the employee application?
 *
 * ## Why this exists
 *
 * The rollout was sequenced on 2026-08-31: **Stage 1 is employee-to-employee only**, and
 * Stage 2 is the customer pilot. That is a release decision, not an architecture change —
 * the customer implementation stays exactly where it is, wired and tested, and nothing
 * about it is deleted.
 *
 * What must change is what the employee application *presents*. A product that shows a
 * customer queue, a team workload panel and a resolve/transfer/escalate toolbar is telling
 * an internal pilot user they are looking at a customer-support tool. For Stage 1 they are
 * not.
 *
 * ## Why a setting rather than deleted code or a CSS rule
 *
 * Hiding with CSS would leave the panels mounted, still polling `/queues/:teamId` and
 * `/queues/:teamId/load` every few seconds — the surface would be invisible and the
 * dependency would remain, which is the opposite of what "not exposed in Stage 1" means.
 * Deleting the components would make Stage 2 a rebuild rather than a flag flip.
 *
 * So the panels are not rendered at all when this is false, and therefore never mount,
 * never fetch and never appear. Stage 2 is `SL_CUSTOMER_WORKSPACE_ENABLED=true`.
 *
 * Default FALSE, per §35.3's rule that every setting ships a working default: the default
 * is the stage we are actually in.
 */
export function customerWorkspaceEnabled(): boolean {
  const injected = (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY];
  if (typeof injected !== 'object' || injected === null) return false;
  return (injected as { customerWorkspace?: unknown }).customerWorkspace === true;
}

export function runtimeOrigins(): RuntimeOrigins {
  const injected = (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY];
  if (typeof injected !== 'object' || injected === null) return FALLBACK_ORIGINS;
  const candidate = injected as Partial<RuntimeOrigins>;
  const pick = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value !== '' ? value : fallback;
  return {
    api: pick(candidate.api, FALLBACK_ORIGINS.api),
    realtime: pick(candidate.realtime, FALLBACK_ORIGINS.realtime),
  };
}
