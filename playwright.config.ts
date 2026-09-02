/**
 * The browser suite (`STARLINK_TEST_STRATEGY.md` §1, row "E2E browser").
 *
 * The strategy names Playwright and the surfaces it must cover: "employee + customer
 * surfaces; internal-note composer distinctness; offline/reconnect/draft recovery;
 * pending-send states". Until this existed the repository had no test that opened a
 * browser at all — every UI claim rested on a unit test of a hook or a controller, which
 * is exactly the class of evidence that let a socket protocol mismatch survive: both
 * halves passed their own tests and no test ever connected them.
 *
 * ## Why the system Chrome
 *
 * `channel: 'chrome'` drives the browser already installed on the machine instead of
 * downloading Playwright's bundled builds. It keeps the suite runnable where a ~150MB
 * post-install download is not (this machine has no administrator rights), and it tests
 * the browser the business actually uses. CI may add more channels; nothing here assumes
 * only one.
 *
 * ## Why one worker
 *
 * The fixtures are rows in one shared database, and the same reasoning that puts
 * `fileParallelism: false` on the vitest run applies harder here: two browsers claiming
 * from the same queue would race for the same conversation and fail for reasons that have
 * nothing to do with the product. Serial and honest beats parallel and flaky.
 *
 * ## Ports
 *
 * All four servers run on ports well away from the development defaults, so an already
 * running `pnpm dev` cannot quietly become the system under test.
 */
import { defineConfig, devices } from '@playwright/test';

import { CONNECTION, CURSOR_SECRET, ORIGINS, PORTS, SESSION_SECRET } from './e2e/support/env.js';

/** Shared by both API and gateway; each refuses to start if any of it is missing. */
const serverEnv = {
  ...process.env,
  SL_ENV: 'test',
  SL_LOG_LEVEL: process.env.SL_E2E_LOG_LEVEL ?? 'error',
  SL_DATABASE_URL: CONNECTION,
  SL_SESSION_SECRET: SESSION_SECRET,
  SL_CURSOR_SECRET: CURSOR_SECRET,
  SL_WEB_EMPLOYEE_ORIGIN: ORIGINS.employeeWeb,
  SL_WEB_CUSTOMER_ORIGIN: ORIGINS.customerWeb,
};

export default defineConfig({
  testDir: './e2e',
  // The vitest workspace covers `packages|adapters|infrastructure|apps` only, so these
  // specs are invisible to `pnpm test` and cannot be collected by the wrong runner.
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // A browser step that hangs should fail the suite, not the build agent. Generous
  // because these are whole journeys, not clicks: one of them signs in, waits for a
  // sweep to place a queue row, exchanges four messages across two surfaces and resolves.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // The JSON report is written on every run, not only under CI. `pnpm test:e2e:verify`
  // feeds it to the same no-skips gate the unit run uses, and a gate that only exists on
  // the build agent is one a developer cannot reproduce — which is how the CI copy of that
  // check drifted away from the real one unnoticed.
  reporter: [['list'], ['json', { outputFile: '.playwright-report.json' }]],

  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',

  webServer: [
    {
      // Wrapped rather than run directly, so the dev OTP line reaches a file the
      // customer journey can read. See `run-api.mjs`.
      command: 'node e2e/support/run-api.mjs',
      url: `${ORIGINS.api}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...serverEnv,
        SL_API_PORT: String(PORTS.api),
        SL_DB_MAX_CONNECTIONS: '8',
        /**
         * No `SL_ADAPTER_*` overrides here, deliberately.
         *
         * This file used to set `SL_ADAPTER_WORK_ORCHESTRATOR: 'local'`, and so did every
         * integration test — which is exactly why nobody noticed that the DEFAULT was
         * `mock`, an in-memory Map that accepted every customer conversation and dropped
         * it while the routing sweep reported success. The configuration that was tested
         * and the configuration that shipped were not the same configuration.
         *
         * The browser suite is the last place that should be true of. Whatever ADAPTERS a
         * fresh checkout runs on, these journeys run on.
         *
         * Cadence is a different matter and is NOT the default: seven of the sweeps below
         * are set to an hour against a 180s per-test ceiling, so they never fire during the
         * suite — including the inactive-owner sweep behind rule 7. That is a deliberate
         * choice (a router placing fixtures mid-journey changes what the assertions see),
         * but it means this file proves nothing about those seven.
         */
        // The routing sweep is what moves an after-hours arrival into the queue the
        // browser then claims from; the notification sweep is what makes the bell
        // non-empty. Both are polled fast here so a browser is not left waiting.
        SL_SWEEP_ROUTING_SECONDS: '1',
        SL_SWEEP_NOTIFICATION_SECONDS: '1',
        SL_SWEEP_SLA_SECONDS: '3600',
        SL_SWEEP_REOPEN_SECONDS: '3600',
        SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
        SL_SWEEP_RESERVATION_SECONDS: '3600',
        SL_SWEEP_INDEX_HEALTH_SECONDS: '3600',
        /**
         * Fast, but not instant — and the "not instant" is deliberate.
         *
         * An attachment cannot be BOUND until it is CLEAN (§28.1), so at the default
         * cadence a browser would sit staring at a file that never becomes sendable. At
         * one second the SCANNING state exists but is too brief to assert on, and the
         * journey that matters most — sending while a file is still being checked, and
         * being told so — would be a race.
         *
         * Five seconds makes both states observable from the UI, so the browser test
         * waits on what the person sees rather than on a timer.
         */
        SL_SWEEP_ATTACHMENT_SCAN_SECONDS: '5',
        SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS: '3600',
        SL_QUEUE_METRICS_SECONDS: '3600',
      },
    },
    {
      command: 'node apps/realtime-gateway/dist/main.js',
      url: `${ORIGINS.realtime}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...serverEnv, SL_REALTIME_PORT: String(PORTS.realtime), SL_RELAY_POLL_MS: '400' },
    },
    {
      // `next start` against the committed build. The origins below are read by the
      // SERVER at request time and written into the document — the change that made them
      // configuration rather than something compiled into the bundle.
      command: `node node_modules/next/dist/bin/next start -p ${PORTS.employeeWeb}`,
      cwd: 'apps/employee-web',
      url: ORIGINS.employeeWeb,
      timeout: 120_000,
      reuseExistingServer: false,
      /**
       * Stage 2's customer workspace is ENABLED for the browser suite.
       *
       * The rollout sequenced Stage 1 as employee-to-employee, so the shipped default hides
       * the customer queue and team-load panels — but the customer implementation is
       * deferred, not cancelled, and `employee-actions.spec.ts` is the evidence that it
       * still works. Turning the flag on here keeps that evidence running: the day Stage 2
       * starts, the suite has been green against it the whole time rather than being
       * written from scratch against code nobody exercised for a month.
       *
       * `stage-scope.test.ts` covers the other half — that the shipped DEFAULT is off.
       *
       * `SL_E2E_CUSTOMER_WORKSPACE=false` runs the same suite against the Stage 1
       * configuration instead. It exists so the shipping configuration can actually be
       * looked at and driven, rather than only asserted about in a source-reading unit
       * test; the default is unchanged, so an ordinary `pnpm test:e2e` still runs Stage 2.
       */
      env: {
        ...process.env,
        SL_API_ORIGIN: ORIGINS.api,
        SL_REALTIME_ORIGIN: ORIGINS.realtime,
        SL_CUSTOMER_WORKSPACE_ENABLED: process.env.SL_E2E_CUSTOMER_WORKSPACE ?? 'true',
      },
    },
    {
      command: `node node_modules/next/dist/bin/next start -p ${PORTS.customerWeb}`,
      cwd: 'apps/customer-web',
      url: ORIGINS.customerWeb,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...process.env, SL_API_ORIGIN: ORIGINS.api },
    },
  ],
});
