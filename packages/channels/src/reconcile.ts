/**
 * Delivery-status reconciliation (INTEGRATION_CONTRACTS §9, Part IV §53).
 *
 * §9's rule: **"`UNKNOWN` delivery triggers reconciliation, never optimistic success."**
 * The contract makes `UNKNOWN` a first-class `DeliveryStatus` for that reason — a
 * provider that returns an ambiguous result has told us it does not know, and recording
 * that as DELIVERED converts an unknown into a lie that nothing will ever correct.
 *
 * Reconciliation is how an unknown resolves: ask the provider again, later, about the
 * window it was unsure of. `ChannelAdapter.reconcile(since)` is the provider-specific
 * half; this is the driver over however many adapters are registered.
 */
import type {
  ChannelAdapter,
  DeliveryStatusUpdate,
  ReconciliationReport,
  Timestamp,
} from '@starlink/shared-contracts';

/**
 * Classifies one provider status event.
 *
 * Separated from applying it because the decision is the part worth testing: everything
 * except a recognised terminal status needs a second look, and the default direction is
 * "check again", never "assume it worked".
 */
export function needsReconciliation(update: DeliveryStatusUpdate): boolean {
  return update.status === 'UNKNOWN';
}

export interface ChannelReconcileResult {
  readonly channel: string;
  readonly report?: ReconciliationReport;
  /** Set where the adapter could not reconcile. The unknowns stay unknown. */
  readonly errorCode?: string;
}

/**
 * Runs one reconciliation pass over every registered adapter.
 *
 * An adapter that fails does not stop the others — one provider's outage is not a reason
 * to leave a second provider's unknowns unresolved. The failure is reported rather than
 * thrown, so a caller can publish it: `stillUnknown` climbing is the signal that matters,
 * and it can only be seen if a failed pass is distinguishable from a clean one.
 */
export async function reconcileChannels(
  adapters: readonly ChannelAdapter[],
  since: Timestamp,
): Promise<readonly ChannelReconcileResult[]> {
  const results: ChannelReconcileResult[] = [];
  for (const adapter of adapters) {
    try {
      const report = await adapter.reconcile(since);
      results.push(
        report.ok
          ? { channel: adapter.channel, report: report.value }
          : { channel: adapter.channel, errorCode: report.error.code },
      );
    } catch (error) {
      results.push({
        channel: adapter.channel,
        errorCode: error instanceof Error ? error.name : 'RECONCILE_THREW',
      });
    }
  }
  return results;
}
