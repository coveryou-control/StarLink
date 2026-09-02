/**
 * In-process presence and typing.
 *
 * Presence is ephemeral and never authoritative availability (§21.9, brief §35). Two
 * properties are modelled here rather than deferred to the Redis implementation,
 * because they are behavioural and the tests should hold for both:
 *
 *   * **Leases expire.** A crashed node must not leave someone ONLINE forever. Expiry
 *     is evaluated on read from the clock, so no sweep job's failure can extend it —
 *     the same discipline as authorization grants (§17.3).
 *   * **Losing this store costs nothing durable.** Everything here can vanish and the
 *     conversation record is untouched (brief §43 invariant: Redis loss degrades
 *     safely).
 */
import type {
  HealthReport,
  PresenceRecord,
  PresenceState,
  PresenceStore,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { ok } from '@starlink/shared-contracts';

interface Lease {
  readonly state: PresenceState;
  readonly expiresAtMs: number;
}

export interface InProcessPresenceOptions {
  readonly now?: () => number;
}

export class InProcessPresence implements PresenceStore {
  private readonly presence = new Map<UUID, Lease>();
  /** conversationId -> principalId -> expiry */
  private readonly typing = new Map<UUID, Map<UUID, number>>();
  private readonly now: () => number;

  constructor(options: InProcessPresenceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async heartbeat(principalId: UUID, state: PresenceState, ttlSeconds: number): Promise<Result<void>> {
    this.presence.set(principalId, { state, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return ok(undefined);
  }

  async clear(principalId: UUID): Promise<Result<void>> {
    this.presence.delete(principalId);
    return ok(undefined);
  }

  async get(principalIds: readonly UUID[]): Promise<Result<readonly PresenceRecord[]>> {
    const at = this.now();
    const records: PresenceRecord[] = [];

    for (const principalId of principalIds) {
      const lease = this.presence.get(principalId);
      // Expiry read from the clock, not from a sweep having run. An absent or lapsed
      // lease reads as OFFLINE — the safe answer, since presence never grants anything.
      if (lease === undefined || lease.expiresAtMs <= at) {
        records.push({ principalId, state: 'OFFLINE', expiresAt: new Date(at).toISOString() });
        continue;
      }
      records.push({
        principalId,
        state: lease.state,
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
      });
    }
    return ok(records);
  }

  async setTyping(conversationId: UUID, principalId: UUID, ttlSeconds: number): Promise<Result<void>> {
    const room = this.typing.get(conversationId) ?? new Map<UUID, number>();
    room.set(principalId, this.now() + ttlSeconds * 1000);
    this.typing.set(conversationId, room);
    return ok(undefined);
  }

  async getTyping(conversationId: UUID): Promise<Result<readonly UUID[]>> {
    const at = this.now();
    const room = this.typing.get(conversationId);
    if (room === undefined) return ok([]);

    const active: UUID[] = [];
    for (const [principalId, expiresAt] of room) {
      if (expiresAt > at) active.push(principalId);
      else room.delete(principalId);
    }
    if (room.size === 0) this.typing.delete(conversationId);
    return ok(active);
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'UP',
      authority: 'MOCK',
      checkedAt: new Date().toISOString(),
      detail: 'in-process presence: not shared across nodes',
    };
  }
}
