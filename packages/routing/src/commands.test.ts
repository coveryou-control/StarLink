/**
 * Cover, transfer, escalate and reassign-on-exit (doc §21.7, §21.9).
 *
 * PHASE 5 EXIT CRITERION: cover-vs-transfer semantics.
 *
 * §21.9 calls case D — a two-hour meeting — "the one most often got wrong", and the
 * wrong version does not fail. It quietly moves a customer's advisor every time he takes
 * a call, and the relationship is gone before anyone notices. So the first describe
 * block asserts the NEGATIVE: cover changes nothing about ownership.
 */
import { describe, expect, it } from 'vitest';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import { cover, escalate, reassignOnExit, transfer, type CommandDeps } from './commands.js';

const AT = '2026-08-26T11:00:00.000Z' as Timestamp;
const UNTIL = '2026-08-26T13:00:00.000Z' as Timestamp;
const CONVERSATION = '018f2c5a-7b7b-7000-8000-0000000000d1' as UUID;
const OWNER = '018f2c5a-7b7b-7000-8000-00000000000a' as UUID;
const COLLEAGUE = '018f2c5a-7b7b-7000-8000-00000000000b' as UUID;
const LEAD = '018f2c5a-7b7b-7000-8000-00000000000c' as UUID;

interface Recorded {
  reassignments: {
    toOwner: UUID;
    assignmentSource: string;
    preserveDesignated: boolean;
    reason: string;
  }[];
  grants: { principalId: UUID; until: Timestamp; reason: string }[];
  escalations: { reason: string }[];
  audits: { action: string; reason: string }[];
}

/**
 * `null` means unassigned — NOT `undefined`.
 *
 * Passing `undefined` to a defaulted parameter triggers the default, so `deps(undefined)`
 * silently returned an ASSIGNED conversation and the unassigned test proved nothing.
 * `null` cannot be swallowed that way.
 */
function deps(owner: UUID | null = OWNER): { deps: CommandDeps; recorded: Recorded } {
  const recorded: Recorded = { reassignments: [], grants: [], escalations: [], audits: [] };
  let level = 0;

  return {
    recorded,
    deps: {
      ownership: {
        async currentOwner() {
          return owner ?? undefined;
        },
        async reassign(input) {
          recorded.reassignments.push({
            toOwner: input.toOwner,
            assignmentSource: input.assignmentSource,
            preserveDesignated: input.preserveDesignated,
            reason: input.reason,
          });
          return { episodeId: 'episode-1' as UUID };
        },
        async grantCover(input) {
          recorded.grants.push({
            principalId: input.principalId,
            until: input.until,
            reason: input.reason,
          });
          return { grantId: 'grant-1' as UUID };
        },
        async raiseEscalationLevel(input) {
          recorded.escalations.push({ reason: input.reason });
          level += 1;
          return { level };
        },
      },
      audit: {
        async record(entry) {
          recorded.audits.push({ action: entry.action, reason: entry.reason });
        },
      },
    },
  };
}

describe('cover does NOT move ownership (§21.9 cases A and D)', () => {
  it('grants access and leaves the owner exactly where they were', async () => {
    /**
     * The single most important assertion in this file.
     *
     * "Moving ownership for a two-hour meeting churns the relationship for no benefit —
     * the team covers, the owner returns, and the cover is history."
     */
    const { deps: d, recorded } = deps();

    const result = await cover(
      {
        conversationId: CONVERSATION,
        covererId: COLLEAGUE,
        grantedBy: LEAD,
        reason: 'owner in a client meeting until 1pm',
        from: AT,
        until: UNTIL,
      },
      d,
    );

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value.ownerUnchanged).toBe(OWNER);
    // Nothing was reassigned. Not "reassigned back", not "reassigned with a flag" —
    // the reassign path was never entered.
    expect(recorded.reassignments).toEqual([]);
    expect(recorded.grants).toHaveLength(1);
  });

  it('time-boxes the grant', async () => {
    // An open-ended cover is an unaudited second owner. The column is NOT NULL for this
    // reason, and the command refuses to sidestep it.
    const { deps: d, recorded } = deps();

    await cover(
      { conversationId: CONVERSATION, covererId: COLLEAGUE, grantedBy: LEAD, reason: 'meeting', from: AT, until: UNTIL },
      d,
    );

    expect(recorded.grants[0]?.until).toBe(UNTIL);
  });

  it('refuses a window that ends at or before it starts', async () => {
    const { deps: d } = deps();

    for (const until of [AT, '2026-08-26T10:00:00.000Z' as Timestamp]) {
      const result = await cover(
        { conversationId: CONVERSATION, covererId: COLLEAGUE, grantedBy: LEAD, reason: 'x', from: AT, until },
        d,
      );
      expect(result.ok === false && result.reason).toBe('COVER_WINDOW_INVALID');
    }
  });

  it('audits the grant, because it is a read the coverer would not otherwise have', async () => {
    const { deps: d, recorded } = deps();

    await cover(
      { conversationId: CONVERSATION, covererId: COLLEAGUE, grantedBy: LEAD, reason: 'meeting', from: AT, until: UNTIL },
      d,
    );

    expect(recorded.audits.map((a) => a.action)).toEqual(['conversation.cover.granted']);
  });

  it('refuses to cover an unassigned conversation', async () => {
    // Covering FOR nobody leaves the conversation with a helper and still no owner.
    // Unassigned work belongs in the queue, where someone will claim it.
    const { deps: d } = deps(null);

    const result = await cover(
      { conversationId: CONVERSATION, covererId: COLLEAGUE, grantedBy: LEAD, reason: 'x', from: AT, until: UNTIL },
      d,
    );

    expect(result.ok === false && result.reason).toBe('NOT_ASSIGNED');
  });

  it('refuses to have the owner cover for themselves', async () => {
    const { deps: d } = deps();

    const result = await cover(
      { conversationId: CONVERSATION, covererId: OWNER, grantedBy: LEAD, reason: 'x', from: AT, until: UNTIL },
      d,
    );

    expect(result.ok === false && result.reason).toBe('SAME_OWNER');
  });
});

describe('transfer moves ownership and preserves the relationship', () => {
  it('moves the owner but NOT the designated employee', async () => {
    // §21.7: designation changes "rarely — a book transfer, a departure, a business
    // decision". One conversation changing hands is none of those.
    const { deps: d, recorded } = deps();

    const result = await transfer(
      {
        conversationId: CONVERSATION,
        toOwner: COLLEAGUE,
        transferredBy: LEAD,
        reason: 'specialist product question',
        at: AT,
        targetAvailable: true,
      },
      d,
    );

    expect(result.ok).toBe(true);
    expect(recorded.reassignments[0]?.toOwner).toBe(COLLEAGUE);
    expect(recorded.reassignments[0]?.preserveDesignated).toBe(true);
    expect(recorded.reassignments[0]?.assignmentSource).toBe('TRANSFER');
  });

  it('requires a reason', async () => {
    // An ownership change with no stated cause is unanswerable six months later, and
    // these are exactly the records an audit reaches for.
    const { deps: d, recorded } = deps();

    for (const reason of ['', '   ']) {
      const result = await transfer(
        { conversationId: CONVERSATION, toOwner: COLLEAGUE, transferredBy: LEAD, reason, at: AT, targetAvailable: true },
        d,
      );
      expect(result.ok === false && result.reason).toBe('REASON_REQUIRED');
    }
    expect(recorded.reassignments).toEqual([]);
  });

  it('refuses to transfer to someone unavailable', async () => {
    // Work handed to someone on leave is work nobody is looking at — the silent-loss
    // failure of §21.9 case C, reached by a different road.
    const { deps: d, recorded } = deps();

    const result = await transfer(
      { conversationId: CONVERSATION, toOwner: COLLEAGUE, transferredBy: LEAD, reason: 'x', at: AT, targetAvailable: false },
      d,
    );

    expect(result.ok === false && result.reason).toBe('TARGET_UNAVAILABLE');
    expect(recorded.reassignments).toEqual([]);
  });

  it('refuses a transfer to the current owner', async () => {
    const { deps: d } = deps();

    const result = await transfer(
      { conversationId: CONVERSATION, toOwner: OWNER, transferredBy: LEAD, reason: 'x', at: AT, targetAvailable: true },
      d,
    );

    expect(result.ok === false && result.reason).toBe('SAME_OWNER');
  });
});

describe('escalation is a level, not a state', () => {
  it('raises the level and moves ownership, preserving the relationship', async () => {
    const { deps: d, recorded } = deps();

    const result = await escalate(
      {
        conversationId: CONVERSATION,
        toOwner: COLLEAGUE,
        escalatedBy: LEAD,
        reason: 'complaint about mis-selling',
        at: AT,
        targetAvailable: true,
      },
      d,
    );

    expect(result.ok === true && result.value.level).toBe(1);
    expect(recorded.escalations).toHaveLength(1);
    expect(recorded.reassignments[0]?.assignmentSource).toBe('ESCALATION');
    // A specialist handling it does not make them the customer's advisor.
    expect(recorded.reassignments[0]?.preserveDesignated).toBe(true);
  });

  it('requires a reason', async () => {
    const { deps: d, recorded } = deps();

    const result = await escalate(
      { conversationId: CONVERSATION, toOwner: COLLEAGUE, escalatedBy: LEAD, reason: '', at: AT, targetAvailable: true },
      d,
    );

    expect(result.ok === false && result.reason).toBe('REASON_REQUIRED');
    expect(recorded.escalations).toEqual([]);
  });
});

describe('reassign on exit is the ONLY command that moves the designation', () => {
  it('moves both the owner and the designated employee (§21.9 case C)', async () => {
    // A departure is the one event that genuinely ends the relationship. Leaving the
    // designation pointing at someone who has left means the next contact routes to
    // nobody — "the one that silently loses customers".
    const { deps: d, recorded } = deps();

    const result = await reassignOnExit(
      {
        conversationId: CONVERSATION,
        toOwner: COLLEAGUE,
        reassignedBy: LEAD,
        reason: 'previous advisor left the company',
        at: AT,
        targetAvailable: true,
      },
      d,
    );

    expect(result.ok).toBe(true);
    expect(recorded.reassignments[0]?.preserveDesignated).toBe(false);
    expect(recorded.reassignments[0]?.assignmentSource).toBe('REASSIGNED_ON_EXIT');
  });

  it('is the only one of the four that does so', async () => {
    // The table in this module's header, asserted rather than described.
    const commands = [
      async () => {
        const { deps: d, recorded } = deps();
        await transfer(
          { conversationId: CONVERSATION, toOwner: COLLEAGUE, transferredBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
          d,
        );
        return recorded.reassignments[0]?.preserveDesignated;
      },
      async () => {
        const { deps: d, recorded } = deps();
        await escalate(
          { conversationId: CONVERSATION, toOwner: COLLEAGUE, escalatedBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
          d,
        );
        return recorded.reassignments[0]?.preserveDesignated;
      },
    ];

    for (const run of commands) expect(await run()).toBe(true);

    const { deps: d, recorded } = deps();
    await reassignOnExit(
      { conversationId: CONVERSATION, toOwner: COLLEAGUE, reassignedBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
      d,
    );
    expect(recorded.reassignments[0]?.preserveDesignated).toBe(false);
  });

  it('requires a reason and an available target', async () => {
    const { deps: d } = deps();

    expect(
      (
        await reassignOnExit(
          { conversationId: CONVERSATION, toOwner: COLLEAGUE, reassignedBy: LEAD, reason: '', at: AT, targetAvailable: true },
          d,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await reassignOnExit(
          { conversationId: CONVERSATION, toOwner: COLLEAGUE, reassignedBy: LEAD, reason: 'r', at: AT, targetAvailable: false },
          d,
        )
      ).ok,
    ).toBe(false);
  });
});

describe('every ownership change is audited with its reason', () => {
  it('records one audit entry per successful command', async () => {
    const runs: [string, () => Promise<unknown>, Recorded][] = [];

    for (const [action, make] of [
      [
        'conversation.cover.granted',
        (d: CommandDeps) =>
          cover(
            { conversationId: CONVERSATION, covererId: COLLEAGUE, grantedBy: LEAD, reason: 'r', from: AT, until: UNTIL },
            d,
          ),
      ],
      [
        'conversation.transfer',
        (d: CommandDeps) =>
          transfer(
            { conversationId: CONVERSATION, toOwner: COLLEAGUE, transferredBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
            d,
          ),
      ],
      [
        'conversation.escalate',
        (d: CommandDeps) =>
          escalate(
            { conversationId: CONVERSATION, toOwner: COLLEAGUE, escalatedBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
            d,
          ),
      ],
      [
        'conversation.reassign_on_exit',
        (d: CommandDeps) =>
          reassignOnExit(
            { conversationId: CONVERSATION, toOwner: COLLEAGUE, reassignedBy: LEAD, reason: 'r', at: AT, targetAvailable: true },
            d,
          ),
      ],
    ] as const) {
      const { deps: d, recorded } = deps();
      runs.push([action, () => make(d), recorded]);
    }

    for (const [action, run, recorded] of runs) {
      await run();
      expect(recorded.audits.map((a) => a.action), action).toEqual([action]);
      expect(recorded.audits[0]?.reason).toBe('r');
    }
  });
});
