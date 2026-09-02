/**
 * The six realtime authorization rules (§20.10, §27.13).
 *
 * §38 records that the reference platform's realtime layer did not close its channels
 * on session end, and implemented authorization separately from HTTP. Both are tested
 * here directly rather than inferred from transport behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ActorContext, ResourceContext } from '@starlink/conversation-domain';
import type { RealtimeEvent, UUID } from '@starlink/shared-contracts';
import { ConnectionManager, type ConnectionIdentity } from './connection-manager.js';

const OWNER = '018f2c5a-1a1a-7000-8000-00000000000a';
const OUTSIDER = '018f2c5a-1a1a-7000-8000-00000000000b';
const CUSTOMER = '018f2c5a-1a1a-7000-8000-00000000000c';
const CONVERSATION = '018f2c5a-1a1a-7000-8000-0000000000d1';

const resource = (over: Partial<ResourceContext> = {}): ResourceContext => ({
  conversationId: CONVERSATION,
  conversationType: 'CUSTOMER_SERVICE',
  currentOwnerId: OWNER,
  customerRef: 'CCS:customer:x',
  sensitivity: 'ORDINARY',
  ...over,
});

const actor = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: OWNER,
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: [],
  departments: [],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

interface Harness {
  manager: ConnectionManager;
  versions: Map<UUID, number>;
}

function harness(over: { resource?: ResourceContext | undefined; actors?: Map<UUID, ActorContext>; now?: () => Date } = {}): Harness {
  const versions = new Map<UUID, number>([
    [OWNER, 1],
    [OUTSIDER, 1],
    [CUSTOMER, 1],
  ]);
  const actors =
    over.actors ??
    new Map<UUID, ActorContext>([
      [OWNER, actor()],
      [OUTSIDER, actor({ principalId: OUTSIDER })],
      [CUSTOMER, actor({ principalId: CUSTOMER, kind: 'CUSTOMER', assurance: 'VERIFIED_CUSTOMER' })],
    ]);

  const manager = new ConnectionManager({
    authz: {
      loadForAuthorization: async (_c, principalId) => {
        const base = 'resource' in over ? over.resource : resource();
        if (base === undefined) return undefined;
        // A customer only ever sees their own conversation as belonging to them.
        return principalId === CUSTOMER ? { ...base, belongsToActorCustomer: true } : base;
      },
    },
    actorFor: async (principalId) => actors.get(principalId),
    sessionVersionFor: async (principalId) => versions.get(principalId),
    // `support` is the only team that exists here; anything else is an unknown team and
    // must be refused exactly as a forbidden one is.
    teamFor: async (teamId) => (teamId === 'support' ? { teamId, department: 'Service' } : undefined),
    // Injectable so a grant can be made to EXPIRE without the test waiting for it.
    ...(over.now !== undefined ? { now: over.now } : {}),
  });

  return { manager, versions };
}

const identity = (over: Partial<ConnectionIdentity> = {}): ConnectionIdentity => ({
  connectionId: 'conn-1',
  principalId: OWNER,
  principalKind: 'EMPLOYEE',
  sessionVersion: 1,
  ...over,
});

describe('rule 1 — authorize at join with the same decision as an HTTP read', () => {
  it('lets the owner join their conversation', async () => {
    const { manager } = harness();
    manager.register(identity());
    const result = await manager.authorizeJoin('conn-1', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a non-participant with no scope — the subscription is not a back door', async () => {
    const { manager } = harness();
    manager.register(identity({ connectionId: 'conn-2', principalId: OUTSIDER }));
    const result = await manager.authorizeJoin('conn-2', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AUTHORIZED');
  });

  it('refuses a conversation that does not exist, identically to one it may not see', async () => {
    const { manager } = harness({ resource: undefined });
    manager.register(identity());
    const result = await manager.authorizeJoin('conn-1', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AUTHORIZED');
  });

  it('refuses a principal channel belonging to someone else', async () => {
    const { manager } = harness();
    manager.register(identity());
    const result = await manager.authorizeJoin('conn-1', { kind: 'PRINCIPAL', principalId: OUTSIDER });
    expect(result.ok).toBe(false);
  });
});

describe('rule 2 — a revoked session cannot resume', () => {
  it('refuses a join once the session version has moved', async () => {
    // The reconnect case: the socket was authorized, the admin revoked, the client
    // reconnected. It must not resume (§20.9 step 1).
    const { manager, versions } = harness();
    manager.register(identity());
    expect((await manager.authorizeJoin('conn-1', { kind: 'CONVERSATION', conversationId: CONVERSATION })).ok).toBe(
      true,
    );

    versions.set(OWNER, 2);
    const after = await manager.authorizeJoin('conn-1', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('SESSION_REVOKED');
  });

  it('refuses when the principal has disappeared entirely', async () => {
    const { manager, versions } = harness();
    manager.register(identity());
    versions.delete(OWNER);
    const result = await manager.authorizeJoin('conn-1', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });
    expect(result.ok).toBe(false);
  });
});

describe('rule 3 — a socket dies with its session', () => {
  it('names every connection belonging to a revoked principal', async () => {
    const { manager } = harness();
    manager.register(identity({ connectionId: 'a' }));
    manager.register(identity({ connectionId: 'b' }));
    manager.register(identity({ connectionId: 'c', principalId: OUTSIDER }));

    const doomed = manager.connectionsToRevoke(OWNER);
    expect([...doomed].sort()).toEqual(['a', 'b']);
  });

  it('finds stale connections on revalidation, even with no control event', async () => {
    // Belt to the control channel's braces: if the revocation event were lost, a
    // timer must still close the socket rather than leaving it alive indefinitely.
    const { manager, versions } = harness();
    manager.register(identity({ connectionId: 'a' }));
    manager.register(identity({ connectionId: 'b', principalId: OUTSIDER }));

    versions.set(OWNER, 5);
    expect((await manager.revalidateAll()).doomed).toEqual(['a']);
  });
});

describe('rule 4 — kind-scoped channels', () => {
  it('refuses a customer connection joining a team queue', async () => {
    const { manager } = harness();
    manager.register(identity({ connectionId: 'cust', principalId: CUSTOMER, principalKind: 'CUSTOMER' }));
    const result = await manager.authorizeJoin('cust', { kind: 'TEAM', teamId: 'support' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CHANNEL_FORBIDDEN_FOR_KIND');
  });

  /**
   * A TEAM room is authorized by the SAME decision the HTTP queue route makes.
   *
   * This branch used to be a kind check alone — `channel.teamId` was compared to nothing —
   * so once `GET /queues/:teamId` was gated, an employee refused the queue over HTTP could
   * still subscribe to that team's room and receive `conversation.queue.arrived.v1`, whose
   * payload is field-for-field what the HTTP endpoint returns. Two answers to one question,
   * which is the §38 divergence this file's header says it exists to prevent.
   */
  describe('TEAM rooms', () => {
    const inSupport = () =>
      new Map<UUID, ActorContext>([
        [
          OWNER,
          actor({
            teams: ['support'],
            departments: ['Service'],
            grants: [
              {
                role: 'AGENT',
                actions: ['queue.read'],
                scopeKind: 'TEAM',
                scopeId: 'support',
                effectiveFrom: '2020-01-01T00:00:00.000Z',
              },
            ],
          }),
        ],
      ]);

    it('admits a member of that team', async () => {
      // The positive control: without it every case below would pass over a branch that
      // refused everybody, which is the other way to "close" this.
      const { manager } = harness({ actors: inSupport() });
      manager.register(identity());
      expect((await manager.authorizeJoin('conn-1', { kind: 'TEAM', teamId: 'support' })).ok).toBe(
        true,
      );
    });

    it('LEAVES the room when the grant expires, without the session changing', async () => {
      /**
       * Rule 4 of this file's header — "force out of the room when participation ends" —
       * which nothing implemented until now.
       *
       * `revalidateAll` compared session versions and stopped there, and a version moves
       * only on deactivation, a role change or a customer's assurance raise. Nothing bumps
       * it when a grant simply reaches its `effectiveTo`: there is no sweep for that. So a
       * time-boxed grant — a shift cover, the ordinary reason a TEAM grant is time-boxed at
       * all — kept delivering every arrival in that queue for as long as the tab stayed
       * open, while the HTTP route over the same data returned 404.
       *
       * The window was not the 60-second revalidation interval. It was "until they
       * reconnect", which is unbounded.
       */
      let clock = new Date('2020-03-01T00:00:00.000Z');
      const covering = new Map<UUID, ActorContext>([
        [
          OWNER,
          actor({
            teams: ['support'],
            departments: ['Service'],
            grants: [
              {
                role: 'AGENT',
                actions: ['queue.read'],
                scopeKind: 'TEAM',
                scopeId: 'support',
                effectiveFrom: '2020-01-01T00:00:00.000Z',
                // The cover ends. Nothing about the SESSION changes when it does.
                effectiveTo: '2020-06-01T00:00:00.000Z',
              },
            ],
          }),
        ],
      ]);

      const { manager } = harness({ actors: covering, now: () => clock });
      manager.register(identity());

      const channel = { kind: 'TEAM', teamId: 'support' } as const;
      const joined = await manager.authorizeJoin('conn-1', channel);
      expect(joined.ok, 'the grant was not live even before it expired').toBe(true);
      manager.recordJoin('conn-1', 'team:support', channel);

      // Still inside the cover: revalidation changes nothing.
      const during = await manager.revalidateAll();
      expect(during.doomed).toEqual([]);
      expect(during.revoked, 'a live grant was revoked').toEqual([]);

      // The cover ends. No deactivation, no role change, no version bump.
      clock = new Date('2020-12-01T00:00:00.000Z');

      const after = await manager.revalidateAll();
      expect(
        after.doomed,
        'the socket was closed — the session is still perfectly valid, only this channel ' +
          'is no longer permitted',
      ).toEqual([]);
      expect(
        after.revoked,
        'an expired TEAM grant kept its room, and every queue arrival with it',
      ).toEqual([{ connectionId: 'conn-1', channelKey: 'team:support' }]);
    });

    it('REFUSES an employee whose grant does not cover that team', async () => {
      /**
       * The defect, stated plainly. `OUTSIDER` is an ordinary ACTIVE employee — the actor
       * map gives them no team and no grant — and before this they were admitted on the
       * strength of being an employee at all.
       */
      const { manager } = harness({ actors: inSupport() });
      manager.register(identity({ connectionId: 'other', principalId: OUTSIDER }));

      const result = await manager.authorizeJoin('other', { kind: 'TEAM', teamId: 'support' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('NOT_AUTHORIZED');
    });

    it('REFUSES a member of a DIFFERENT team', async () => {
      // Holding `queue.read` somewhere is not holding it here — the same property the HTTP
      // route asserts with two agents in two teams.
      const { manager } = harness({
        actors: new Map<UUID, ActorContext>([
          [
            OWNER,
            actor({
              teams: ['other-team'],
              departments: ['Service'],
              grants: [
                {
                  role: 'AGENT',
                  actions: ['queue.read'],
                  scopeKind: 'TEAM',
                  scopeId: 'other-team',
                  effectiveFrom: '2020-01-01T00:00:00.000Z',
                },
              ],
            }),
          ],
        ]),
      });
      manager.register(identity());

      expect((await manager.authorizeJoin('conn-1', { kind: 'TEAM', teamId: 'support' })).ok).toBe(
        false,
      );
    });

    it('refuses an unknown team exactly as it refuses a forbidden one', async () => {
      // §27.3 applied to team names: an existence oracle over the room list would let a
      // prober enumerate the organisation's teams.
      const { manager } = harness({ actors: inSupport() });
      manager.register(identity());

      const missing = await manager.authorizeJoin('conn-1', { kind: 'TEAM', teamId: 'no-such-team' });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toBe('NOT_AUTHORIZED');
    });
  });

  it('refuses anyone joining the control plane', async () => {
    const { manager } = harness();
    manager.register(identity());
    const result = await manager.authorizeJoin('conn-1', { kind: 'CONTROL' });
    expect(result.ok).toBe(false);
  });

  it('refuses a customer connection on their own principal channel', async () => {
    // Customers get conversation events only; notifications reach them by channel
    // adapters, not by subscribing to a staff-shaped feed.
    const { manager } = harness();
    manager.register(identity({ connectionId: 'cust', principalId: CUSTOMER, principalKind: 'CUSTOMER' }));
    const result = await manager.authorizeJoin('cust', { kind: 'PRINCIPAL', principalId: CUSTOMER });
    expect(result.ok).toBe(false);
  });
});

describe('rule 5 — staff-only events never reach a customer connection', () => {
  const event = (staffOnly: boolean): RealtimeEvent => ({
    eventId: crypto.randomUUID(),
    name: 'message.created.v1',
    channel: { kind: 'CONVERSATION', conversationId: CONVERSATION },
    seq: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    payload: { messageId: 'm-1' },
    staffOnly,
  });

  it('withholds a staff-only event from a customer who is legitimately in the room', async () => {
    // The subtle case: membership is CORRECT. The customer belongs on this channel.
    // The event is still one they must never see (§27.16).
    const { manager } = harness();
    manager.register(identity({ connectionId: 'cust', principalId: CUSTOMER, principalKind: 'CUSTOMER' }));
    expect(manager.mayReceive('cust', event(true))).toBe(false);
  });

  it('delivers a customer-visible event to the same connection', async () => {
    const { manager } = harness();
    manager.register(identity({ connectionId: 'cust', principalId: CUSTOMER, principalKind: 'CUSTOMER' }));
    expect(manager.mayReceive('cust', event(false))).toBe(true);
  });

  it('delivers staff-only events to staff', async () => {
    const { manager } = harness();
    manager.register(identity());
    expect(manager.mayReceive('conn-1', event(true))).toBe(true);
  });

  it('delivers nothing to an unknown connection', async () => {
    const { manager } = harness();
    expect(manager.mayReceive('ghost', event(false))).toBe(false);
  });
});

describe('connection bookkeeping', () => {
  it('tracks joined channels and forgets them on unregister', async () => {
    const { manager } = harness();
    manager.register(identity());
    manager.recordJoin('conn-1', 'conversation:x', { kind: 'CONVERSATION', conversationId: CONVERSATION });
    manager.recordJoin('conn-1', 'conversation:y', { kind: 'CONVERSATION', conversationId: CONVERSATION });
    expect(manager.channelsFor('conn-1')).toHaveLength(2);

    manager.recordLeave('conn-1', 'conversation:x');
    expect(manager.channelsFor('conn-1')).toEqual(['conversation:y']);

    manager.unregister('conn-1');
    expect(manager.connectionCount()).toBe(0);
    expect(manager.channelsFor('conn-1')).toEqual([]);
  });
});

/**
 * Regression: a customer can subscribe to their OWN conversation.
 *
 * `PgConversationAuthzReader` never set `belongsToActorCustomer`, and `decide()` refuses
 * a customer without it — so every customer subscribe was denied, including to a thread
 * they had just created. It failed CLOSED, which is why nothing looked broken: the
 * customer surface simply had no working socket, and would have stayed that way after
 * Redis arrived. The write path had the same shape of bug (ownership derived from the
 * wrong thing) and this is the second place it was hiding.
 *
 * Two things had to be true for a customer subscribe to work, and neither was:
 *   1. the resource must report ownership from LIVE PARTICIPATION, and
 *   2. the actor must carry the assurance from the SESSION that opened the socket —
 *      a customer whose assurance is missing reads as ANONYMOUS and is refused.
 */
describe('customer subscribes', () => {
  const CUSTOMER_ID = '018f2c5a-2222-7000-8000-0000000000c1' as UUID;
  const OTHER_CUSTOMER = '018f2c5a-2222-7000-8000-0000000000c2' as UUID;
  const CONVERSATION = '018f2c5a-2222-7000-8000-0000000000d9' as UUID;

  /** Mirrors what the Pg reader now returns: ownership from live customer participation. */
  const customerAuthz = (participantId: UUID) => ({
    async loadForAuthorization(_conversationId: UUID, principalId: UUID) {
      const isParticipant = principalId === participantId;
      return {
        conversationId: CONVERSATION,
        conversationType: 'CUSTOMER_SERVICE' as const,
        sensitivity: 'ORDINARY' as const,
        customerRef: 'CCS:customer:c-1',
        ...(isParticipant
          ? {
              participant: {
                role: 'CUSTOMER',
                replyAuthority: true,
                effectiveFrom: '2020-01-01T00:00:00.000Z',
              },
              belongsToActorCustomer: true,
            }
          : { belongsToActorCustomer: false }),
      };
    },
  });

  const customerManager = (participantId: UUID) =>
    new ConnectionManager({
      authz: customerAuthz(participantId),
      actorFor: async (principalId) => ({
        principalId,
        kind: 'CUSTOMER' as const,
        status: 'ACTIVE' as const,
        teams: [],
        departments: [],
        grants: [],
        delegations: [],
        temporaryGrants: [],
      }),
      sessionVersionFor: async () => 1,
      teamFor: async (teamId) => ({ teamId, department: 'Service' }),
    });

  it('lets a verified customer join their own conversation', async () => {
    const manager = customerManager(CUSTOMER_ID);
    manager.register({
      connectionId: 'sock-own',
      principalId: CUSTOMER_ID,
      principalKind: 'CUSTOMER',
      sessionVersion: 1,
      assurance: 'PSEUDONYMOUS',
    });

    const outcome = await manager.authorizeJoin('sock-own', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });

    expect(outcome.ok, 'a customer was refused their own conversation').toBe(true);
  });

  it('refuses a customer who is not a participant', async () => {
    const manager = customerManager(OTHER_CUSTOMER);
    manager.register({
      connectionId: 'sock-stranger',
      principalId: CUSTOMER_ID,
      principalKind: 'CUSTOMER',
      sessionVersion: 1,
      assurance: 'PSEUDONYMOUS',
    });

    const outcome = await manager.authorizeJoin('sock-stranger', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });

    expect(outcome.ok).toBe(false);
  });

  it('refuses a customer whose session carries no assurance', async () => {
    // The bug's other half. An assurance-less customer reads as ANONYMOUS, which is
    // below the bar a conversation needs to exist at — fail closed, not open.
    const manager = customerManager(CUSTOMER_ID);
    manager.register({
      connectionId: 'sock-anon',
      principalId: CUSTOMER_ID,
      principalKind: 'CUSTOMER',
      sessionVersion: 1,
    });

    const outcome = await manager.authorizeJoin('sock-anon', {
      kind: 'CONVERSATION',
      conversationId: CONVERSATION,
    });

    expect(outcome.ok).toBe(false);
  });

  it('still refuses a customer every non-conversation channel', async () => {
    const manager = customerManager(CUSTOMER_ID);
    manager.register({
      connectionId: 'sock-kind',
      principalId: CUSTOMER_ID,
      principalKind: 'CUSTOMER',
      sessionVersion: 1,
      assurance: 'VERIFIED_CUSTOMER',
    });

    for (const channel of [
      { kind: 'TEAM' as const, teamId: 'support' },
      { kind: 'PRINCIPAL' as const, principalId: CUSTOMER_ID },
      { kind: 'CONTROL' as const },
    ]) {
      const outcome = await manager.authorizeJoin('sock-kind', channel);
      expect(outcome.ok, JSON.stringify(channel)).toBe(false);
    }
  });
});
