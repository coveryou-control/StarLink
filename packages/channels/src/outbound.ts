/**
 * The outbound half of the channel framework (INTEGRATION_CONTRACTS §9, §11; ADR-021).
 *
 * Two gates stand between a message and a provider, and neither is the adapter's to
 * decide. An adapter is a translation layer for one vendor's API; putting a policy check
 * inside it means the policy is only as good as the least careful adapter, and the whole
 * point of a framework is that the fourth adapter cannot be the one that forgets.
 *
 * ## Gate 1 — visibility (ADR-021, BR-26, and the rule that has no exceptions)
 *
 * A customer can never see an internal note. If visibility cannot be established, the
 * send fails. `OutboundChannelMessage` carries `visibility` so the check is possible;
 * §9's contract says the adapter "rejects non-CUSTOMER_VISIBLE by type", and it cannot —
 * TypeScript is erased at runtime and a field is not a proof. So the refusal happens
 * here, before the adapter is called at all, and the adapter's own check remains as the
 * layer behind it.
 *
 * ## Gate 2 — consent (Part IV §58)
 *
 * The consent contract's own header states the rule this enforces: "FAIL_CLOSED by
 * construction: if eligibility cannot be established, no new proactive outbound contact
 * happens. Channel availability is never permission — 'we can reach them' and 'we may
 * reach them' are different questions". And: "The check happens immediately before SEND,
 * not when the conversation was created, because consent can be withdrawn between those
 * two moments." That is why this function performs it rather than trusting a decision
 * some caller made earlier.
 *
 * An eligibility client that ERRORS refuses the send. A consent engine being down is not
 * permission to contact somebody.
 */
import type {
  CanonicalRef,
  ChannelAdapter,
  ConsentEligibilityClient,
  OutboundChannelMessage,
  ProviderAccept,
  Result,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

export interface OutboundIntent {
  /**
   * Purpose-bound, and passed through to the consent engine unchanged. §58's contract:
   * "possession of contact data is not permission for every use."
   */
  readonly purpose: string;
  /**
   * Which consent question this is.
   *
   * `REENGAGEMENT` — reaching a customer inside an existing conversation.
   * `PROACTIVE`    — new outbound contact, which needs the customer reference because it
   *                  is a question about the person rather than about the thread.
   */
  readonly kind: 'REENGAGEMENT' | 'PROACTIVE';
  readonly customerRef?: CanonicalRef;
}

export interface OutboundPorts {
  readonly consent: ConsentEligibilityClient;
}

/**
 * Sends one message on one channel, or refuses and says why.
 *
 * `idempotencyKey` is required, not optional: §9's `send` takes one because at-least-once
 * applies to outbound too, and a retry after an ambiguous provider response must not
 * produce a second message to a customer.
 */
export async function sendOnChannel(
  adapter: ChannelAdapter,
  message: OutboundChannelMessage,
  idempotencyKey: string,
  intent: OutboundIntent,
  ports: OutboundPorts,
): Promise<Result<ProviderAccept>> {
  if (message.visibility !== 'CUSTOMER_VISIBLE') {
    return err({
      code: 'OUTBOUND_VISIBILITY_REFUSED',
      message:
        'only CUSTOMER_VISIBLE messages may leave on a customer channel (ADR-021, BR-26)',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: message.messageId,
    });
  }

  if (intent.kind === 'PROACTIVE' && intent.customerRef === undefined) {
    // Not pedantry: without the reference the consent engine is being asked "may we
    // contact somebody" with the somebody left blank, and any answer to that is wrong.
    return err({
      code: 'OUTBOUND_CONSENT_SUBJECT_MISSING',
      message: 'proactive contact requires the customer reference the consent check is about',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: message.messageId,
    });
  }

  const eligibility =
    intent.kind === 'PROACTIVE'
      ? await ports.consent.checkOutbound({
          customerRef: intent.customerRef!,
          channel: adapter.channel,
          purpose: intent.purpose,
          ...(message.templateRef !== undefined ? { templateRef: message.templateRef } : {}),
        })
      : await ports.consent.checkReEngagement({
          conversationId: message.conversationId,
          channel: adapter.channel,
          purpose: intent.purpose,
        });

  if (!eligibility.ok) {
    // The engine could not answer. FAIL_CLOSED — see the header.
    return err({
      code: 'OUTBOUND_CONSENT_UNAVAILABLE',
      message: `consent eligibility could not be established: ${eligibility.error.code}`,
      retryable: true,
      failureClass: 'FAIL_CLOSED',
      correlationId: message.messageId,
    });
  }

  if (!eligibility.value.allowed) {
    return err({
      code: 'OUTBOUND_CONSENT_DENIED',
      message: eligibility.value.reason,
      // Not retryable: a withdrawn consent does not become granted by trying again, and
      // a retry loop against a refusal is how a customer who opted out gets contacted.
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: message.messageId,
    });
  }

  const accepted = await adapter.send(message, idempotencyKey);
  if (!accepted.ok) return accepted;
  return ok(accepted.value);
}
