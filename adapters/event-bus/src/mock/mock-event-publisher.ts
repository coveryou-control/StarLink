/**
 * In-memory event publisher.
 *
 * Called ONLY by the outbox relay (ADR-006). Domain code never publishes inline: it
 * writes an outbox row in the same transaction as its state change, and the relay
 * publishes after commit. That ordering is what makes a committed business fact and
 * its event unable to drift.
 *
 * The mock validates every envelope against the catalogue before accepting it, because
 * an event that would be rejected by CCS in Phase 10 should be rejected in Phase 1 —
 * discovering a malformed payload at integration time is the expensive version.
 */
import type { DomainEventEnvelope, EventPublisher, HealthReport, Result } from '@starlink/shared-contracts';
import { err, isKnownEvent, ok, validateEventPayload } from '@starlink/shared-contracts';

export class MockEventPublisher implements EventPublisher {
  private readonly published: DomainEventEnvelope[] = [];
  private failNext = 0;
  private failPredicate?: (event: DomainEventEnvelope) => boolean;

  /** Test seam: make the next `count` publish calls fail, to exercise relay retry. */
  failNextPublishes(count: number): void {
    this.failNext = count;
  }

  /**
   * Test seam: fail only the events matching `predicate`.
   *
   * Preferred over `failNextPublishes` whenever the suite may be producing other
   * traffic concurrently — a count-based failure hits whichever event arrives first,
   * which makes the test depend on scheduling rather than on behaviour.
   */
  failWhen(predicate: (event: DomainEventEnvelope) => boolean): void {
    this.failPredicate = predicate;
  }

  async publish(events: readonly DomainEventEnvelope[]): Promise<Result<void>> {
    const matchesFailure = this.failPredicate !== undefined && events.some(this.failPredicate);
    if (this.failNext > 0 || matchesFailure) {
      if (this.failNext > 0) this.failNext -= 1;
      return err({
        code: 'EVENT_BUS_UNAVAILABLE',
        message: 'publish failed',
        retryable: true,
        // The relay retries; the business fact is already committed and is not at risk.
        failureClass: 'FAIL_QUEUED',
        correlationId: events[0]?.correlationId ?? 'unknown',
      });
    }

    for (const event of events) {
      if (!isKnownEvent(event.name)) {
        return err({
          code: 'UNKNOWN_EVENT',
          message: `event ${event.name} is not in the catalogue`,
          retryable: false,
          failureClass: 'FAIL_QUEUED',
          correlationId: event.correlationId,
        });
      }
      try {
        validateEventPayload(event.name, event.payload);
      } catch (cause) {
        return err({
          code: 'INVALID_EVENT_PAYLOAD',
          message: `event ${event.name} failed schema validation`,
          retryable: false,
          failureClass: 'FAIL_QUEUED',
          correlationId: event.correlationId,
          detail: { event: event.name },
        });
      }
    }

    this.published.push(...events);
    return ok(undefined);
  }

  /** Test helper. */
  publishedEvents(name?: string): readonly DomainEventEnvelope[] {
    return name === undefined ? this.published : this.published.filter((e) => e.name === name);
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}
