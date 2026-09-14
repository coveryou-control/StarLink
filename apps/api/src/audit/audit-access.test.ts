import { describe, expect, it, vi } from 'vitest';

import { ROLE_ACTIONS } from '@starlink/conversation-domain';
import type { IdentityAuthorizationClient, PrincipalClaims, UUID } from '@starlink/shared-contracts';

import type { AuditWriter } from './audit-writer.js';
import { permitAuditRead } from './audit-access.js';

/**
 * The door to the audit surface, and the hole it was found to have.
 *
 * ## The defect this file exists for
 *
 * The first version asked `decide()` only for the action each handler named —
 * `search.execute` for search, `directory.read` for teams. Both are actions an ordinary
 * `AGENT` holds, because employees search their own conversations and browse the directory
 * every day. So an ordinary employee got `200` from `GET /v1/audit/search`: the same message
 * index WITHOUT the participation narrowing, which is company-wide message search handed to
 * everybody in the company.
 *
 * It was found by driving the running API as an agent rather than by reading the code, which
 * is the honest way round: the code looked right, because every handler did call `decide()`
 * with a real action, which is what the rule asks for. What it did not do was ask the
 * question this surface actually turns on.
 *
 * So the gate is the CAPABILITY — is this principal the auditor — and the handler's action
 * is the second question and the thing the ledger records. These tests hold that shape.
 */

const PAST = '2020-01-01T00:00:00.000Z';
const AUDITOR = '018f2c5a-0000-7000-8000-0000000000a1' as UUID;
const AGENT = '018f2c5a-0000-7000-8000-0000000000b2' as UUID;

const claimsFor = (principalId: UUID, role: string): PrincipalClaims =>
  ({
    principalId,
    status: 'ACTIVE',
    displayName: role,
    department: 'Compliance',
    teams: [],
    roles: [{ role, scope: { kind: 'GLOBAL' }, effectiveFrom: PAST }],
    delegations: [],
    temporaryGrants: [],
  }) as unknown as PrincipalClaims;

function harness(role: string): {
  readonly deps: { identity: IdentityAuthorizationClient; audit: AuditWriter };
  readonly rows: { action: string; outcome: string; reason?: string }[];
} {
  const rows: { action: string; outcome: string; reason?: string }[] = [];
  const identity = {
    resolvePrincipal: vi.fn(async (principalId: UUID) => ({
      ok: true as const,
      value: claimsFor(principalId, role),
    })),
  } as unknown as IdentityAuthorizationClient;

  const audit = {
    record: vi.fn(async (event: { action: string; outcome: string; reason?: string }) => {
      rows.push({ action: event.action, outcome: event.outcome, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
    }),
  } as unknown as AuditWriter;

  return { deps: { identity, audit }, rows };
}

const read = (
  deps: { identity: IdentityAuthorizationClient; audit: AuditWriter },
  principalId: UUID,
  action: Parameters<typeof permitAuditRead>[1]['action'],
): Promise<boolean> =>
  permitAuditRead(deps, {
    principalId,
    action,
    correlationId: 'test-correlation',
    target: { kind: 'audit_surface', id: '00000000-0000-0000-0000-000000000000' },
  });

describe('the auditor gets in', () => {
  it('is permitted every action the surface uses', async () => {
    const { deps } = harness('SUPERADMIN');
    for (const action of [
      'privileged.conversation.read',
      'conversation.read',
      'admin.principal.read',
      'directory.read',
      'search.execute',
      'audit.query',
    ] as const) {
      expect(await read(deps, AUDITOR, action), action).toBe(true);
    }
  });

  it('writes a ledger row for each read, before the content is returned', async () => {
    const { deps, rows } = harness('SUPERADMIN');
    await read(deps, AUDITOR, 'privileged.conversation.read');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('SUCCEEDED');
    expect(rows[0]?.action).toBe('privileged.conversation.read');
  });
});

describe('an ordinary employee does not', () => {
  /**
   * The regression. `AGENT` holds `search.execute` and `directory.read` legitimately, and
   * that is exactly why naming the action was not enough: an authorization check that passes
   * for the wrong reason is indistinguishable from one that works, until somebody asks.
   */
  it('is refused the actions it DOES hold, because the door is the capability', async () => {
    const { deps } = harness('AGENT');
    const held = ROLE_ACTIONS['AGENT'] ?? [];
    expect(held, 'the premise of this test').toContain('search.execute');

    for (const action of ['search.execute', 'directory.read'] as const) {
      expect(
        await read(deps, AGENT, action),
        `an ordinary agent reached the audit surface with "${action}" — it holds that action, ` +
          'which is the whole point: the surface must gate on being the auditor',
      ).toBe(false);
    }
  });

  it('is refused the actions it does not hold either', async () => {
    const { deps } = harness('AGENT');
    for (const action of ['privileged.conversation.read', 'audit.query', 'admin.principal.read'] as const) {
      expect(await read(deps, AGENT, action)).toBe(false);
    }
  });

  it('records the refusal, and says which half refused', async () => {
    /* "Not the auditor" and "the auditor may not do this" are different incidents. The
       caller is told nothing either way (§27.3); the ledger is where the difference lives. */
    const { deps, rows } = harness('AGENT');
    await read(deps, AGENT, 'search.execute');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('REFUSED');
    expect(rows[0]?.reason).toBe('NOT_THE_AUDITOR');
  });

  it('is refused even when it holds a full ADMIN role', async () => {
    /**
     * FR-AUTHZ-7 at the door. An administrator manages accounts, roles and channels and
     * still cannot read the traffic — including through this surface, which is the one
     * place somebody might expect administration to imply readership.
     */
    const { deps } = harness('ADMIN');
    for (const action of ['privileged.conversation.read', 'admin.principal.read', 'audit.query'] as const) {
      expect(await read(deps, AGENT, action), `ADMIN reached the audit surface via ${action}`).toBe(
        false,
      );
    }
  });

  it('is refused when the principal cannot be resolved at all', async () => {
    const rows: { action: string; outcome: string; reason?: string }[] = [];
    const identity = {
      resolvePrincipal: vi.fn(async () => ({ ok: false as const, error: 'gone' })),
    } as unknown as IdentityAuthorizationClient;
    const audit = {
      record: vi.fn(async (event: { action: string; outcome: string; reason?: string }) => {
        rows.push({ action: event.action, outcome: event.outcome, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
      }),
    } as unknown as AuditWriter;

    expect(await read({ identity, audit }, AUDITOR, 'audit.query')).toBe(false);
    expect(rows[0]?.reason).toBe('PRINCIPAL_UNRESOLVED');
  });
});
