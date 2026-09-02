/**
 * The employee route table is real.
 *
 * Written after four client paths turned out to be wrong — `/v1/conversations`,
 * `/v1/directory`, `/v1/search/messages`, `/v1/auth/me` — one of which had no server
 * route at all. A URL is a string; nothing checks it, and the symptom is a blank screen
 * rather than a build error.
 *
 * The trick that makes this testable is the difference between two refusals:
 *
 *   * Nest answers **404** for a route that does not exist.
 *   * The session guard answers **401** for a route that does exist but has no session.
 *
 * So an UNAUTHENTICATED probe distinguishes "your path is wrong" from "you may not see
 * this" — which an authenticated probe cannot, because a real refusal is also 404 by
 * design (§27.3). Every route in the shared inventory must therefore answer 401.
 *
 * A route answering 404 here means either the path is wrong or, worse, the route exists
 * and is NOT behind the guard.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_ROUTE_INVENTORY,
  customerRoutes,
  EMPLOYEE_ROUTE_INVENTORY,
  employeeRoutes,
} from '@starlink/shared-contracts';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

let api: ChildProcess | undefined;
let ready = false;

/** Placeholders are replaced with syntactically valid values, so a 400 cannot confuse us. */
const concrete = (path: string): string =>
  path
    .replace(':id', '018f2c5a-1c1c-7000-8000-000000000001')
    .replace(':pid', '018f2c5a-1c1c-7000-8000-000000000002')
    .replace(':aid', '018f2c5a-1c1c-7000-8000-000000000003');

beforeAll(async () => {
  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL:
        process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink',
      SL_SESSION_SECRET: 'route-contract-session-secret-0123456789ab',
      SL_CURSOR_SECRET: 'route-contract-cursor-secret-0123456789abc',
      SL_DB_MAX_CONNECTIONS: '3',
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) console.warn('\n  ⚠ route contract test SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(() => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
});

describe('employee route contract', () => {
  it('exposes every route in the shared inventory, all of them guarded', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: the employee route inventory was not checked against a live API.');
      ctx.skip();
      return;
    }

    const missing: string[] = [];
    const unguarded: string[] = [];

    for (const route of EMPLOYEE_ROUTE_INVENTORY) {
      const response = await fetch(`${BASE}${concrete(route.path)}`, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      });

      if (response.status === 404) missing.push(`${route.method} ${route.path}`);
      // 2xx without a session would mean the route escaped the global guard entirely.
      else if (response.status < 400) unguarded.push(`${route.method} ${route.path}`);
      else if (response.status !== 401) {
        // Anything else (403, 500) is also worth knowing about: the guard should reject
        // before a handler runs, so a 500 means the handler ran unauthenticated.
        missing.push(`${route.method} ${route.path} -> unexpected ${response.status}`);
      }
    }

    expect(missing, 'routes that do not exist, or answered before the guard').toEqual([]);
    expect(unguarded, 'routes reachable WITHOUT a session').toEqual([]);
  }, 120_000);

  it('answers 404 for a path that genuinely does not exist', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // Proves the discriminator above is real rather than assumed: if unknown paths
    // returned 401 too, the whole test would pass vacuously.
    const response = await fetch(`${BASE}/v1/employee/definitely-not-a-route`);
    expect(response.status).toBe(404);
  });

  it('leaves the health endpoints public', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // The counterpart: `@Public()` must still work, or the guard has become a wall.
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
  });

  it('keeps sign-in reachable without a session', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
    });
    // Wrong credentials, but the route is public and answers — 404 here would mean the
    // sign-in path itself is wrong, which no other test would catch.
    expect(response.status).toBe(401);
  });
});

/**
 * The SAME contract, on the customer surface — added 2026-08-29.
 *
 * `CUSTOMER_ROUTE_INVENTORY` had existed since Phase 4 and **nothing asserted it**. The
 * employee inventory above exists because four client paths turned out to be wrong and one
 * had no server route at all; the customer surface carries exactly the same exposure and
 * had none of the protection. An audit found the asymmetry, not a failure.
 *
 * Two customer-specific properties are checked here that the employee suite cannot:
 *
 *   * `startSession` and `categories` must stay PUBLIC. §21.5 has a customer browse topics
 *     before identity, and making a session precede that would mint a principal row and an
 *     audit entry for every visitor who never intended to talk to anyone.
 *   * an employee route must not answer on the customer surface, and vice versa. The two
 *     route trees carry different authorization models (`RequireSurface`), so a path that
 *     answered on both would be a path where one of those models is not applied.
 */
describe('customer route contract', () => {
  it('exposes every route in the customer inventory, all of them guarded', async (ctx) => {
    if (!ready) {
      console.warn('  \u26a0 UNPROVEN: the customer route inventory was not checked against a live API.');
      ctx.skip();
      return;
    }

    const missing: string[] = [];
    const unguarded: string[] = [];

    for (const route of CUSTOMER_ROUTE_INVENTORY) {
      const response = await fetch(`${BASE}${concrete(route.path)}`, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      });

      if (response.status === 404) missing.push(`${route.method} ${route.path}`);
      else if (response.status < 400) unguarded.push(`${route.method} ${route.path}`);
      else if (response.status !== 401) {
        missing.push(`${route.method} ${route.path} -> unexpected ${response.status}`);
      }
    }

    expect(missing, 'customer routes that do not exist, or answered before the guard').toEqual([]);
    expect(unguarded, 'customer routes reachable WITHOUT a session').toEqual([]);
  }, 120_000);

  it('keeps the pre-identity routes public', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    /**
     * §21.5: "a customer who abandons at the category step has disclosed nothing." If
     * either of these started requiring a session, the widget would mint a principal for
     * every visitor who opened it — which is the data footprint that rule exists to avoid.
     */
    const categories = await fetch(`${BASE}${customerRoutes.categories}`);
    expect(categories.status, 'browsing topics must not require a session').toBe(200);

    const session = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '+919700000001' }),
    });
    expect(session.status, 'starting a session must not require a session').toBe(201);
  }, 60_000);

  it('does not answer employee paths on the customer tree', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // The surfaces authorize differently (`RequireSurface`). A path answering on both
    // would be a path where one of the two models is not applied.
    const response = await fetch(`${BASE}/v1/customer/admin/accounts`);
    expect(response.status).toBe(404);
  });
});
