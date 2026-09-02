/**
 * What is notified, to whom, on which channel (doc §29.2).
 *
 * §29.2's governing sentence: **"Notify only what someone must act on. Everything else is
 * an unread count."** That is a product decision with a real consequence — a system that
 * notifies everything trains people to ignore it, and then the one notification that
 * mattered is ignored too.
 *
 * The table below is §29.2's, transcribed row for row rather than paraphrased. The
 * "Not notified" list is enforced as strictly as the notified one: §29.2 names typing,
 * read receipts, directory changes, one's own actions, every message in a busy internal
 * group, and — absolutely — internal notes to anyone customer-facing (BR-26).
 *
 * ## The customer row is decided but not yet buildable
 *
 * D-12 — which channel a customer is reached on — was **answered on 2026-08-28: email**.
 * The v2.2 document had it as "entirely dependent on D-01" (§44.3) and marked D-01 itself
 * NO PROPOSAL (§44.1); both are superseded by `STARLINK_OPEN_QUESTIONS.md`, which records
 * D-01 answered on 2026-08-26 (web chat) and D-12 answered on 2026-08-28 (email).
 *
 * `channelsFor` nevertheless still returns an empty list for a customer, and that is now
 * a statement about PREREQUISITES rather than about the decision:
 *
 *   * **D-31 — there is no durable customer email address.** It exists only as an
 *     `IdentityHints` value in an in-memory map inside `LocalOtpIdentity`, for a
 *     30-minute session. Notifications are delivered by a worker long after that has
 *     gone. Rule 11 forbids solving it by making StarLink a customer master.
 *   * **N-07 — no email provider is configured** for anyone, customer or staff.
 *
 * Returning a channel before either exists would write rows that can never be delivered,
 * about customers, for as long as the gap lasts. The list opens in the same change that
 * can actually send.
 */
import type { PrincipalKind } from '@starlink/shared-contracts';

/** The transports §29.3's diagram names, with the phase each belongs to. */
export type NotificationChannel = 'INAPP' | 'EMAIL' | 'PUSH' | 'CUSTOMER_CHANNEL';

/** Every event §29.2 says is worth telling somebody about. */
export type NotifiableEvent =
  | 'CONVERSATION_ASSIGNED'
  | 'WAITING_BEYOND_STANDARD'
  | 'ESCALATED_TO_YOUR_FUNCTION'
  | 'TRANSFERRED'
  | 'COVER_NEEDED'
  | 'CUSTOMER_REPLIED'
  | 'ROLE_OR_ACCESS_CHANGED'
  /** Engineering's, not §29.2's — see the rule below for why and what it does not relax. */
  | 'MENTIONED'
  | 'NEW_IN_TEAM_QUEUE'
  | 'CUSTOMER_CONVERSATION_ANSWERED';

export type Recipient =
  | 'OWNER'
  | 'LEAD'
  | 'RECEIVING_OFFICER'
  | 'BOTH_PARTIES'
  | 'TEAM'
  | 'PRINCIPAL'
  /**
   * The principals a message named, resolved at send time.
   *
   * Unlike every other recipient here, this one is not derived from the conversation's
   * shape — it is carried in the event, because who was mentioned is a property of the
   * message and not of the thread. `@all` is already expanded by the time it arrives.
   */
  | 'MENTIONED_PRINCIPALS'
  | 'CUSTOMER';

export interface NotificationRule {
  readonly event: NotifiableEvent;
  /**
   * §29.2's "Notified" column, transcribed VERBATIM, used as the notification subject.
   *
   * The document never says "these are the subject lines" — but it gives a phrase for
   * every row, written in the second person and addressed to the recipient, and using it
   * is transcription rather than invention. That distinction is the whole point: the
   * alternative was engineering writing new English for a product whose customer-facing
   * wording the document treats as a business decision three separate times (D-20
   * after-hours wording, D-26 status vocabulary, D-28 what the case is called).
   *
   * Before this, the subject was the raw enum — an email would have arrived titled
   * `CUSTOMER_REPLIED`.
   *
   * Change these only against the source. `matrix.test.ts` asserts each one, so a
   * well-meaning rewording fails a test rather than quietly becoming the product's voice.
   */
  readonly subject: string;
  readonly recipients: readonly Recipient[];
  /** Always delivered in-app where the recipient is staff. §29.6: in-app is not disableable. */
  readonly inApp: boolean;
  /**
   * §29.2's "In-app + external if away" — external only when the recipient has had no
   * realtime connection for the configured period. §29.6 is careful that this is NOT
   * presence: it is "simply 'not currently connected'".
   */
  readonly externalIfAway: boolean;
  /** §29.2's "In-app + external" with no away qualifier: important enough to push out. */
  readonly externalAlways: boolean;
}

/** §29.2's table. Order preserved so it can be diffed against the source. */
export const NOTIFICATION_RULES: readonly NotificationRule[] = Object.freeze([
  { event: 'CONVERSATION_ASSIGNED', subject: 'A customer conversation assigned to you', recipients: ['OWNER'], inApp: true, externalIfAway: true, externalAlways: false },
  // "A conversation waiting beyond a service standard | Owner, then lead | In-app + external"
  { event: 'WAITING_BEYOND_STANDARD', subject: 'A conversation waiting beyond a service standard', recipients: ['OWNER', 'LEAD'], inApp: true, externalIfAway: false, externalAlways: true },
  { event: 'ESCALATED_TO_YOUR_FUNCTION', subject: 'Escalation to your function', recipients: ['RECEIVING_OFFICER', 'LEAD'], inApp: true, externalIfAway: false, externalAlways: true },
  { event: 'TRANSFERRED', subject: 'Transfer into or out of your ownership', recipients: ['BOTH_PARTIES'], inApp: true, externalIfAway: false, externalAlways: true },
  // "Cover needed on your team | Team | In-app" — no external. Cover is a team-scope
  // nudge, and paging everyone's phone for it is how a team mutes the product.
  { event: 'COVER_NEEDED', subject: 'Cover needed on your team', recipients: ['TEAM'], inApp: true, externalIfAway: false, externalAlways: false },
  { event: 'CUSTOMER_REPLIED', subject: 'A customer replied to a thread you own', recipients: ['OWNER'], inApp: true, externalIfAway: true, externalAlways: false },
  /**
   * MENTIONED — added 2026-09-01, engineering's, NOT a transcription of §29.2.
   *
   * Every other row above is copied from the §29.2 matrix. This one is not: the document
   * predates the internal-chat stage and has no mention row, so this is an engineering
   * decision recorded as such in STARLINK_OPEN_QUESTIONS.md (N-56) and to be confirmed
   * with the business.
   *
   * ## Why it does not contradict `MESSAGE_IN_INTERNAL_GROUP`
   *
   * That prohibition is on notifying EVERY message in a group, and it stays. §29.2's
   * governing sentence — "Notify only what someone must act on. Everything else is noise"
   * — is the reason for both: a message you were not addressed in is noise, and a message
   * that names you is the thing the sentence is protecting. The two are different events
   * and the test that the lists never overlap still holds.
   *
   * ## In-app only
   *
   * `externalIfAway: false` and `externalAlways: false`, deliberately. §29.6 makes in-app
   * "the unread mechanism" and not disableable, which is enough for a mention. Sending
   * email for one is a decision about interrupting people outside work, and that is
   * exactly the kind of thing this file must not decide on its own.
   */
  { event: 'MENTIONED', subject: 'You were mentioned in a conversation', recipients: ['MENTIONED_PRINCIPALS'], inApp: true, externalIfAway: false, externalAlways: false },
  { event: 'ROLE_OR_ACCESS_CHANGED', subject: 'Your role or access changed', recipients: ['PRINCIPAL'], inApp: true, externalIfAway: false, externalAlways: true },
  { event: 'NEW_IN_TEAM_QUEUE', subject: 'A new conversation in your team\'s queue', recipients: ['TEAM'], inApp: true, externalIfAway: false, externalAlways: false },
  // The only customer-facing row. D-12 chose email (2026-08-28); it resolves to no
  // channel until D-31 gives it an address and N-07 gives it a provider.
  { event: 'CUSTOMER_CONVERSATION_ANSWERED', subject: 'A customer\'s conversation was answered / resolved', recipients: ['CUSTOMER'], inApp: false, externalIfAway: false, externalAlways: false },
]);

/**
 * §29.2's "Not notified" list, as data.
 *
 * Present so it can be ASSERTED rather than merely intended. A future contributor adding
 * "notify on typing" has to delete a line here, which is a conversation; without it they
 * would only be adding a line somewhere else, which is not.
 */
export const NEVER_NOTIFIED: readonly string[] = Object.freeze([
  'MESSAGE_IN_INTERNAL_GROUP',
  'TYPING',
  'READ_RECEIPT',
  'DIRECTORY_CHANGED',
  'OWN_ACTION',
  // BR-26, and the one that would be a leak rather than merely noise.
  'INTERNAL_NOTE_TO_CUSTOMER',
]);

export interface RecipientContext {
  readonly principalKind: PrincipalKind;
  /**
   * No realtime connection for the configured period (§29.6). NOT presence — a phone in
   * a lift is not absence, and §21.9 forbids inferring anything from a socket. This says
   * only that an in-app badge will not be seen soon.
   */
  readonly away: boolean;
  /**
   * Per principal, per channel, per category (§29.6). In-app is absent from this on
   * purpose: it "is not disableable — it is the unread mechanism".
   */
  readonly optedOutOf: readonly NotificationChannel[];
}

/**
 * Which channels this event should reach this recipient on.
 *
 * Returns an EMPTY list where nothing should be sent, and that is a real answer. The
 * customer row returns empty until D-12's prerequisites land; a staff member who has
 * opted out of email and is not away returns in-app only.
 */
export function channelsFor(
  event: NotifiableEvent,
  recipient: RecipientContext,
): readonly NotificationChannel[] {
  const rule = NOTIFICATION_RULES.find((r) => r.event === event);
  // An event with no rule is not notified. Fail closed: adding an event to the enum must
  // not make it notifiable by default.
  if (rule === undefined) return [];

  if (recipient.principalKind === 'CUSTOMER') {
    /**
     * D-12 chose EMAIL on 2026-08-28. This still returns nothing, because two things the
     * decision depends on do not exist yet: a durable customer email address (D-31) and
     * a configured provider (N-07). See the header.
     *
     * Enqueuing against a channel with neither would accumulate undeliverable rows about
     * customers indefinitely, at a volume nobody has estimated (D-13), under a retention
     * rule nobody has set (D-06). The empty list is a prerequisite gate, not a guess.
     */
    return [];
  }

  const channels: NotificationChannel[] = [];
  // In-app first and unconditionally: §29.6 makes it the unread mechanism, so it is not
  // subject to preference at all.
  if (rule.inApp) channels.push('INAPP');

  const wantsExternal = rule.externalAlways || (rule.externalIfAway && recipient.away);
  if (wantsExternal && !recipient.optedOutOf.includes('EMAIL')) channels.push('EMAIL');

  return channels;
}

/**
 * §29.2's phrase for an event, for use as a notification subject.
 *
 * Falls back to a neutral sentence rather than the enum. An event with no rule is not
 * notifiable at all, so this should be unreachable — but if it ever is reached, a
 * recipient should see a sentence, not `CUSTOMER_REPLIED`.
 */
export const subjectFor = (event: string): string =>
  NOTIFICATION_RULES.find((rule) => rule.event === event)?.subject ??
  'You have an update in StarLink';

/** True where §29.2 says this must never generate a notification. */
export const isNeverNotified = (event: string): boolean => NEVER_NOTIFIED.includes(event);
