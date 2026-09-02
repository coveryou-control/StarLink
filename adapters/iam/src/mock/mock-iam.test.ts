/**
 * MockIamAdapter against the shared conformance suite.
 *
 * The same suite runs against the Local (PostgreSQL) adapter and, from Phase 9, the
 * Central IAM adapter. That is what makes the cutover a configuration change: all
 * three are held to one behavioural contract, not merely one type signature.
 */
import { describe, expect, it } from 'vitest';
import { identityConformance, type PrincipalClaims } from '@starlink/shared-contracts';
import { MockIamAdapter } from './mock-iam.js';

const PRINCIPAL_ID = '018f2c5a-0000-7000-8000-000000000001';

const claims = (): PrincipalClaims => ({
  principalId: PRINCIPAL_ID,
  employeeId: 'E-001',
  status: 'ACTIVE',
  displayName: 'Conformance Agent',
  roles: [],
  teams: [{ teamId: 'support', displayName: 'Support' }],
  department: 'Service',
  managerChain: [],
  skills: [],
  products: [],
  languages: [],
  delegations: [],
  privilegedCapabilities: [],
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  authority: 'TEMPORARY_AUTHORITY',
  sessionVersion: 1,
});

// The conformance kit is framework-agnostic; bind it to vitest here.
identityConformance({ describe, it, expect: expect as never }, async () => ({
  adapter: new MockIamAdapter([claims()], new Map([['agent:correct-horse', PRINCIPAL_ID]])),
  knownPrincipalId: PRINCIPAL_ID,
  validCredential: { username: 'agent', secret: 'correct-horse' },
}));

describe('MockIamAdapter specifics', () => {
  it('marks an exited employee inactive and invalidates their sessions', async () => {
    // The exit pathway of brief §8: no new assignments, sessions gone, history intact.
    const adapter = new MockIamAdapter([claims()]);
    const before = await adapter.getSessionVersion(PRINCIPAL_ID);
    adapter.setStatus(PRINCIPAL_ID, 'EXITED');
    const after = await adapter.resolvePrincipal(PRINCIPAL_ID);

    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.status).toBe('EXITED');
      // History remains readable to those entitled — the principal record is not
      // deleted, because authorship must stay attributable (brief §49).
      expect(after.value.displayName).toBe('Conformance Agent');
      if (before.ok) expect(after.value.sessionVersion).toBeGreaterThan(before.value);
    }
  });
});
