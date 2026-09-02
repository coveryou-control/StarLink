/**
 * The redaction boundary — what an AI provider is allowed to see (brief §36, §57, §58).
 *
 * INTEGRATION_CONTRACTS §11 states the rule in one clause: AI is *"bounded to permitted
 * context (**redaction happens before the provider boundary**)"*. `AIProvider` says the
 * same thing in its type — every method takes a `RedactedTranscriptRef`, never a
 * conversation id — so the contract already refuses to accept raw content. This module is
 * what produces the thing it will accept.
 *
 * ## Built before a provider exists, deliberately
 *
 * N-05 (provider choice and the DPA) is unanswered, so nothing here calls anything. That
 * is the point of building it first: the moment a provider IS approved, the pressure is
 * to wire it up, and a redaction layer written under that pressure is written by someone
 * who wants the demo to work. Sending transcripts to a third party is not reversible —
 * "we will add redaction next sprint" is a sentence about data that has already left.
 *
 * ## Three properties, and the reasoning for each
 *
 * **1. Structured turns, never a prompt string.** {@link redactTranscript} returns an
 * array of `{ seq, speaker, text }` and deliberately provides no `toPrompt()` helper.
 * Concatenating a customer's words into an instruction string is the mechanism behind
 * prompt injection, which §65's red-team lab lists first — *"prompt injection, malicious
 * attachment text, sensitive-data request, tool overreach"*. A caller that wants a flat
 * string has to write the flattening itself, at which point it is a visible decision in a
 * reviewable diff rather than a convenience nobody questioned.
 *
 * **2. Customer-visible content only, by default.** §58: *"Internal notes are
 * schema-enforced staff-only content."* Whether a staff-only note may be sent to an
 * external processor is a privacy question that belongs with the DPA (N-05), and it has
 * not been asked — so the default excludes them and the opt-in is named loudly enough
 * that turning it on is a conversation. See {@link TranscriptScope}.
 *
 * **3. PII patterns come from `@starlink/observability`.** The same regular expressions
 * that keep an email address out of a log keep it out of a provider payload. One list, so
 * a pattern added for either reason protects both — two lists diverge, and the one that
 * diverges is the one nobody was looking at.
 *
 * ## What is deliberately NOT here
 *
 * Attachment contents and filenames. §65's red-team names *"malicious attachment text"*
 * as its own hazard, and an attachment is not a conversation turn: it has its own
 * classification, DLP verdict and download policy (§59). Including one would inherit none
 * of that. If AI ever reads attachments it needs its own path through the DLP result, not
 * a quiet inclusion here.
 */
import { redactValueText } from '@starlink/observability';
import type {
  MessageVisibility,
  RedactedTranscriptRef,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';

/**
 * The profile name recorded on every ref, so a stored advisory says what rules produced
 * the context it was derived from.
 *
 * Versioned as a string rather than a number because it is compared, never ordered — an
 * advisory generated under `v1` is not "less than" one under `v2`, it is a different
 * thing, and an audit asking "what did the model see" needs the label, not the sequence.
 *
 * **Bump this whenever the rules below change.** An advisory stored under a profile whose
 * meaning has since changed is a record that lies about itself.
 */
export const REDACTION_PROFILE = 'starlink-redaction-v1';

/**
 * How much of the conversation the caller is asking for.
 *
 * `CUSTOMER_VISIBLE` is the default everywhere and the only value any current caller
 * uses. `INCLUDING_INTERNAL_NOTES` exists so that the day someone needs it, the need is
 * expressed as a named scope in a diff — rather than as a quietly relaxed filter — and
 * so this comment is the thing they read first:
 *
 * > Sending an internal note to an external AI processor has not been approved by
 * > anybody. §58 makes internal notes staff-only content; N-05's DPA covers "redacted
 * > transcript processing" and nobody has been asked whether staff-only notes are inside
 * > that phrase. Get the answer before using this value.
 */
export type TranscriptScope = 'CUSTOMER_VISIBLE' | 'INCLUDING_INTERNAL_NOTES';

/** One message, as the message store holds it. */
export interface TranscriptMessage {
  readonly seq: number;
  readonly visibility: MessageVisibility;
  readonly body: string;
  /** `EMPLOYEE`, `CUSTOMER`, `SYSTEM` or `AI` — never a name. */
  readonly senderKind: string;
}

/**
 * Who said it, in the only vocabulary a provider gets.
 *
 * Roles, never identities. §58: *"Normal agents use customer/contact tokens … raw
 * mobile/email/PII exposure is separate capability, purpose-bound"* — a display name is
 * PII whether it belongs to the customer or to the advisor, and neither is needed to
 * summarise what was said.
 */
export type Speaker = 'CUSTOMER' | 'AGENT' | 'SYSTEM' | 'AI';

export interface RedactedTurn {
  readonly seq: number;
  readonly speaker: Speaker;
  /** Body text with PII patterns replaced. Never the original. */
  readonly text: string;
}

export interface RedactedTranscript {
  /** Exactly what an `AIProvider` method accepts. */
  readonly ref: RedactedTranscriptRef;
  readonly turns: readonly RedactedTurn[];
  /**
   * How many messages were withheld, and why — reported rather than silently dropped.
   *
   * A summary built from eleven of twenty turns is a different artefact from one built
   * from all twenty, and a reviewer asking why the model missed something needs to know
   * that nine messages never reached it.
   */
  readonly withheld: {
    readonly internalNotes: number;
    readonly empty: number;
  };
}

const SPEAKER_BY_KIND: Readonly<Record<string, Speaker>> = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  EMPLOYEE: 'AGENT',
  SYSTEM: 'SYSTEM',
  AI: 'AI',
});

/**
 * Builds the only representation of a conversation an AI provider may receive.
 *
 * `upToSeq` on the returned ref is the highest sequence number **considered**, not the
 * highest included. Those differ whenever the last message was an internal note, and the
 * considered value is the useful one: it is what a later call resumes from, and using the
 * included value would re-examine every withheld message for ever.
 */
export function redactTranscript(
  conversationId: UUID,
  messages: readonly TranscriptMessage[],
  options: { readonly scope?: TranscriptScope } = {},
): RedactedTranscript {
  const scope = options.scope ?? 'CUSTOMER_VISIBLE';

  let internalNotes = 0;
  let empty = 0;
  const turns: RedactedTurn[] = [];

  for (const message of messages) {
    if (message.visibility === 'INTERNAL' && scope !== 'INCLUDING_INTERNAL_NOTES') {
      internalNotes += 1;
      continue;
    }

    const text = redactValueText(message.body).trim();
    // A turn that was entirely PII redacts to nothing. Emitting it would tell the model
    // "someone said something here" and give it nothing to work with; counting it keeps
    // the transcript honest about its own completeness.
    if (text === '') {
      empty += 1;
      continue;
    }

    turns.push({
      seq: message.seq,
      // An unrecognised sender kind becomes SYSTEM rather than being passed through. The
      // vocabulary is closed (`PrincipalKind`), so an unknown value is a bug, and the
      // safe reading of an unattributable message is that the system said it — not that
      // it came from the customer, which is the reading that would let an injected
      // instruction wear the customer's label.
      speaker: SPEAKER_BY_KIND[message.senderKind] ?? 'SYSTEM',
      text,
    });
  }

  const upToSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), 0);

  return {
    ref: { conversationId, upToSeq, redactionProfile: REDACTION_PROFILE },
    turns,
    withheld: { internalNotes, empty },
  };
}

/**
 * Whether an advisory may still be trusted as describing what it claims to describe.
 *
 * §57: *"Store model/version, evidence, confidence and acceptance/rejection for
 * high-impact suggestions."* An advisory stored under one redaction profile and read back
 * after the rules changed is evidence of nothing — this is how a caller notices, rather
 * than discovering it during an incident.
 */
export const wasGeneratedUnderCurrentProfile = (
  ref: Pick<RedactedTranscriptRef, 'redactionProfile'>,
): boolean => ref.redactionProfile === REDACTION_PROFILE;

/** Placeholder kept for callers that need an explicit "nothing to send" transcript. */
export const emptyTranscript = (
  conversationId: UUID,
  at: Timestamp,
): RedactedTranscript & { readonly builtAt: Timestamp } => ({
  ref: { conversationId, upToSeq: 0, redactionProfile: REDACTION_PROFILE },
  turns: [],
  withheld: { internalNotes: 0, empty: 0 },
  builtAt: at,
});
