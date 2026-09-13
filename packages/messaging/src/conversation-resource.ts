import type { ParticipantFacts, ResourceContext } from '@starlink/conversation-domain';
import type { UUID } from '@starlink/shared-contracts';

import type { ConversationRecord, ParticipantRecord } from './ports.js';

/**
 * THE authorization resource, built once.
 *
 * ## Why this exists
 *
 * `decide()` is pure: the caller loads the facts and it decides. That is what makes the
 * authorization matrix a table rather than a suite of HTTP tests, and it is right. What it
 * leaves behind is a shape every call site has to assemble by hand — and there were four,
 * spelled out longhand, differing in small ways nobody had noticed.
 *
 * Then channels added a fact. `decide()` refuses a channel whose policy did not arrive, so
 * three of those four hand-written copies turned every channel read into a 404 the moment
 * the feature landed: the writes worked, the reads did not, and the difference was which
 * copy somebody had remembered to update. That is §38's divergence arriving exactly where
 * §38 says it arrives.
 *
 * So: one function, one place that knows a channel carries a policy, and a `tx` parameter
 * rather than a pre-fetched value — because a caller who is handed the CHANCE to forget
 * eventually does.
 *
 * ## What it deliberately does not do
 *
 * Decide anything. It assembles inputs. Every rule stays in `decide()`, and this file
 * should never grow an `if` that changes an answer rather than a field.
 *
 * ## `exactOptionalPropertyTypes`
 *
 * Every optional key is spread conditionally rather than set to `undefined`. An explicit
 * `undefined` is not an absent key here, and §27.2's rule — an absent attribute is absent,
 * never blank — is enforced by the compiler on this project.
 */
export interface ResourceLoader {
  loadParticipant(conversationId: UUID, principalId: UUID): Promise<ParticipantRecord | undefined>;
  loadChannelFacts(
    conversationId: UUID,
    principalId: UUID,
  ): Promise<ResourceContext['channel'] | undefined>;
}

export async function conversationResource(
  tx: ResourceLoader,
  conversation: ConversationRecord,
  principalId: UUID,
  options: {
    /**
     * A participation already loaded by the caller, so a handler that needs the record for
     * something else does not read it twice. Omit and it is loaded here.
     */
    readonly participant?: ParticipantRecord | undefined;
    /**
     * Whether the ACTOR is a customer principal. Only then is `belongsToActorCustomer`
     * meaningful, and only then is the key present at all — `decide()` never reads it on
     * the employee path, and an absent value must mean absent.
     */
    readonly actorIsCustomer?: boolean;
    /** One instant for the whole projection. Defaults to now. */
    readonly at?: string;
  } = {},
): Promise<ResourceContext> {
  const at = options.at ?? new Date().toISOString();
  const participantRecord =
    options.participant !== undefined
      ? options.participant
      : await tx.loadParticipant(conversation.conversationId, principalId);

  const participant: ParticipantFacts | undefined =
    participantRecord === undefined
      ? undefined
      : {
          role: participantRecord.role,
          replyAuthority: participantRecord.replyAuthority,
          effectiveFrom: participantRecord.effectiveFrom,
          ...(participantRecord.effectiveTo !== undefined
            ? { effectiveTo: participantRecord.effectiveTo }
            : {}),
        };

  /*
     Only for a channel, and unconditionally FOR a channel.

     Not "if the caller asked for it". `decide()` treats an absent policy on a channel as a
     refusal, which is the right failure but a silent one — the room simply stops working
     for everybody. Deciding here, from the loaded type, is the only place that cannot be
     skipped by a handler that did not know it had to think about it.
  */
  const channel =
    conversation.conversationType === 'INTERNAL_CHANNEL'
      ? await tx.loadChannelFacts(conversation.conversationId, principalId)
      : undefined;

  return {
    conversationId: conversation.conversationId,
    conversationType: conversation.conversationType,
    ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
    ...(conversation.owningTeamId !== undefined ? { owningTeamId: conversation.owningTeamId } : {}),
    ...(conversation.owningDepartment !== undefined
      ? { owningDepartment: conversation.owningDepartment }
      : {}),
    ...(conversation.currentOwnerId !== undefined
      ? { currentOwnerId: conversation.currentOwnerId }
      : {}),
    ...(conversation.customerRef !== undefined ? { customerRef: conversation.customerRef } : {}),
    sensitivity: conversation.sensitivity,
    ...(participant !== undefined ? { participant } : {}),
    ...(channel !== undefined ? { channel } : {}),
    /*
       A customer may only ever write into their OWN conversation, and "own" is LIVE
       PARTICIPATION — a fact we recorded — rather than a customer reference, which is a
       claim we later believed. Deriving it from the reference is what once let any customer
       write into any customer's thread; see the long note in `send-message.ts`.
    */
    ...(options.actorIsCustomer === true
      ? {
          belongsToActorCustomer:
            participant !== undefined &&
            participant.effectiveFrom <= at &&
            (participant.effectiveTo === undefined || participant.effectiveTo > at),
        }
      : {}),
  };
}
