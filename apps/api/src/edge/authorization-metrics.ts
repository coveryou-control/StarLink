/**
 * Counting authorization refusals (doc §32.4, §27.5).
 *
 * §32.4 asks for two alerts that both read one series:
 *
 *   * *"Refused privileged-read spike · Above baseline · Someone probing for access"*
 *   * and the same counter, unfiltered, for ordinary denial rates.
 *
 * `alerts.yml` implements the first as `PrivilegedReadRefusalSpike`, and until
 * 2026-08-29 `starlink_authz_refused_total` was declared and never written — so the alert
 * that watches for someone probing for access evaluated over no data and could not fire.
 *
 * ## Why this is not inside `decide()`
 *
 * `decide()` is the authorization boundary and it is a PURE function. Making it emit a
 * metric would give the security decision a dependency on the observability package, put
 * a side effect in the hottest path in the system, and — worst — make every unit test
 * that exercises the authorization matrix write to a live registry. The domain decides;
 * the edge reports. That separation is why `packages/conversation-domain` can be reasoned
 * about at all.
 *
 * ## Why the label is the ACTION and not the principal
 *
 * A label is a time series. `principalId` would mint one per person and turn a counter
 * into an unbounded cardinality problem, and it would put an identifier into a metrics
 * endpoint that §32.2 keeps free of them. "Which actions are being refused, and are any
 * of them privileged" is the question §27.5 actually asks — who was refused is the audit
 * ledger's answer, and the ledger already records privileged refusals.
 */
import { METRICS, metrics } from '@starlink/observability';
import type { Decision } from '@starlink/conversation-domain';

/**
 * Records a refusal and returns the decision unchanged, so a call site reads:
 *
 * ```ts
 * return recordDecision(action, decide({ actor, action, resource, now })).allow;
 * ```
 *
 * Pass-through rather than a separate statement on purpose. A helper that had to be
 * remembered as an extra line is a helper that gets forgotten at the next call site —
 * wrapping the expression means the metric travels with the decision.
 */
export function recordDecision(action: string, decision: Decision): Decision {
  if (!decision.allow) {
    metrics.increment(METRICS.authzRefused, 1, {
      action,
      // The alert selects on this: `starlink_authz_refused_total{privileged="true"}`.
      privileged: String(decision.privilegedAttempt),
    });
  }
  return decision;
}
