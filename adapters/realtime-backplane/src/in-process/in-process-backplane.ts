/**
 * In-process realtime backplane.
 *
 * Correct for ONE node. Every subscriber lives in this process, so `publish` reaches
 * them all — which is exactly what makes it useless for production and honest for
 * development: it satisfies the contract without pretending to solve fan-out.
 *
 * **What this cannot do**, and why Part IV §52 makes a shared backplane a production
 * baseline: a client connected to gateway A will not receive an event published on
 * gateway B. There is no way to fake that in-process, and no attempt is made to.
 * `health()` reports `authority: 'MOCK'` and `detail` says so, so an operator reading
 * a readiness probe cannot mistake a single-node deployment for a clustered one.
 *
 * The Redis implementation is a drop-in sibling; nothing outside this directory
 * changes when it arrives.
 */
import type {
  HealthReport,
  RealtimeBackplane,
  RealtimeChannel,
  RealtimeEvent,
  RealtimeSubscriber,
  Result,
} from '@starlink/shared-contracts';
import { channelKey, ok } from '@starlink/shared-contracts';

export interface InProcessBackplaneOptions {
  /** Called when a subscriber throws, so one bad handler cannot stop the fan-out. */
  readonly onSubscriberError?: (error: unknown, channel: string) => void;
}

export class InProcessBackplane implements RealtimeBackplane {
  private readonly channels = new Map<string, Set<RealtimeSubscriber>>();

  constructor(private readonly options: InProcessBackplaneOptions = {}) {}

  async publish(event: RealtimeEvent): Promise<Result<void>> {
    const key = channelKey(event.channel);
    const subscribers = this.channels.get(key);
    if (subscribers === undefined) return ok(undefined);

    // Iterate a copy: a subscriber may unsubscribe while being notified (a client
    // disconnecting mid-fan-out is ordinary, not exceptional).
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        // One failing socket must not stop delivery to the rest. Realtime is
        // best-effort by design — the message is already durable (P-05).
        this.options.onSubscriberError?.(error, key);
      }
    }
    return ok(undefined);
  }

  async subscribe(channel: RealtimeChannel, subscriber: RealtimeSubscriber): Promise<Result<() => void>> {
    const key = channelKey(channel);
    const existing = this.channels.get(key) ?? new Set<RealtimeSubscriber>();
    existing.add(subscriber);
    this.channels.set(key, existing);

    return ok(() => {
      const set = this.channels.get(key);
      if (set === undefined) return;
      set.delete(subscriber);
      // Drop the empty set so a long-lived process does not accumulate one entry per
      // conversation ever opened.
      if (set.size === 0) this.channels.delete(key);
    });
  }

  localSubscriberCount(): number {
    let total = 0;
    for (const subscribers of this.channels.values()) total += subscribers.size;
    return total;
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'UP',
      authority: 'MOCK',
      checkedAt: new Date().toISOString(),
      // Stated in the health payload so a single-node deployment is visible in
      // operations, not just in a document (Part IV §52).
      detail: 'in-process backplane: single node only, no cross-instance fan-out',
    };
  }
}
