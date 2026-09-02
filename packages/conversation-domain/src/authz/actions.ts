/**
 * The closed vocabulary of actions.
 *
 * An action not in this set is DENIED, never treated as unrestricted (FR-AUTHZ-3,
 * doc §26.3 step 1). That is why this is a frozen set rather than a `string`: an
 * unknown permission is a bug we want to fail on, not a gap that silently opens.
 */
export const ACTIONS = [
  // conversation content
  'conversation.read',
  /**
   * Sending into an INTERNAL conversation, where there is no customer to address.
   * Distinct from `conversation.reply.customer` on purpose: colleagues talking to each
   * other is ordinary participation, whereas addressing a customer is an exercise of
   * ownership (P-03, D-04a). Collapsing the two would either lock colleagues out of
   * their own threads or hand every participant the customer's ear.
   */
  'conversation.message.send',
  'conversation.reply.customer',
  'conversation.note.internal',
  'conversation.participant.add',
  'conversation.participant.remove',
  /**
   * Renaming a group, and reacting to a message.
   *
   * Both are participation-level acts in an internal conversation, and both are named in
   * StarLink's own vocabulary rather than transcribed from a business document — the same
   * footing as `admin.notification.replay`. Neither sets a policy, a target or a category;
   * they are the operations the product performs, which is what an action is.
   *
   * They are separate actions rather than folded into `conversation.message.send` because
   * an action is the unit `decide()` refuses, and "may write in this thread" and "may
   * rename this thread" are questions somebody will eventually want to answer differently.
   */
  'conversation.rename',
  'conversation.message.react',
  /**
   * Posting into an announcement.
   *
   * The one thing that makes an announcement different from a group. `conversation.read`
   * still comes from participation, so everybody who is in one can read it; sending is a
   * separate action precisely so participation cannot grant it — see `PARTICIPANT_ACTIONS`,
   * which contains `conversation.message.send` and could not be narrowed per type without
   * this second name.
   *
   * WHICH roles hold it is a placeholder, marked as such where it is granted, and the open
   * question is recorded in STARLINK_OPEN_QUESTIONS.md. That an announcement has a distinct
   * posting right is a property of the thing; who has it is somebody else's decision.
   */
  'conversation.announcement.post',
  'conversation.attachment.upload',
  'conversation.attachment.download',

  // ownership and routing — deliberately separate from replying (P-03).
  // An advisor who may answer need not be able to re-prioritise or reassign.
  'conversation.claim',
  'conversation.assign',
  'conversation.transfer',
  'conversation.escalate',
  'conversation.cover',
  'conversation.resolve',
  'conversation.reopen',

  // case operational metadata
  'case.read',
  'case.reprioritise',
  'case.recategorise',

  // oversight and administration
  'queue.read',
  'load.read',
  'directory.read',
  'search.execute',
  'admin.account.manage',
  'admin.role.assign',
  'admin.principal.deactivate',
  'admin.config.manage',
  /**
   * Reading the account list, and reading one principal's role assignments.
   *
   * `admin.controller.ts` has checked these two strings since it was written, and neither
   * was ever in this list. `isKnownAction` therefore returned false, `decide()` returned
   * `UNKNOWN_ACTION`, and `GET /admin/accounts` and `GET /admin/roles/:principalId` were
   * **404 for everyone, including a full ADMIN** — the admin console could not list an
   * account or show a person's grants. Rule 4 working exactly as designed, against a typo.
   *
   * Naming them is not new authority: ADMIN already holds `admin.account.manage` and
   * `admin.role.assign`, which subsume a read of the same objects. It separates read from
   * write in the vocabulary, which is the direction §27 asks for and the reason the
   * controller reached for the names in the first place.
   */
  'admin.principal.read',
  'admin.role.read',
  /**
   * Inspecting and replaying the notification dead letter (ADR-006's "DLQ per queue with
   * replay tooling").
   *
   * Deliberately NOT folded into `admin.config.manage`. Configuration management is
   * editing categories, calendars and SLA targets; re-sending notifications is an
   * operational act with an external side effect. Sharing one permission would mean
   * anyone who may rename a category may also re-send a month of notifications, which is
   * a widening nobody asked for and nobody would notice.
   *
   * The NAME is ours — the action vocabulary is StarLink's own, not a business value — so
   * this is a naming choice, not a decision awaiting sign-off.
   */
  'admin.notification.replay',

  // privileged — every one of these is audited when it succeeds AND when it is refused
  'privileged.conversation.read',
  'privileged.customer.history.read',
  'privileged.pii.unmask',
  'audit.query',
] as const;

export type Action = (typeof ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

export const isKnownAction = (candidate: string): candidate is Action => ACTION_SET.has(candidate);

/**
 * Actions whose exercise is an exercise of AUTHORITY rather than ordinary work.
 *
 * Audit records authority, not activity: reading a thread you participate in adds
 * nothing, but a non-participant read of a customer's history is exactly the question
 * an incident asks (P-06, doc §31.1/§31.2).
 */
export const PRIVILEGED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'privileged.conversation.read',
  'privileged.customer.history.read',
  'privileged.pii.unmask',
  'audit.query',
  'admin.role.assign',
  'admin.principal.deactivate',
]);

/**
 * Actions that a customer principal may ever be granted.
 *
 * Everything else is denied at the operation layer for customers, before any field
 * filtering is considered (doc §27.16 — field filtering is defence in depth, never
 * the boundary).
 */
export const CUSTOMER_PERMITTED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'conversation.read',
  'conversation.reply.customer',
  'conversation.attachment.upload',
  'conversation.attachment.download',
  'conversation.reopen',
]);
