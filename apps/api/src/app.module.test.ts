/**
 * The Stage-2 customer surface is not mounted unless it is switched on.
 *
 * `employee-web` has always read `SL_CUSTOMER_WORKSPACE_ENABLED` and hidden the customer
 * workspace behind it. The API read it nowhere and registered all three customer
 * controllers unconditionally, so the flag meant "hide the interface" on one surface and
 * nothing at all on the other — the exact posture the channels work rejected, where
 * hiding a control was not accepted as disabling a feature.
 *
 * The route that makes it worth a test rather than a comment is
 * `POST /v1/customer/auth/session`. It is `@Public()` by necessity, its own docblock
 * defers rate limiting to an edge this repository does not have, and each call writes a
 * principal row and an audit row — and rule 8 makes the audit ledger APPEND-ONLY, so the
 * one table nothing may clean up was writable without limit by anyone who could reach
 * the port, in a stage that runs no customer flows at all.
 */
import { describe, expect, it } from 'vitest';

import { customerSurfaceEnabled } from './app.module.js';

describe('the customer surface flag', () => {
  it('is off when the setting is absent', () => {
    // The default is what a Stage 1 deployment gets, so the default is the security
    // property. An operator who has not heard of this setting must not be serving it.
    expect(customerSurfaceEnabled({})).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    expect(customerSurfaceEnabled({ SL_CUSTOMER_WORKSPACE_ENABLED: 'true' })).toBe(true);
  });

  it('treats every other value as off, including the ones that look enabled', () => {
    /**
     * `Boolean('false')` is `true`, and `z.coerce.boolean()` is exactly that — a trap
     * this repository has already been caught by once, on `SL_NOTIFY_EMAIL_SECURE`,
     * where writing `false` turned implicit TLS ON. A flag that enables an
     * unauthenticated write surface when somebody writes "false" is the same bug with a
     * worse blast radius, so the comparison is against the exact string and this pins it.
     */
    for (const value of ['false', 'FALSE', 'True', 'TRUE', '0', '1', 'yes', 'no', '', ' true']) {
      expect(customerSurfaceEnabled({ SL_CUSTOMER_WORKSPACE_ENABLED: value }), value).toBe(false);
    }
  });
});
