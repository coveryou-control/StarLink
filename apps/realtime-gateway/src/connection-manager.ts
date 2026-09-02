/**
 * Realtime connection lifecycle and authorization (doc §20.10, §27.13).
 *
 * Deliberately free of Socket.IO. The rules below are the ones §38 records the
 * reference platform getting wrong, and they should be testable without opening a
 * socket — a security rule that can only be exercised through a transport is a rule
 * that mostly does not get exercised.
 *
 * The six rules, each mapped to the failure it prevents:
 *
 *   1. Authorize at join with the SAME decision as an HTTP read
 *      → a subscription becoming a back door around §18.4 step 3.
 *   2. Re-validate the session on every reconnect
 *      → a session revoked while disconnected quietly resuming.
 *   3. Close server-side when the session ends
 *      → a socket outliving its session, which is an authorization hole.
 *   4. Force out of the room when participation ends
 *      → continued delivery after access was revoked.
 *   5. Kind-check at publish
 *      → an internal note reaching a customer connection: the worst leak available.
 *   6. Identifiers, never bodies
 *      → a misrouted event disclosing content.
 */
import {
  decide,
  decideForTeam,
  type ActorContext,
  type TeamContext,
} from '@starlink/conversation-domain';
import type { ConversationAuthzReader } from '@starlink/database';
import type {
  Assurance,
  PrincipalKind,
  RealtimeChannel,
  RealtimeEvent,
  UUID,
} from '@starlink/shared-contracts';

export interface ConnectionIdentity {
  readonly connectionId: string;
  readonly principalId: UUID;
  readonly principalKind: PrincipalKind;
  /** Baked in at handshake; compared against the live principal to detect revocation. */
  readonly sessionVersion: number;
  /**
   * Customer assurance, taken from the SESSION that opened this socket.
   *
   * It cannot come from the principal record: assurance is a property of how this
   * person proved themselves in this session, not of who they are. Omitting it made
   * every customer read as ANONYMOUS to `decide()`, which then refused them their own
   * conversation — a socket that connected and could subscribe to nothing.
   */
  readonly assurance?: Assurance;
}

export type JoinRefusal =
  | 'NOT_AUTHORIZED'
  | 'UNKNOWN_CHANNEL'
  | 'SESSION_REVOKED'
  /** A customer connection may never join a team queue or the control channel. */
  | 'CHANNEL_FORBIDDEN_FOR_KIND';

export type JoinOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: JoinRefusal };

export interface RevalidationOutcome {
  /** Connections whose SESSION is no longer valid: close them. */
  readonly doomed: readonly string[];
  /** Channels a still-valid connection may no longer be in: leave them. */
  readonly revoked: readonly { readonly connectionId: string; readonly channelKey: string }[];
}

export interface ConnectionManagerDeps {
  readonly authz: ConversationAuthzReader;
  /** Builds the actor context; the same mapping the HTTP layer uses. */
  readonly actorFor: (principalId: UUID) => Promise<ActorContext | undefined>;
  /** Current session version for a principal; a mismatch means revoked. */
  readonly sessionVersionFor: (principalId: UUID) => Promise<number | undefined>;
  /**
   * The team a TEAM channel refers to, or undefined when there is no such team.
   *
   * Required, deliberately. The TEAM branch used to be a kind check — any employee could
   * join any team's room — while the HTTP routes over the same projection are gated by
   * `decideForTeam`. That is the §38 divergence this file's own docblock says it exists to
   * prevent, and an OPTIONAL dependency would let the next composition root reintroduce it
   * by forgetting to wire one.
   */
  readonly teamFor: (teamId: string) => Promise<TeamContext | undefined>;
  readonly now?: () => Date;
}

/**
 * Exhaustiveness at compile time, fail-closed at run time.
 *
 * `never` is what makes a missing case a type error; the runtime fallback is what covers
 * the build where a value arrives that the types said was impossible — a hand-built frame,
 * a version skew between gateway and contract. Both, because either alone has a hole.
 */
function assertNever<T>(_impossible: never, fallback: T): T {
  return fallback;
}

export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionIdentity>();
  /**
   * connectionId -> channel key -> the channel itself.
   *
   * The channel is kept, not just its key, so `revalidateAll` can re-run the SAME
   * `authorizeJoin` that admitted it. Storing only keys meant the periodic re-check could
   * compare session versions and nothing else — see the note there.
   */
  private readonly joined = new Map<string, Map<string, RealtimeChannel>>();
  private readonly now: () => Date;

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  register(identity: ConnectionIdentity): void {
    this.connections.set(identity.connectionId, identity);
    this.joined.set(identity.connectionId, new Map());
  }

  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
    this.joined.delete(connectionId);
  }

  get(connectionId: string): ConnectionIdentity | undefined {
    return this.connections.get(connectionId);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  channelsFor(connectionId: string): readonly string[] {
    return [...(this.joined.get(connectionId)?.keys() ?? [])];
  }

  /**
   * Has this connection actually JOINED the channel — not merely "could it".
   *
   * Typing and other client-originated signals are gated on this rather than on a fresh
   * `authorizeJoin`, for two reasons. It is cheaper (no database round trip per
   * keystroke), and more importantly it means a client cannot emit activity into a
   * conversation it never opened: claiming to be typing somewhere is a way to probe
   * which conversations exist and to plant a false signal in someone else's thread.
   */
  hasJoined(connectionId: string, channelKey: string): boolean {
    return this.joined.get(connectionId)?.has(channelKey) ?? false;
  }

  /**
   * Rule 5 for signals that are not domain events.
   *
   * Typing in an internal note is staff-only for the same reason the note is: it tells
   * a customer that someone is composing something they will never see, which is both a
   * false promise of a reply and a leak of internal activity timing.
   */
  isEmployeeConnection(connectionId: string): boolean {
    return this.connections.get(connectionId)?.principalKind === 'EMPLOYEE';
  }

  /**
   * Rule 1 and rule 2, together.
   *
   * The session is re-validated here rather than only at handshake, because a
   * long-lived socket outlives the moment it connected — and a reconnect after a
   * revocation is exactly the case that must not resume (§20.9).
   */
  async authorizeJoin(connectionId: string, channel: RealtimeChannel): Promise<JoinOutcome> {
    const identity = this.connections.get(connectionId);
    if (identity === undefined) return { ok: false, reason: 'SESSION_REVOKED' };

    const liveVersion = await this.deps.sessionVersionFor(identity.principalId);
    if (liveVersion === undefined || liveVersion !== identity.sessionVersion) {
      return { ok: false, reason: 'SESSION_REVOKED' };
    }

    // A customer connection has no business on a team queue or the control plane.
    // Checked by KIND before anything else is considered (§26.3 step 4's posture).
    if (identity.principalKind === 'CUSTOMER' && channel.kind !== 'CONVERSATION') {
      return { ok: false, reason: 'CHANNEL_FORBIDDEN_FOR_KIND' };
    }

    switch (channel.kind) {
      case 'PRINCIPAL':
        // Your own notifications, and nobody else's.
        if (channel.principalId !== identity.principalId) return { ok: false, reason: 'NOT_AUTHORIZED' };
        break;

      case 'CONVERSATION': {
        const at = this.now().toISOString();
        const resource = await this.deps.authz.loadForAuthorization(
          channel.conversationId,
          identity.principalId,
          at,
        );
        // Absent and forbidden are the same answer — existence is not disclosed (§27.3).
        if (resource === undefined) return { ok: false, reason: 'NOT_AUTHORIZED' };

        const resolved = await this.deps.actorFor(identity.principalId);
        if (resolved === undefined) return { ok: false, reason: 'NOT_AUTHORIZED' };

        // Assurance comes from the SESSION, not the principal record — the same value
        // the HTTP guard read from the same cookie. Without it a verified customer
        // arrives at `decide()` looking anonymous.
        const actor =
          identity.assurance !== undefined ? { ...resolved, assurance: identity.assurance } : resolved;

        // THE SAME decision an HTTP read would make. Not a parallel implementation —
        // §38 records two authorization paths diverging as a defect in the reference
        // platform, and this is where that divergence would start.
        const decision = decide({
          actor,
          action: 'conversation.read',
          resource,
          now: at,
          /**
           * A subscribe must never grant more than the HTTP read of the same thread.
           * The customer message endpoint is scoped by participation alone, and a
           * conversation cannot exist below PSEUDONYMOUS, so that is the exact bar.
           * Leaving it to `decide()`'s VERIFIED_CUSTOMER default would refuse every
           * customer we have — no customer master exists yet, so a proved contact
           * detail yields PSEUDONYMOUS and nothing higher.
           */
          ...(identity.principalKind === 'CUSTOMER'
            ? { requiredAssurance: 'PSEUDONYMOUS' as const }
            : {}),
        });
        if (!decision.allow) return { ok: false, reason: 'NOT_AUTHORIZED' };
        break;
      }

      case 'TEAM': {
        if (identity.principalKind !== 'EMPLOYEE') return { ok: false, reason: 'NOT_AUTHORIZED' };

        /**
         * THE SAME decision `GET /queues/:teamId` makes — see the note on the CONVERSATION
         * branch above, which this now mirrors.
         *
         * This was the kind check alone: `channel.teamId` was compared to nothing, so any
         * authenticated employee could subscribe to any team's room. That room carries
         * `conversation.queue.arrived.v1`, whose payload is field-for-field what the HTTP
         * queue endpoint returns — so gating the HTTP route and not this one left two
         * authorization answers for one projection, which is precisely the divergence §38
         * records as the reference platform's defect.
         *
         * `decideForTeam` applies the existing scope kinds to a team; no new permission and
         * no second model. An unknown team refuses exactly as a forbidden one does (§27.3).
         */
        const team = await this.deps.teamFor(channel.teamId);
        if (team === undefined) return { ok: false, reason: 'NOT_AUTHORIZED' };

        const actor = await this.deps.actorFor(identity.principalId);
        if (actor === undefined) return { ok: false, reason: 'NOT_AUTHORIZED' };

        const decision = decideForTeam({
          actor,
          action: 'queue.read',
          team,
          now: this.now().toISOString(),
        });
        if (!decision.allow) return { ok: false, reason: 'NOT_AUTHORIZED' };
        break;
      }

      case 'CONTROL':
        // Nobody subscribes to the control plane; the gateway consumes it itself.
        return { ok: false, reason: 'CHANNEL_FORBIDDEN_FOR_KIND' };

      default:
        /**
         * Rule 4, restored: an unknown channel is DENIED, never unrestricted.
         *
         * This switch had no default and fell through to the `return { ok: true }` below,
         * so any channel kind not listed above was joinable by anyone. `'UNKNOWN_CHANNEL'`
         * was declared in `JoinRefusal` and produced nowhere in the repository — the
         * fail-closed default had been intended and lost.
         *
         * Unreachable today only because `parseChannel` emits exactly these four kinds.
         * That is a property of a different file, which is precisely the kind of guarantee
         * that stops holding without anyone noticing: the next channel kind added is
         * subscribable by every connected principal, by default, silently.
         *
         * `assertNever` makes it a COMPILE error too, so a new kind added to
         * `RealtimeChannel` cannot reach production without a decision being written here.
         */
        return assertNever(channel, { ok: false, reason: 'UNKNOWN_CHANNEL' });
    }

    return { ok: true };
  }

  recordJoin(connectionId: string, channelKey: string, channel: RealtimeChannel): void {
    this.joined.get(connectionId)?.set(channelKey, channel);
  }

  recordLeave(connectionId: string, channelKey: string): void {
    this.joined.get(connectionId)?.delete(channelKey);
  }

  /**
   * Rule 5: an event marked staff-only must never reach a customer connection.
   *
   * Applied at publish rather than at subscribe, because membership can be correct and
   * the event still be one a customer must not see — SLA state, escalation, priority
   * and internal notes all travel on the conversation channel a customer legitimately
   * occupies (§27.16).
   */
  mayReceive(connectionId: string, event: RealtimeEvent): boolean {
    const identity = this.connections.get(connectionId);
    if (identity === undefined) return false;
    if (!event.staffOnly) return true;
    return identity.principalKind === 'EMPLOYEE';
  }

  /**
   * Rule 3: every connection for a principal whose session ended.
   *
   * Returns the ids so the transport can close them. Closing is the transport's job;
   * deciding who must close is this class's.
   */
  connectionsToRevoke(principalId: UUID): readonly string[] {
    const doomed: string[] = [];
    for (const [connectionId, identity] of this.connections) {
      if (identity.principalId === principalId) doomed.push(connectionId);
    }
    return doomed;
  }

  /**
   * Rule 2, applied on a timer as well as on reconnect.
   *
   * A revocation raised on another node arrives over the control channel, but a
   * gateway that only ever learned about revocation from an event would keep a socket
   * alive indefinitely if that event were lost. Re-checking is the belt to that braces.
   */
  async revalidateAll(): Promise<RevalidationOutcome> {
    const doomed: string[] = [];
    const revoked: { connectionId: string; channelKey: string }[] = [];

    for (const [connectionId, identity] of this.connections) {
      const liveVersion = await this.deps.sessionVersionFor(identity.principalId);
      if (liveVersion === undefined || liveVersion !== identity.sessionVersion) {
        doomed.push(connectionId);
        // No point re-authorizing channels on a socket that is about to be closed.
        continue;
      }

      /**
       * Rule 4 of this file's own docblock — "force out of the room when participation
       * ends" — which nothing implemented.
       *
       * The periodic check compared session versions and stopped there, and a version is
       * bumped only by deactivation, a role change or a customer's assurance raise. It is
       * NOT bumped when a grant simply EXPIRES, when participation is dated out, or when
       * ownership moves: no sweep exists that touches it. So access that had lapsed by
       * every measure `decide()` uses kept receiving events for as long as the tab stayed
       * open — an unbounded window, not a 60-second one, because reconnecting is what
       * re-authorized.
       *
       * Concretely: a lead holding a TEAM-scoped `queue.read` that ends at 17:00 subscribes
       * at 16:55. At 17:01 the HTTP queue route returns 404 and the socket is still being
       * fed every arrival in that queue.
       *
       * Re-running `authorizeJoin` is deliberately the same call that admitted the channel
       * rather than a cheaper approximation of it — a second, cheaper rule is how the two
       * come to disagree (§38).
       */
      for (const [channelKey, channel] of this.joined.get(connectionId) ?? []) {
        const decision = await this.authorizeJoin(connectionId, channel);
        if (!decision.ok) revoked.push({ connectionId, channelKey });
      }
    }

    return { doomed, revoked };
  }
}
