/**
 * The customer-visible status vocabulary (D-26, §22.5, §27.16).
 *
 * §22.5's table has one row for internal state: **"Never — mapped (D-26)"**. The customer
 * sees a word from a small vocabulary, never the state machine's own name for where their
 * conversation is. The reason is in the same section:
 *
 * > "The row that carries the most risk is SLA state. A customer who can see 'first
 * > response breached' has been handed a grievance the company generated itself. §27.16
 * > makes this a fail-closed serialisation rule, not a UI convention."
 *
 * The words are D-26's own proposal: *received · being looked at · waiting for you ·
 * resolved*. Marked PROPOSED in §44.5 and seeded as placeholder configuration; the
 * MAPPING is code because it is a safety boundary, and the WORDS are content the business
 * can change without a deployment.
 *
 * ## The mapping is exhaustive, and that is the point
 *
 * This replaces a `switch` with a `default` arm. A default is the wrong shape here: it
 * cannot tell "a state we decided maps to RECEIVED" from "a state nobody has thought
 * about", and it fails silently in the direction of showing something. The previous
 * version demonstrated the failure precisely — it tested for `'AWAITING_CUSTOMER'` when
 * the enum value is `'WAITING_CUSTOMER'`, so *"waiting for you"* was unreachable and
 * every waiting conversation displayed as though we were still working on it. Its unit
 * test asserted the same misspelling, so it passed.
 *
 * The record below is typed `Record<ConversationState, …>`, so adding a state to the enum
 * is a compile error here until somebody decides what the customer should see. That is
 * the only mechanism that reliably survives a rushed change.
 */
import type { ConversationState } from '@starlink/shared-contracts';

/**
 * What a customer may be told about progress. Four values, and no more without D-26.
 *
 * Deliberately NOT a superset of the internal states — the whole purpose is that several
 * internal states collapse to one customer-facing word, so that the difference between
 * "queued because nobody is free" and "queued because it is 2am" is invisible. Both are
 * *received*, and the customer needs no more than that.
 */
export type CustomerVisibleStatus =
  | 'RECEIVED'
  | 'BEING_LOOKED_AT'
  | 'WAITING_FOR_YOU'
  | 'RESOLVED';

/**
 * Internal state → customer word. Total over the enum, by construction.
 *
 * Two rows deserve their reasoning stated, because both look like they could go the other
 * way:
 *
 * **`WAITING_INTERNAL` → BEING_LOOKED_AT, never WAITING_FOR_YOU.** Waiting on a colleague
 * is our delay, not the customer's. Telling them "waiting for you" when the ball is with
 * an underwriter would be blaming them for our queue, and they would sit there believing
 * they had already replied wrongly.
 *
 * **`CLOSED` → RESOLVED.** §21.4's transition table gives `resolved → closed` a "Customer
 * notified: No", and the row after it — a reply arriving past the reopen window — says
 * "No — it simply continues". Closure is an internal boundary that lets us measure two
 * pieces of work separately (BR-22, §22.4); from the customer's side nothing happened, so
 * showing them a different word would be announcing an internal event §22.5 forbids.
 */
const CUSTOMER_STATUS: Readonly<Record<ConversationState, CustomerVisibleStatus>> =
  Object.freeze({
    NEW: 'RECEIVED',
    QUEUED: 'RECEIVED',
    ASSIGNED: 'BEING_LOOKED_AT',
    ACTIVE: 'BEING_LOOKED_AT',
    WAITING_INTERNAL: 'BEING_LOOKED_AT',
    WAITING_CUSTOMER: 'WAITING_FOR_YOU',
    RESOLVED: 'RESOLVED',
    CLOSED: 'RESOLVED',
  });

const KNOWN_STATES = new Set<string>(Object.keys(CUSTOMER_STATUS));

/**
 * Maps an internal state to the word a customer may see.
 *
 * Accepts `string | null | undefined` because the input is a database column, and a
 * column can hold something the enum does not — a value written by an older release, a
 * hand-edited row, a state added in a migration ahead of the code. An unrecognised value
 * maps to `RECEIVED`.
 *
 * `RECEIVED` rather than `BEING_LOOKED_AT` for the unknown case, and the difference
 * matters: "we have your message" is true of every conversation that exists, whereas
 * "being looked at" asserts somebody is working on it. When we do not know, we must claim
 * the less. That is the fail-closed direction §27.16 requires — the failure mode of
 * guessing upward is a customer waiting patiently on a promise nobody made.
 */
export function toCustomerStatus(state: string | null | undefined): CustomerVisibleStatus {
  if (typeof state === 'string' && KNOWN_STATES.has(state)) {
    return CUSTOMER_STATUS[state as ConversationState];
  }
  return 'RECEIVED';
}

/**
 * Every internal state that maps to a given customer word.
 *
 * Exists for the leak test: it lets a test assert that no customer-facing word can be
 * reached from an internal state it should not represent, without the test restating the
 * mapping and therefore agreeing with whatever the mapping happens to say.
 */
export const internalStatesFor = (
  status: CustomerVisibleStatus,
): readonly ConversationState[] =>
  (Object.keys(CUSTOMER_STATUS) as ConversationState[]).filter(
    (state) => CUSTOMER_STATUS[state] === status,
  );

/**
 * The default English wording, and the seam D-26 will replace.
 *
 * Held apart from the mapping on purpose: the words are the business's to choose and are
 * PROPOSED (§44.5), while which internal states collapse together is a safety property.
 * When the business ratifies its wording, or a second language arrives, this is the only
 * thing that changes — `toCustomerStatus` does not.
 */
export const DEFAULT_STATUS_WORDING: Readonly<Record<CustomerVisibleStatus, string>> =
  Object.freeze({
    RECEIVED: 'Received',
    BEING_LOOKED_AT: 'Being looked at',
    WAITING_FOR_YOU: 'Waiting for you',
    RESOLVED: 'Resolved',
  });
