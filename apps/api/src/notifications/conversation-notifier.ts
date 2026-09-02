/**
 * §29.2's table, as callable operations (doc §29.2, §23.6).
 *
 * Everything that causes a notification — a transfer, an escalation, a customer's reply,
 * an SLA stage — calls a method here rather than assembling a `NotifyRequest` itself.
 * That is not indirection for its own sake: §29.2 addresses ROLES ("Owner", "Both
 * parties", "Owner, then lead"), and resolving a role is a decision, not a parameter. A
 * caller that passes a principal id has already made that decision, usually from
 * whatever it happened to have in hand — which, at a transfer, is as likely to be the
 * previous owner as the current one.
 *
 * ## Nothing here can fail its caller
 *
 * §29.3: "An adapter that is absent, misconfigured or failing costs a NOTIFICATION. It
 * never costs a MESSAGE." Every method resolves recipients, writes outbox rows and
 * returns. `NotificationService.notify` swallows and logs its own failures; the recipient
 * lookups are the only thing that could throw, so they are wrapped here for the same
 * reason. A transfer that completed has completed whether or not anyone was told.
 *
 * ## What is deliberately not here
 *
 * §29.2's two team-scope rows — "cover needed on your team" and "a new conversation in
 * your team's queue" — and they are absent because the document routes them elsewhere,
 * not because a recipient model is missing.
 *
 * §20.7 defines a **`Queue arrival`** event: publisher Routing, received by the **team
 * room**, authorized by "team scope at join, not conversation participation", with
 * "queue read on load" as its fallback. §20.2 agrees the event is live because "a queue
 * that needs refreshing is a queue that grows". So §29.2's "Team | In-app" is the QUEUE
 * VIEW refreshing — not a notification per member. Fanning out was never the design; the
 * earlier note here rejected it for the right outcome and the wrong reason.
 *
 * `COVER_NEEDED` is additionally blocked on **D-05**. UC-E07: "System detects
 * unavailability → surfaces to the team as needing cover", and its own dependency note —
 * "this is the only justification for a presence system (§20.2). If D-05 is answered
 * 'named backup' or 'lead reassigns', a human decides and no presence tracking is
 * needed." Nothing can detect the condition until that is answered.
 *
 * The team-room publish itself is unbuilt (N-27) — the channel exists and is joinable,
 * and nothing writes to it.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { LOGGER } from '../tokens.js';
import { NotificationService } from './notification-service.js';
import { NotificationRecipients } from './recipients.js';

@Injectable()
export class ConversationNotifier {
  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(NotificationRecipients) private readonly recipients: NotificationRecipients,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** §29.2: "A customer conversation assigned to you | Owner | In-app + external if away". */
  async assigned(conversationId: UUID, principalId: UUID): Promise<void> {
    await this.tell('assigned', conversationId, async () => {
      await this.notifyEmployee('CONVERSATION_ASSIGNED', principalId, conversationId);
    });
  }

  /**
   * §29.2: "A conversation transferred to/from you | Both parties | In-app + external".
   *
   * Both, and separately — the outgoing owner needs to know the work has left them as
   * much as the incoming one needs to know it has arrived. Sending only to the receiver
   * is the version that looks correct in a demo and loses work in practice.
   */
  async transferred(conversationId: UUID, from: UUID | undefined, to: UUID): Promise<void> {
    await this.tell('transferred', conversationId, async () => {
      await this.notifyEmployee('TRANSFERRED', to, conversationId);
      if (from !== undefined && from !== to) {
        await this.notifyEmployee('TRANSFERRED', from, conversationId);
      }
    });
  }

  /**
   * §29.2: "A conversation escalated to your function | Receiving officer, lead |
   * In-app + external".
   */
  async escalated(conversationId: UUID, receivingOfficer: UUID): Promise<void> {
    await this.tell('escalated', conversationId, async () => {
      const at = new Date().toISOString() as Timestamp;
      await this.notifyEmployee('ESCALATED_TO_YOUR_FUNCTION', receivingOfficer, conversationId);
      for (const lead of await this.recipients.leadsFor(conversationId, at)) {
        if (lead === receivingOfficer) continue;
        await this.notifyEmployee('ESCALATED_TO_YOUR_FUNCTION', lead, conversationId);
      }
    });
  }

  /**
   * §29.2: "A customer replied on a conversation you own | Owner | In-app + external if
   * away".
   *
   * The five-messages-in-a-row case (§29.5) needs nothing special here: five calls in
   * the dedupe window fold into one row whose count reaches five, because the window is
   * part of the key and the fold is an UPDATE on the waiting row. Coalescing in the
   * database rather than in a buffer means a crash between the first message and the
   * fifth cannot lose the notification.
   */
  async customerReplied(conversationId: UUID): Promise<void> {
    await this.tell('customer_replied', conversationId, async () => {
      const owner = await this.recipients.ownerOf(conversationId);
      // Unowned is normal — the conversation is in a queue and the queue view shows it.
      // There is nobody to tell, which is different from failing to tell somebody.
      if (owner === undefined) return;
      await this.notifyEmployee('CUSTOMER_REPLIED', owner, conversationId);
    });
  }

  /**
   * §29.2: "A customer's conversation was answered / resolved | Customer | Customer's
   * channel". BR-20: "The customer is told the conversation was resolved, and why."
   *
   * ## This resolves to no channel today, and that is not the same as being unbuilt
   *
   * `channelsFor` returns an empty list for a CUSTOMER recipient, so this writes nothing.
   * The reason is prerequisites, not the decision: D-12 chose email on 2026-08-28, and
   * neither a durable customer email address (D-31) nor a configured provider (N-07)
   * exists. Enqueuing against a channel with neither would accumulate undeliverable rows
   * about customers indefinitely.
   *
   * The call site is here anyway, because it is the thing that was actually missing.
   * §29.2's row had no caller at all: even when D-31 and N-07 land, a resolution would
   * have notified nobody, and the gap would have been invisible — an absent notification
   * generates no error and nobody complains about one they did not receive. With this in
   * place, the customer row opens in the same change that gives it an address.
   *
   * **The customer is not left uninformed in the meantime.** BR-20 is served by the
   * conversation itself: `toCustomerStatus` maps RESOLVED to "Resolved" and §22.5's
   * "Outcome only" is returned on their own conversation. The notification is the PUSH;
   * the projection is the fact.
   */
  async resolved(conversationId: UUID): Promise<void> {
    await this.tell('resolved', conversationId, async () => {
      const at = new Date().toISOString() as Timestamp;
      const customer = await this.recipients.customerOf(conversationId, at);
      // An internal conversation has no customer, and §21.4/BR-23 gives it no lifecycle
      // to resolve either — so this is unreachable rather than merely empty. Guarded
      // because "unreachable" is a claim about today's callers.
      if (customer === undefined) return;

      await this.notifications.notify({
        event: 'CUSTOMER_CONVERSATION_ANSWERED',
        recipientId: customer,
        recipientKind: 'CUSTOMER',
        targetRef: conversationId,
        // A customer has no in-app badge to miss and no employee preferences row.
        away: false,
        optedOutOf: [],
      });
    });
  }

  /**
   * §23.6's warning and breach stages, both of which are §29.2's "waiting beyond a
   * service standard" row.
   *
   * The warning is a "quiet nudge" to the owner alone; the breach reaches the owner and
   * the team lead. §23.6, in capitals in the source: "THE CUSTOMER IS NOT NOTIFIED OF ANY
   * OF THIS. A breach is our failure to manage, not news to deliver." Nothing here can
   * reach a customer — every recipient is resolved from an employee role.
   */
  async waitingBeyondStandard(
    conversationId: UUID,
    stage: 'WARNING' | 'BREACH',
    clock: string,
  ): Promise<void> {
    await this.tell('waiting_beyond_standard', conversationId, async () => {
      const at = new Date().toISOString() as Timestamp;
      const owner = await this.recipients.ownerOf(conversationId);
      /**
       * The discriminator matters here and nowhere else.
       *
       * A case that is already past its target when it becomes routable can warn and
       * breach on consecutive ticks. Without the stage in the key, the second would land
       * inside the first's dedupe window and be suppressed — the owner would get the
       * nudge and never the breach, which is the wrong one to lose.
       */
      const discriminator = `${clock}:${stage}`;

      if (owner !== undefined) {
        await this.notifyEmployee('WAITING_BEYOND_STANDARD', owner, conversationId, discriminator);
      }
      if (stage === 'BREACH') {
        for (const lead of await this.recipients.leadsFor(conversationId, at)) {
          if (lead === owner) continue;
          await this.notifyEmployee('WAITING_BEYOND_STANDARD', lead, conversationId, discriminator);
        }
      }
    });
  }

  /**
   * §29.2: "A role or access change affecting you | The principal | In-app + external".
   *
   * Not conversation-scoped, so there is no target reference and no deep link — the
   * change is about the person, not about a thread.
   */
  async roleOrAccessChanged(principalId: UUID, what: string): Promise<void> {
    try {
      await this.notifications.notify({
        event: 'ROLE_OR_ACCESS_CHANGED',
        recipientId: principalId,
        recipientKind: 'EMPLOYEE',
        away: await this.recipients.isAway(principalId),
        optedOutOf: await this.recipients.optedOutOf(principalId),
        // The KIND of change, never the grant itself: a notification is not a channel for
        // access facts, and the directory is where those are read.
        payload: { change: what },
        dedupeDiscriminator: what,
      });
    } catch (error) {
      this.logFailure('role_or_access_changed', principalId, error);
    }
  }

  /**
   * Somebody was named in a message (MENTIONED).
   *
   * ## Why the recipients arrive rather than being derived
   *
   * Every other method here resolves recipients from the conversation's shape — the owner,
   * the lead, the team. A mention names people, and who was named is a property of the
   * MESSAGE. `@all` was already expanded at send time against the live participant set, so
   * a group whose membership changes an hour later notifies who was in it when the message
   * was sent, not who is in it when this runs.
   *
   * ## One notification per person, deduped on the message
   *
   * `dedupeDiscriminator` is the message id, so §29.5's coalescing folds a burst of
   * mentions in one thread into "3 new mentions" rather than three rows, while two
   * mentions of the same person in DIFFERENT messages stay separate — which is what a
   * person actually needs to act on.
   *
   * ## Failures are swallowed per recipient
   *
   * A mention that cannot be delivered to one person must not stop the others, and must
   * never fail the send that produced it: the message is already durable and the
   * notification is the additive part (invariant 9).
   */
  async mentioned(
    conversationId: UUID,
    messageId: UUID,
    mentionedPrincipalIds: readonly UUID[],
  ): Promise<void> {
    for (const principalId of mentionedPrincipalIds) {
      try {
        await this.notifications.notify({
          event: 'MENTIONED',
          recipientId: principalId,
          recipientKind: 'EMPLOYEE',
          away: await this.recipients.isAway(principalId),
          optedOutOf: await this.recipients.optedOutOf(principalId),
          /*
             The conversation, so the row is a way IN.

             It was omitted, and the consequence was not cosmetic: `targetRef` is what the
             notifications panel navigates on and what `render.ts` builds the email link
             from, so a mention was the one notification that could tell you it happened and
             not take you to it. Every other event here sets it; the dedupe key already
             includes it, and `dedupeDiscriminator: messageId` keeps one row per message
             rather than one per conversation per window.
          */
          targetRef: conversationId,
          // A reference, never the text. §29.2's outbox has never held message content,
          // and a notification carrying the body would be a copy of the message with the
          // object check removed — the objection §30.4 makes about a search index.
          payload: { conversationId, messageId },
          dedupeDiscriminator: messageId,
        });
      } catch (error) {
        this.logFailure('mentioned', principalId, error);
      }
    }
  }

  private async notifyEmployee(
    event: Parameters<NotificationService['notify']>[0]['event'],
    principalId: UUID,
    conversationId: UUID,
    dedupeDiscriminator?: string,
  ): Promise<void> {
    await this.notifications.notify({
      event,
      recipientId: principalId,
      recipientKind: 'EMPLOYEE',
      targetRef: conversationId,
      away: await this.recipients.isAway(principalId),
      optedOutOf: await this.recipients.optedOutOf(principalId),
      ...(dedupeDiscriminator !== undefined ? { dedupeDiscriminator } : {}),
    });
  }

  /**
   * Runs the body, and turns any failure into a log line.
   *
   * The recipient lookups are database reads and can fail; `notify` cannot. Letting a
   * failed lookup propagate would mean a transfer that was committed reports an error to
   * the person who performed it, who would reasonably retry it.
   */
  private async tell(what: string, conversationId: UUID, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      this.logFailure(what, conversationId, error);
    }
  }

  private logFailure(what: string, subject: string, error: unknown): void {
    this.logger.error('notification could not be raised', {
      operation: `notification.${what}`,
      outcome: 'FAILED',
      errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      detail: { subject, reason: error instanceof Error ? error.message : String(error) },
    });
  }
}
