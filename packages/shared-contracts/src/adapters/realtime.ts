/**
 * Realtime backplane contract (ADR-005, doc §20, Part IV §52).
 *
 * The governing rule for everything downstream of this file:
 *
 *     REALTIME IS FOR EXPERIENCE. DURABLE STATE IS FOR CORRECTNESS.
 *
 * Nothing here is a source of truth. A client that missed every event must still be
 * correct after a reload (FR-RT-1), which is why events carry IDENTIFIERS and a
 * sequence — never message bodies — and why recovery is a re-read rather than a replay
 * (§20.3). There is deliberately no replay buffer: it would need retention, ordering
 * guarantees and its own authorization check on every buffered event — three new ways
 * to be wrong, to save one HTTP request (§20.8).
 *
 * The backplane exists because fan-out must cross process boundaries: a client
 * connected to gateway A must receive an event published on gateway B (Part IV §52).
 * A single-process implementation satisfies this interface for development; a
 * Redis-backed one satisfies it in production. Neither is visible to the domain.
 */
import type { Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

/**
 * A channel is an authorization unit, not a topic.
 *
 * Rooms map onto conversations because that is already what access is decided against
 * (§20.6), so "who receives this" reduces to "who is joined", and the join is where
 * the scope check goes.
 */
export type RealtimeChannel =
  /** One conversation. Joined only after the same decision an HTTP read would make. */
  | { readonly kind: 'CONVERSATION'; readonly conversationId: UUID }
  /** One principal's own notifications. Never joined by anyone else. */
  | { readonly kind: 'PRINCIPAL'; readonly principalId: UUID }
  /** A team's queue view. Joined on team scope, not conversation participation. */
  | { readonly kind: 'TEAM'; readonly teamId: string }
  /**
   * Control plane. Carries session revocation so a socket dies with its session
   * (§27.13) — the hole that "resume the old connection" designs leave open.
   */
  | { readonly kind: 'CONTROL' };

export const channelKey = (channel: RealtimeChannel): string => {
  switch (channel.kind) {
    case 'CONVERSATION':
      return `conversation:${channel.conversationId}`;
    case 'PRINCIPAL':
      return `principal:${channel.principalId}`;
    case 'TEAM':
      return `team:${channel.teamId}`;
    case 'CONTROL':
      return 'control';
  }
};

/**
 * What travels over the wire.
 *
 * `payload` is bounded to identifiers and classifications by convention AND by the
 * event catalogue it mirrors — a misrouted event must disclose nothing (FR-RT-4).
 */
export interface RealtimeEvent {
  readonly eventId: UUID;
  readonly name: string;
  readonly channel: RealtimeChannel;
  /**
   * Per-conversation monotonic sequence, where the channel has one.
   *
   * The client applies `seq == last + 1`, discards `<= last` as a duplicate, and
   * RE-FETCHES on a gap rather than interpolating (§20.8). Global ordering is not
   * attempted and is not needed: nothing in the product compares two conversations'
   * timelines.
   */
  readonly seq?: number;
  readonly occurredAt: Timestamp;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Staff-only events (internal notes, SLA, escalation, priority) are marked so the
   * gateway can refuse to fan them out to a customer connection at publish time — the
   * worst leak available in the product (§27.16, §20.10).
   */
  readonly staffOnly: boolean;
}

export type RealtimeSubscriber = (event: RealtimeEvent) => void;

export interface RealtimeBackplane extends HealthReporting {
  /**
   * Publishes to every gateway node, including this one.
   *
   * Called ONLY by the outbox relay after commit, never inline by domain code — the
   * ordering that makes "persist before publish" true (P-05, ADR-006).
   */
  publish(event: RealtimeEvent): Promise<Result<void>>;

  /** Delivers events for `channel` to this node. Returns an unsubscribe function. */
  subscribe(channel: RealtimeChannel, subscriber: RealtimeSubscriber): Promise<Result<() => void>>;

  /**
   * Connected-socket count for this node, for the `active_websocket_connections`
   * metric and the reconnect-storm alert (§32.3).
   */
  localSubscriberCount(): number;
}

/**
 * Presence and typing (doc §20.2, §21.9, §35 of the brief).
 *
 * Ephemeral by design and NEVER authoritative employee availability: "a phone entering
 * a lift is not leave" (§21.9). Availability is declared or derived from the business
 * calendar; presence is a hint. Losing this store degrades experience and must not
 * damage conversation truth, which is why it is a separate interface that can fail
 * independently.
 */
export type PresenceState = 'ONLINE' | 'AWAY' | 'BUSY' | 'OFFLINE';

export interface PresenceRecord {
  readonly principalId: UUID;
  readonly state: PresenceState;
  readonly expiresAt: Timestamp;
}

export interface PresenceStore extends HealthReporting {
  /** Leases expire on their own, so a crashed node cannot leave someone online forever. */
  heartbeat(principalId: UUID, state: PresenceState, ttlSeconds: number): Promise<Result<void>>;
  clear(principalId: UUID): Promise<Result<void>>;
  get(principalIds: readonly UUID[]): Promise<Result<readonly PresenceRecord[]>>;
  /** Typing is the most ephemeral signal there is; it expires in seconds and is stored nowhere durable. */
  setTyping(conversationId: UUID, principalId: UUID, ttlSeconds: number): Promise<Result<void>>;
  getTyping(conversationId: UUID): Promise<Result<readonly UUID[]>>;
}
