/**
 * Everything the browser suite and its servers agree on.
 *
 * Ports are deliberately far from the development defaults (3000/3100/3010/3020) so a
 * running `pnpm dev` does not silently become the system under test — a browser suite
 * that passes against a stale hand-started server is worse than no browser suite.
 *
 * The `e2e0` id block belongs to this suite alone, following the convention the
 * `fixture-ids` guard enforces for anything that writes to the shared database.
 */
import { resolve } from 'node:path';

export const PORTS = {
  api: 3400,
  realtime: 3410,
  employeeWeb: 3420,
  customerWeb: 3430,
} as const;

export const ORIGINS = {
  api: `http://localhost:${PORTS.api}`,
  realtime: `http://localhost:${PORTS.realtime}`,
  employeeWeb: `http://localhost:${PORTS.employeeWeb}`,
  customerWeb: `http://localhost:${PORTS.customerWeb}`,
} as const;

export const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** Both are over the 32-character minimum the startup validator enforces. */
export const SESSION_SECRET = 'e2e-browser-session-secret-0123456789';
export const CURSOR_SECRET = 'e2e-browser-cursor-secret-01234567890';

export const TEAM_ID = 'e2e-browser-team';
export const CATEGORY_ID = 'e2e-browser-category';

export const IDS = {
  agent: '018f2c5a-e2e0-7000-8000-00000000000a',
  lead: '018f2c5a-e2e0-7000-8000-00000000000b',
  /** A third person, so BR-07's add-a-participant path has somebody to add. */
  colleague: '018f2c5a-e2e0-7000-8000-00000000000c',
  calendar: '018f2c5a-e2e0-7000-8000-0000000000c1',
} as const;

export const CREDENTIALS = {
  agent: { username: 'e2e.agent', password: 'e2e-agent-password-0001' },
  lead: { username: 'e2e.lead', password: 'e2e-lead-password-0001' },
  colleague: { username: 'e2e.colleague', password: 'e2e-colleague-pw-0001' },
} as const;

/**
 * Where the API's dev OTP sink is teed.
 *
 * The verification code is never stored (only an HMAC is) and never returned in a
 * response, so the only honest way for a browser to obtain one is the same way a
 * developer does: read it out of the API's log. Parsing that line keeps the customer
 * journey a real journey — the code is typed into the real form — instead of a session
 * cookie injected past the front door.
 *
 * Resolved against the working directory rather than this file's own location: Playwright
 * transpiles these modules to CommonJS, where `import.meta` is a syntax error. The API's
 * launcher derives the same path from its own position, and the two agree because the
 * runner and the server it starts share a working directory — the repository root.
 */
export const API_LOG = resolve(process.cwd(), '.playwright', 'api.log');
