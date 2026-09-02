/**
 * The attachment pipeline (ADR-012, doc §28, Part IV §59).
 *
 * ## quarantine → scan → promote → bind
 *
 * Eight states, and the shape of them is the security property. Nothing is reachable
 * until it has been scanned AND bound to a message:
 *
 *     UPLOAD_GRANTED → QUARANTINED → SCANNING → CLEAN → BOUND
 *                                            ↘ INFECTED
 *                                            ↘ REJECTED
 *     (anything unbound) ─────────────────────────────→ EXPIRED
 *
 * §28.1, in capitals in the source: **"AN UPLOADED-BUT-UNSENT ATTACHMENT IS REACHABLE BY
 * NOBODY. Binding to a message is what grants access, because access is derived from the
 * conversation."** So `BOUND` is not bookkeeping — it is the moment a file acquires an
 * audience, and every earlier state has none.
 *
 * ## Why the state machine refuses rather than repairs
 *
 * A scan verdict arriving for an already-bound attachment, a bind attempted on something
 * still in quarantine, a promotion of an infected file — each is a refusal with a name.
 * None of them throws, because each is a thing that legitimately happens under
 * concurrency or retry, and a pipeline that threw on them would turn an ordinary race
 * into an incident.
 *
 * ## What lives elsewhere
 *
 * The bytes never pass through here. Validation of the CONTENT — sniffed MIME, byte
 * count, archive bombs — happens in the scanner adapter and arrives as a verdict; this
 * module decides what a verdict MEANS for reachability.
 */
import type { UUID } from '@starlink/shared-contracts';

/** Mirrors `conversation.attachment_state` in migration 0001, exactly. */
export type AttachmentState =
  | 'UPLOAD_GRANTED'
  | 'QUARANTINED'
  | 'SCANNING'
  | 'CLEAN'
  | 'INFECTED'
  | 'REJECTED'
  | 'BOUND'
  | 'EXPIRED';

export type PipelineEvent =
  /** The client finished its direct upload to the quarantine prefix. */
  | { readonly kind: 'UPLOADED' }
  | { readonly kind: 'SCAN_STARTED' }
  | { readonly kind: 'SCAN_CLEAN' }
  | { readonly kind: 'SCAN_INFECTED' }
  /** Failed validation: size, MIME mismatch, archive bomb, macro policy. */
  | { readonly kind: 'SCAN_REJECTED'; readonly reason: string }
  /** Attached to a message. The moment it becomes reachable. */
  | { readonly kind: 'BOUND'; readonly messageId: UUID }
  | { readonly kind: 'EXPIRED' };

export type PipelineRefusal =
  | 'NOT_A_TRANSITION'
  /** §28.1: only a scanned-clean attachment may be bound. */
  | 'NOT_CLEAN_YET'
  /** Terminal. An infected file is never promoted, bound or retried. */
  | 'INFECTED_IS_TERMINAL'
  | 'ALREADY_BOUND'
  | 'ALREADY_EXPIRED';

export type PipelineResult =
  | { readonly ok: true; readonly state: AttachmentState }
  | { readonly ok: false; readonly refusal: PipelineRefusal };

/**
 * The permitted moves. Anything absent is refused.
 *
 * `CLEAN → EXPIRED` is present deliberately: a file that passed its scan and was never
 * attached to a message is still an unbound upload, and §28.6 says unbound uploads
 * "expire on a schedule; they were never reachable". Being clean does not make something
 * reachable — only binding does.
 *
 * `BOUND → EXPIRED` is absent, equally deliberately. Once an attachment belongs to a
 * message it follows the CONVERSATION's retention, not its own (§28.6), so the expiry
 * sweep must not be able to reach it.
 */
const MOVES: Readonly<Record<AttachmentState, Partial<Record<PipelineEvent['kind'], AttachmentState>>>> =
  Object.freeze({
    UPLOAD_GRANTED: { UPLOADED: 'QUARANTINED', EXPIRED: 'EXPIRED' },
    QUARANTINED: { SCAN_STARTED: 'SCANNING', EXPIRED: 'EXPIRED' },
    SCANNING: {
      SCAN_CLEAN: 'CLEAN',
      SCAN_INFECTED: 'INFECTED',
      SCAN_REJECTED: 'REJECTED',
      EXPIRED: 'EXPIRED',
    },
    CLEAN: { BOUND: 'BOUND', EXPIRED: 'EXPIRED' },
    // Terminal states. An infected or rejected file is never revived — a "retry the
    // scan" path would be a way to get a second opinion on malware.
    INFECTED: {},
    REJECTED: {},
    BOUND: {},
    EXPIRED: {},
  });

/** Advances the pipeline, or explains why not. Pure. */
export function advance(from: AttachmentState, event: PipelineEvent): PipelineResult {
  if (from === 'INFECTED') return { ok: false, refusal: 'INFECTED_IS_TERMINAL' };
  if (from === 'BOUND') return { ok: false, refusal: 'ALREADY_BOUND' };
  if (from === 'EXPIRED') return { ok: false, refusal: 'ALREADY_EXPIRED' };

  const to = MOVES[from][event.kind];
  if (to === undefined) {
    // Naming this case separately is worth it: "you tried to bind something that has not
    // been scanned" is the single most likely mistake a caller makes here, and
    // NOT_A_TRANSITION would not say so.
    if (event.kind === 'BOUND') return { ok: false, refusal: 'NOT_CLEAN_YET' };
    return { ok: false, refusal: 'NOT_A_TRANSITION' };
  }
  return { ok: true, state: to };
}

/**
 * Is this attachment reachable by anyone at all?
 *
 * The single question every read path asks first. Only BOUND qualifies — §28.1 again:
 * binding is what grants access, because access is derived from the conversation.
 */
export const isReachable = (state: AttachmentState): boolean => state === 'BOUND';

/**
 * Should the expiry sweep collect this?
 *
 * Everything that never reached a message. A BOUND attachment is excluded because it now
 * follows the conversation's retention (§28.6), and terminal failures are excluded
 * because their rows are the record of a rejection — deleting them would erase the
 * evidence that somebody uploaded malware.
 */
export const isExpirable = (state: AttachmentState): boolean =>
  state === 'UPLOAD_GRANTED' || state === 'QUARANTINED' || state === 'SCANNING' || state === 'CLEAN';
