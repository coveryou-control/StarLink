import { describe, expect, it } from 'vitest';

import { OUT_OF_BAND_ROLES, ROLE_ACTIONS } from '@starlink/conversation-domain';

import { apiConfigSchema } from '../config.js';

/**
 * The rule that keeps there being exactly one communication auditor.
 *
 * ## Why this needed a test of its own
 *
 * `admin.controller.ts` refuses to grant a role in `OUT_OF_BAND_ROLES`, and until this file
 * existed that refusal was enforced by code nobody had exercised — there is no admin
 * controller test suite at all. It is the weakest kind of security control: correct on
 * reading, and one refactor from being dropped without anything noticing.
 *
 * What it protects is specific. `SUPERADMIN` reads every conversation in the company. If
 * `POST /admin/roles` could issue it, then whoever holds `admin.role.assign` holds
 * company-wide read as well — one request away, to themselves — and FR-AUTHZ-7's separation
 * between administering the directory and reading the traffic would be true of the action
 * list and false of the system.
 *
 * ## What this can and cannot say
 *
 * It asserts the RULE and its consistency with the role catalogue: that the audit role is
 * out of band, that being out of band is meaningful, and that the set has not drifted from
 * the roles that actually confer company-wide read. It does not drive the HTTP handler —
 * that is covered by the running-stack check recorded in the commit, where an administrator
 * attempting this is refused and the attempt appears in the ledger as
 * `ROLE_NOT_SELF_SERVICE`.
 */
describe('roles that no API may grant', () => {
  it('includes the communication auditor', () => {
    expect(OUT_OF_BAND_ROLES.has('SUPERADMIN')).toBe(true);
  });

  it('is not empty, so the check in the controller cannot be vacuous', () => {
    /* A guard that iterates an empty set passes every input. If somebody empties this while
       leaving the `if` in place, the handler silently starts granting everything again. */
    expect(OUT_OF_BAND_ROLES.size).toBeGreaterThan(0);
  });

  it('covers every role that confers a company-wide content read', () => {
    /**
     * The drift this prevents. A second audit-style role added to `ROLE_ACTIONS` — a
     * regional auditor, an assistant, whatever it turns out to be — would be grantable from
     * the admin API the moment it existed, because nothing else in the system knows that
     * `privileged.conversation.read` is the action that opens rung 3a.
     *
     * Derived from the catalogue rather than listed, so the answer stays right as the
     * catalogue changes.
     */
    const companyWideReaders = Object.entries(ROLE_ACTIONS)
      .filter(([, actions]) => actions.includes('privileged.conversation.read'))
      .map(([role]) => role);

    expect(companyWideReaders, 'the premise: some role must confer this').not.toHaveLength(0);

    for (const role of companyWideReaders) {
      expect(
        OUT_OF_BAND_ROLES.has(role),
        `"${role}" grants company-wide conversation read and can be assigned through the ` +
          'admin API. Add it to OUT_OF_BAND_ROLES, or take the action away from it.',
      ).toBe(true);
    }
  });

  it('does not sweep in the ordinary administrative roles', () => {
    /* The opposite failure: an over-broad set would make the admin API unable to grant ADMIN
       or TEAM_LEAD, which is a product outage rather than a protection. */
    for (const role of ['ADMIN', 'TEAM_LEAD', 'AGENT', 'CLAIMS', 'COMPLIANCE', 'LEGAL']) {
      expect(OUT_OF_BAND_ROLES.has(role), `${role} must stay grantable`).toBe(false);
    }
  });

  it('keeps the auditor free of every administrative action', () => {
    /**
     * The other half of the separation, checked from this side. Even if the role could be
     * granted, it holds nothing that would let its holder grant it again — so the two
     * authorities cannot be collapsed from either direction.
     */
    const auditor = ROLE_ACTIONS['SUPERADMIN'] ?? [];
    for (const action of auditor) {
      expect(action.startsWith('admin.'), `SUPERADMIN holds ${action}`).toBe(
        action === 'admin.principal.read' || action === 'admin.role.read',
      );
    }
    expect(auditor).not.toContain('admin.role.assign');
  });
});

/**
 * How long the auditor stays signed in.
 *
 * Verified against the running API when it was written — the auditor's cookie came back
 * with `Max-Age=3600` both with and without "keep me signed in", against 43200 and 1209600
 * for an ordinary employee. What this file holds is the RELATIONSHIP, which is the part
 * that drifts: somebody raising the audit TTL to match the ordinary one would undo the
 * control without touching the code that implements it.
 */
describe('the auditor signs in for less time than anybody else', () => {
  const seconds = (name: 'SL_AUDIT_SESSION_TTL_SECONDS'): number =>
    apiConfigSchema.shape[name].parse(undefined);

  it('is shorter than the ordinary session', () => {
    const audit = apiConfigSchema.shape.SL_AUDIT_SESSION_TTL_SECONDS.parse(undefined);
    const ordinary = apiConfigSchema.shape.SL_SESSION_TTL_SECONDS.parse(undefined);
    expect(audit).toBeLessThan(ordinary);
  });

  it('is very much shorter than a remembered one', () => {
    /* "Keep me signed in" is ignored for this account, so this compares what the auditor
       gets against what it would have got if it were not. */
    const audit = apiConfigSchema.shape.SL_AUDIT_SESSION_TTL_SECONDS.parse(undefined);
    const remembered = apiConfigSchema.shape.SL_SESSION_REMEMBER_TTL_SECONDS.parse(undefined);
    expect(audit * 10).toBeLessThan(remembered);
  });

  it('is still long enough to do an audit in', () => {
    // A five-minute session would be a control nobody could work under, and the first thing
    // anybody would do about it is raise it back to twelve hours.
    expect(seconds('SL_AUDIT_SESSION_TTL_SECONDS')).toBeGreaterThanOrEqual(15 * 60);
  });
});
