/**
 * The customer-service conversation lifecycle (doc §21.4, diagram 9).
 *
 * ## What is a state, and what deliberately is not
 *
 * §21.4 supersedes v2.0's version, and the correction it makes is the important part of
 * this file. v2.0 listed `any → reassigned` and `any → escalated` as transitions —
 * "neither of which is a state". They are now EVENTS, and escalation is additionally a
 * level on the case. Four things are explicitly orthogonal axes rather than states:
 *
 *     escalation level : 0, 1, 2 …   independent of state
 *     after-hours flag : true/false  independent of state
 *     SLA state        : running / paused / breached
 *     priority         : independent of state
 *
 * > "A case can be ESCALATED and WAITING and BREACHED at once. That is exactly why
 * > escalation is not a state: a single status field could only report one of the three."
 *
 * The document also gives the reason this matters operationally, and it is worth keeping
 * in front of anyone tempted to add a state:
 *
 * > "'Work in progress' is assigned or active — two values, and a transfer does not add a
 * > third. If `transferred` were a state, every query for open work would have to
 * > remember to include it, and the first one that forgot would hide a customer."
 *
 * So {@link transition} rejects anything that is not in §21.4's table, and the events
 * that change ownership live in `packages/routing` where they already carry a mandatory
 * reason and a must-succeed audit.
 *
 * ## Internal conversations have no lifecycle at all
 *
 * §21.4, and D-15 confirms it: internal chat has no states, no resolve/close, no SLA and
 * no case. {@link isLifecycleBearing} is the guard — asking for a transition on an
 * internal thread is a programming error, not a refusal, because it means a caller has
 * confused the two kinds of conversation.
 */
import type { ConversationState, ConversationType } from '@starlink/shared-contracts';

/** Who is asking. The table in §21.4 assigns each transition to an actor. */
export type LifecycleActor = 'CUSTOMER' | 'OWNER' | 'LEAD' | 'SYSTEM';

export interface TransitionRule {
  readonly from: ConversationState;
  readonly to: ConversationState;
  /** Actors §21.4 permits. A transition attempted by anyone else is refused. */
  readonly actors: readonly LifecycleActor[];
  /**
   * §21.4's "Reason required" column. `active → resolved` requires the OUTCOME, and
   * `resolved → active` requires one only when staff initiated it — a customer replying
   * is its own reason.
   */
  readonly reasonRequired: boolean;
  /**
   * §21.4's "Customer notified" column, carried so the notification layer reads it from
   * the same table the transition came from rather than re-deriving it. Never a
   * notification ABOUT internal handling — see the note at the end of the table:
   * "Nothing in this table notifies a customer of internal handling."
   */
  readonly notifiesCustomer: boolean;
  /** §21.4's "Audited" column. */
  readonly audited: boolean;
}

/**
 * §21.4's transition table, transcribed row for row.
 *
 * `WAITING_CUSTOMER` is the table's `waiting`. `WAITING_INTERNAL` does not appear in
 * §21.4's diagram — it comes from the state enum and the implementation brief — so it is
 * modelled on the same footing as `WAITING_CUSTOMER` for staff-side waiting, with one
 * difference the customer can see: waiting on a colleague is NOT waiting on the customer,
 * so it must never render as "waiting for you" (§22.5, D-26).
 */
export const TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  // — → new is the intake write itself, not a transition between two states.
  {
    from: 'NEW',
    to: 'QUEUED',
    // "System, when no owner can be assigned, or after hours (§23.3)"
    actors: ['SYSTEM'],
    reasonRequired: false,
    // "Acknowledged, with no response-time promise" — §23.2's rule, and the reason an
    // after-hours acknowledgement must never carry a countdown.
    notifiesCustomer: true,
    audited: true,
  },
  { from: 'NEW', to: 'ASSIGNED', actors: ['SYSTEM', 'OWNER', 'LEAD'], reasonRequired: false, notifiesCustomer: false, audited: true },
  // "Advisor claims, or a lead assigns"
  { from: 'QUEUED', to: 'ASSIGNED', actors: ['OWNER', 'LEAD', 'SYSTEM'], reasonRequired: false, notifiesCustomer: false, audited: true },
  // "assigned → active | Owner | Yes (the reply itself) | No" — the reply notifies; the
  // transition is not separately audited because the message already is.
  { from: 'ASSIGNED', to: 'ACTIVE', actors: ['OWNER'], reasonRequired: false, notifiesCustomer: true, audited: false },
  { from: 'ACTIVE', to: 'WAITING_CUSTOMER', actors: ['SYSTEM', 'OWNER'], reasonRequired: false, notifiesCustomer: false, audited: false },
  { from: 'WAITING_CUSTOMER', to: 'ACTIVE', actors: ['CUSTOMER'], reasonRequired: false, notifiesCustomer: false, audited: false },
  // Waiting on a colleague. Same shape as waiting on the customer, and deliberately a
  // different state so the customer-facing vocabulary cannot conflate them.
  { from: 'ACTIVE', to: 'WAITING_INTERNAL', actors: ['SYSTEM', 'OWNER'], reasonRequired: false, notifiesCustomer: false, audited: false },
  { from: 'WAITING_INTERNAL', to: 'ACTIVE', actors: ['SYSTEM', 'OWNER'], reasonRequired: false, notifiesCustomer: false, audited: false },
  // "active → resolved | Owner or lead | Yes — the outcome | Yes, with the outcome | Yes"
  { from: 'ACTIVE', to: 'RESOLVED', actors: ['OWNER', 'LEAD'], reasonRequired: true, notifiesCustomer: true, audited: true },
  // A conversation waiting on the customer can still be resolved — the customer stopped
  // replying and the owner closed it out. §21.4 draws waiting → resolved in diagram 9.
  { from: 'WAITING_CUSTOMER', to: 'RESOLVED', actors: ['OWNER', 'LEAD'], reasonRequired: true, notifiesCustomer: true, audited: true },
  { from: 'WAITING_INTERNAL', to: 'RESOLVED', actors: ['OWNER', 'LEAD'], reasonRequired: true, notifiesCustomer: true, audited: true },
  // "resolved → active | Owner or customer (reopen in window) | Yes, if staff-initiated"
  { from: 'RESOLVED', to: 'ACTIVE', actors: ['CUSTOMER', 'OWNER', 'LEAD'], reasonRequired: false, notifiesCustomer: true, audited: true },
  // "resolved → closed | System, on reopen-window expiry | — | No | Yes"
  { from: 'RESOLVED', to: 'CLOSED', actors: ['SYSTEM'], reasonRequired: false, notifiesCustomer: false, audited: true },
]);

export type TransitionRefusal =
  /** No row in §21.4's table joins these two states. */
  | 'NOT_A_TRANSITION'
  /** The table permits the move, but not by this actor. */
  | 'ACTOR_NOT_PERMITTED'
  /** §21.4 requires a reason for this row and none was given. */
  | 'REASON_REQUIRED'
  /** CLOSED is terminal for the conversation; a reply after the window starts a new one. */
  | 'CONVERSATION_IS_CLOSED'
  /** Already there. Not an error at the domain level, but never a silent success either. */
  | 'ALREADY_IN_STATE';

export type TransitionResult =
  | { readonly ok: true; readonly rule: TransitionRule }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

export interface TransitionRequest {
  readonly from: ConversationState;
  readonly to: ConversationState;
  readonly actor: LifecycleActor;
  /** Required where §21.4 says so. Whitespace is not a reason. */
  readonly reason?: string;
  /**
   * True when a staff member initiated a reopen. §21.4 requires a reason "if
   * staff-initiated" — a customer replying is its own reason, and demanding one from
   * them would be absurd.
   */
  readonly staffInitiated?: boolean;
}

/**
 * Is this conversation the kind that HAS a lifecycle?
 *
 * Only customer-service conversations do. §21.4: internal chat has "None. A thread exists
 * and stays open indefinitely", no resolve/close (D-15), no SLA, no case.
 */
export const isLifecycleBearing = (type: ConversationType): boolean =>
  type === 'CUSTOMER_SERVICE';

/**
 * Decides whether a state change is permitted. Pure — it changes nothing.
 *
 * Refusals are values rather than exceptions, because every one of them is a normal thing
 * for a caller to encounter: two people resolving at once, a customer replying to a
 * conversation that closed while they were typing, a lead trying a move only the owner
 * may make.
 */
export function transition(request: TransitionRequest): TransitionResult {
  if (request.from === request.to) return { ok: false, refusal: 'ALREADY_IN_STATE' };

  // Terminal, and checked before the table so the refusal names the real reason. §21.4:
  // CLOSED is "terminal for the CONVERSATION", and a customer replying after the window
  // creates a NEW conversation against the same case (BR-22, §22.4) rather than reviving
  // this one. Reviving it would silently extend a reopen window the business bounded.
  if (request.from === 'CLOSED') return { ok: false, refusal: 'CONVERSATION_IS_CLOSED' };

  const rule = TRANSITIONS.find((r) => r.from === request.from && r.to === request.to);
  if (rule === undefined) return { ok: false, refusal: 'NOT_A_TRANSITION' };

  if (!rule.actors.includes(request.actor)) {
    return { ok: false, refusal: 'ACTOR_NOT_PERMITTED' };
  }

  // "Yes, if staff-initiated" — the reopen row is the only one whose reason requirement
  // depends on who asked, so it is expressed here rather than as a second table row.
  const needsReason =
    rule.from === 'RESOLVED' && rule.to === 'ACTIVE'
      ? request.staffInitiated === true
      : rule.reasonRequired;

  if (needsReason && (request.reason ?? '').trim() === '') {
    return { ok: false, refusal: 'REASON_REQUIRED' };
  }

  return { ok: true, rule };
}

/**
 * States in which a conversation is still the organisation's problem.
 *
 * Derived from the table rather than listed by hand: a state is open if any transition
 * leads out of it. That is what keeps the §21.4 warning true — a new state added to the
 * table joins "open work" automatically, instead of waiting to be forgotten by the first
 * query that enumerates states.
 */
export const OPEN_STATES: readonly ConversationState[] = Object.freeze(
  [...new Set(TRANSITIONS.map((r) => r.from))].filter((state) => state !== 'RESOLVED'),
);

/** Terminal for the conversation. A later customer reply becomes a new one (BR-22). */
export const isTerminal = (state: ConversationState): boolean => state === 'CLOSED';
