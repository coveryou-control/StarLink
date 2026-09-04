/**
 * The security baseline (SL-073 — doc §27, NFR-SEC).
 *
 * SL-073's acceptance criterion is literally *"Security baseline test passes"*, and until
 * now there was no such test. The headers, the CSP and the per-surface cookie scoping were
 * all configured and all correct; nothing asserted any of them, so any of them could have
 * been dropped in a refactor without a single failure.
 *
 * It runs in a browser against the real servers rather than as a unit test, because three
 * of the properties here only exist end to end: a header is set by a running server, a
 * cookie flag is enforced by a real cookie jar, and HttpOnly means nothing until something
 * actually tries to read the cookie from script.
 *
 * ## The cookie assertion earns its place
 *
 * `Max-Age` is checked against a floor because it has already been wrong once: the value
 * was passed to Express in seconds where Express expects milliseconds, so every session
 * expired a thousand times early — a customer's 30-minute session lasted 1.8 seconds. No
 * API test could see it, because they build the `Cookie` header by hand and a hand-built
 * header has no expiry at all.
 */
import { expect, test } from '@playwright/test';

import { CREDENTIALS, ORIGINS } from './support/env.js';
import { resetTeamWork } from './support/reset.js';

/** §27.11. Every one of these is set deliberately; none is a framework default. */
const REQUIRED_HEADERS: readonly (readonly [string, string])[] = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
];

/**
 * The queue is shared, and claiming takes the OLDEST waiting entry (§23.4).
 *
 * Per test rather than per file: every test here creates the conversation it then claims,
 * so a leftover from the previous test is the one that gets taken - which is how a test
 * ends up asserting against a thread it never wrote to. Cheap, and it removes the whole
 * class of ordering bug rather than the instance that happened to surface.
 */
test.beforeEach(async () => {
  await resetTeamWork();
});

test('the API sets its security headers and a restrictive CSP (§27.11)', async ({ request }) => {
  const response = await request.get(`${ORIGINS.api}/healthz`);
  expect(response.ok()).toBe(true);
  const headers = response.headers();

  for (const [name, value] of REQUIRED_HEADERS) {
    expect(headers[name], `${name} missing or wrong on the API`).toBe(value);
  }

  // The API serves JSON only, so nothing it returns should ever be rendered as a document.
  // `default-src 'none'` says exactly that, and `frame-ancestors 'none'` repeats the
  // clickjacking refusal for browsers that honour CSP over X-Frame-Options.
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('both web surfaces set their security headers (§27.11)', async ({ request }) => {
  for (const [surface, origin] of [
    ['employee', ORIGINS.employeeWeb],
    ['customer', ORIGINS.customerWeb],
  ] as const) {
    const response = await request.get(origin);
    expect(response.ok(), `${surface} surface did not respond`).toBe(true);
    const headers = response.headers();
    for (const [name, value] of REQUIRED_HEADERS) {
      expect(headers[name], `${name} missing or wrong on the ${surface} surface`).toBe(value);
    }
  }
});

test('CORS admits the two declared origins and nothing else (§19.2)', async ({ request }) => {
  // The employee surface is allowed, with credentials - the session cookie has to travel.
  const allowed = await request.fetch(`${ORIGINS.api}/healthz`, {
    headers: { Origin: ORIGINS.employeeWeb },
  });
  expect(allowed.headers()['access-control-allow-origin']).toBe(ORIGINS.employeeWeb);
  expect(allowed.headers()['access-control-allow-credentials']).toBe('true');

  // Anything else gets no grant at all. A wildcard here would be the whole boundary gone,
  // and a wildcard WITH credentials is something browsers refuse outright - so the failure
  // would be silent in a server test and total in a browser.
  const stranger = await request.fetch(`${ORIGINS.api}/healthz`, {
    headers: { Origin: 'http://evil.example' },
  });
  const grant = stranger.headers()['access-control-allow-origin'];
  expect(grant === undefined || grant === '').toBe(true);
  expect(grant).not.toBe('*');
});

test('the employee session cookie is HttpOnly, scoped, and lives its full length (FR-AUTH-1/3)', async ({
  page,
  context,
}) => {
  await page.goto(`${ORIGINS.employeeWeb}/sign-in`);
  await page.getByLabel('Work email').fill(CREDENTIALS.agent.username);
  await page.getByLabel('Password').fill(CREDENTIALS.agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/conversations/);

  const cookie = (await context.cookies()).find((c) => c.name === 'sl_emp_session');
  expect(cookie, 'no employee session cookie was set').toBeDefined();

  // FR-AUTH-1: the token is never readable from script. This is the assertion that needs
  // a browser - the flag is only meaningful because something tries and fails.
  expect(cookie?.httpOnly, 'session cookie must be HttpOnly').toBe(true);
  const visibleToScript = await page.evaluate(() => document.cookie);
  expect(visibleToScript).not.toContain('sl_emp_session');

  // §19.3: strict on the employee surface, so a cross-site request carries nothing.
  expect(cookie?.sameSite).toBe('Strict');

  /**
   * The lifetime regression guard, BOUNDED AT BOTH ENDS.
   *
   * It used to assert only `> 3600`. That catches the seconds-passed-through-as-
   * milliseconds defect (a 12-hour session lasting 43 seconds) and is satisfied just as
   * comfortably by the opposite one — the ×1000 applied twice, giving roughly 500 days —
   * which is exactly what shipped underneath this passing assertion.
   *
   * The configured lifetime here is twelve hours. The window is generous in both
   * directions because a browser's own clock and the server's are not the same clock
   * (ADR-025), but it is a WINDOW: no unit error of a factor of a thousand fits inside it
   * in either direction.
   */
  const TWELVE_HOURS = 12 * 60 * 60;
  const secondsRemaining = (cookie?.expires ?? 0) - Date.now() / 1000;

  expect(
    secondsRemaining,
    `session cookie expires in ${Math.round(secondsRemaining)}s — far short of its configured life`,
  ).toBeGreaterThan(TWELVE_HOURS * 0.9);

  expect(
    secondsRemaining,
    `session cookie lives ${Math.round(secondsRemaining / 86_400)} days. An ordinary sign-in ` +
      'is twelve hours; a cookie outliving its own token loiters on a shared machine. If ' +
      '"keep me signed in" has started ticking itself by default, that is this failure.',
  ).toBeLessThan(TWELVE_HOURS * 1.1);
});

/**
 * "Keep me signed in on this device" — the other half of the lifetime guard.
 *
 * The test above pins the DEFAULT at twelve hours, and it caught the box being drawn
 * pre-ticked: every sign-in on every machine, including a shared branch terminal, was
 * quietly getting a fortnight. That guard only works while somebody can still get the long
 * session deliberately, so this asserts the capability the default rules out.
 *
 * Both ends again. The token and the cookie are set from ONE number in the sign-in route,
 * so a cookie that does not match the configured remember-TTL means they have come apart —
 * which is the same class of defect as the ×1000 that shipped under the old one-sided
 * assertion, just at the other end of the range.
 */
test('ticking "keep me signed in" lengthens the session, and only then (FR-AUTH-1)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${ORIGINS.employeeWeb}/sign-in`);
  await page.getByLabel('Work email').fill(CREDENTIALS.agent.username);
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.agent.password);

  const remember = page.getByLabel('Keep me signed in on this device');
  await expect(remember, 'the box must start unticked — see the default guard above').not.toBeChecked();
  await remember.check();

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/conversations/);

  const cookie = (await context.cookies()).find((c) => c.name === 'sl_emp_session');
  expect(cookie, 'no employee session cookie was set').toBeDefined();

  const FOURTEEN_DAYS = 14 * 24 * 60 * 60;
  const secondsRemaining = (cookie?.expires ?? 0) - Date.now() / 1000;

  expect(
    secondsRemaining,
    `ticked, the session is ${Math.round(secondsRemaining / 3600)}h — the checkbox did nothing`,
  ).toBeGreaterThan(FOURTEEN_DAYS * 0.9);

  expect(
    secondsRemaining,
    `ticked, the session is ${Math.round(secondsRemaining / 86_400)} days — longer than the ` +
      'configured fortnight, so the cookie and its token have come apart',
  ).toBeLessThan(FOURTEEN_DAYS * 1.1);

  await context.close();
});
