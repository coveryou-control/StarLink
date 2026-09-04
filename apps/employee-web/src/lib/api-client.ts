/**
 * Typed API client for the employee surface.
 *
 * Carries the session cookie (HttpOnly, set by the API) via `credentials: 'include'`.
 * The token is never readable from JS and never stored here — FR-AUTH-1's whole point.
 */

import { employeeRoutes } from '@starlink/shared-contracts/http/employee';

import { runtimeOrigins } from './runtime-origins';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The API refuses by indistinguishable 404 (doc §18.6): "no such conversation" and
   * "not yours" look identical, so a probe cannot map what exists. The UI must
   * therefore treat both the same way — say it is unavailable, never "you lack
   * permission", which would leak the very existence the 404 was hiding.
   */
  get isRefusal(): boolean {
    return this.status === 404 || this.status === 403;
  }

  /** A revoked or expired session (FR-AUTH-2) — the shell must return to sign-in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    // Read per request, not once: see `runtime-origins.ts` — a module-scope read is
    // what made the origin unconfigurable in the first place.
    response = await fetch(`${runtimeOrigins().api}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // A network failure is not a refusal. Conflating them would show "unavailable" for
    // a dropped wifi connection and invite the user to assume a permission problem.
    throw new ApiError(0, 'NETWORK_UNREACHABLE', 'Could not reach the server.');
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body as { code?: string; message?: string };
    throw new ApiError(
      response.status,
      detail.code ?? 'UNKNOWN',
      detail.message ?? `Request failed with ${response.status}.`,
    );
  }

  return body as T;
}

export interface MeResponse {
  readonly principalId: string;
  readonly displayName: string;
  readonly department?: string;
  readonly teams: readonly { teamId: string; displayName: string }[];
  readonly roles: readonly { role: string; scope: unknown }[];
  /** `TEMPORARY_AUTHORITY` until HRMS/Central IAM take over — shown, never hidden. */
  readonly authority: string;
}

/** Just enough of a participant to name a conversation. Never contact details. */
export interface ConversationParticipantRef {
  readonly principalId: string;
  readonly displayName: string;
}

export interface ConversationSummary {
  readonly conversationId: string;
  readonly conversationType: string;
  readonly title?: string;
  /**
   * Who else is in the conversation. Sent for INTERNAL types only — a customer
   * conversation is named by its case, and the server omits the field entirely there.
   * Optional, so an older server simply yields the previous fallback.
   */
  readonly participants?: readonly ConversationParticipantRef[];
  readonly state?: string;
  readonly sensitivity: string;
  readonly lastActivityAt: string;
  readonly lastMessagePreview?: string;
  readonly participantCount: number;
  readonly unreadCount: number;
  /**
   * Enough for a list row to draw a tick on the newest message without opening the thread.
   *
   * `readWatermark` is the lowest read position among the OTHER participants, so a row
   * shows two ticks when `readWatermark >= lastMessageSeq` and the caller wrote it. All
   * three are optional so an older server yields no tick rather than a wrong one.
   */
  readonly lastMessageSeq?: number;
  readonly lastMessageSenderId?: string;
  /**
   * This reader's own switch for the thread — where it sits in their list.
   *
   * Never optional: false is a real answer, and an absent flag would make "not pinned"
   * indistinguishable from "not asked", which is not a state a switch can be drawn from.
   *
   * There is no mute. Being told a conversation needs you is not a per-thread preference —
   * see migration 0018.
   */
  readonly pinned: boolean;
  readonly readWatermark?: number;
}

/** One file shared in a conversation, for the information panel. Metadata only. */
export interface SharedFile {
  readonly attachmentId: string;
  readonly filename: string;
  readonly declaredBytes: number;
  readonly sharedAt: string;
  readonly uploadedBy?: string;
}

/** What a recipient may know about an attached file (§34.4 — metadata, never a key). */
export interface AttachmentView {
  readonly attachmentId: string;
  readonly filename: string;
  readonly declaredBytes: number;
  /** Only BOUND is downloadable (§28.1); anything else is still being checked. */
  readonly state: string;
}

/** A structured mention, exactly as stored. Offsets index into `body`. */
export type MentionView =
  | { readonly kind: 'PRINCIPAL'; readonly principalId: string; readonly offset: number; readonly length: number }
  | { readonly kind: 'ALL'; readonly offset: number; readonly length: number };

/**
 * Reactions on one message, grouped by emoji.
 *
 * `mine` rather than a list of principals: the client needs a count and whether to
 * highlight its own chip, and sending who reacted to what for every message on every page
 * is a small profile of who is paying attention to whom, for an ornament.
 */
export interface ReactionView {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

export interface MessageView {
  readonly messageId: string;
  readonly seq: number;
  readonly body: string;
  /** UC-E16: the message this one replies to, when it is one. */
  readonly replyToMessageId?: string;
  /**
   * What kind of message this is, when it is not an ordinary one.
   *
   * Absent means an ordinary message. `MEMBERSHIP` is a system note the participation change
   * wrote — "Neha added Vikram" — and it renders as a centred caption rather than a bubble,
   * because nobody said it.
   */
  readonly messageClass?: string;
  readonly attachments?: readonly AttachmentView[];
  readonly visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
  /** Absent for system-authored messages. Employee surface only. */
  readonly senderPrincipalId?: string;
  readonly senderDisplayName: string;
  readonly createdAt: string;
  readonly mentions?: readonly MentionView[];
  readonly reactions?: readonly ReactionView[];
  /**
   * This client's own id for the message, echoed back by the server.
   *
   * The one thing that lets an optimistic row recognise its own confirmed message. Without
   * it, the realtime event can render the real message while the send response is still in
   * flight, and the sender sees their message twice.
   */
  readonly clientMessageId?: string;
  /** Set once the body has been corrected. The renderer shows "edited" beside the time. */
  readonly editedAt?: string;
  /**
   * Set when the message was deleted. The row survives with an empty body, so the client
   * renders "this message was deleted" rather than an empty bubble — which would look
   * like a rendering fault rather than somebody's decision.
   */
  readonly redactedAt?: string;
}

/** The API returns a named collection plus an optional cursor, not a generic envelope. */
export interface ConversationPage {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor?: string;
}

export interface MessagePage {
  readonly messages: readonly MessageView[];
  readonly nextCursor?: string;
  /** §21.4's lifecycle state. Absent for an internal thread, which has none (BR-23). */
  readonly state?: string;
  /** The conversation kind - the only way to tell "internal" from "not loaded yet". */
  readonly conversationType?: string;
  /**
   * How far every OTHER participant has read (§ `read-receipts.ts`).
   *
   * On the page read rather than only on the socket, because the tick has to survive a
   * reload, a reconnect and realtime being switched off — rule 9's "recovery is re-fetch".
   * The socket frame only makes it immediate.
   */
  readonly readWatermark?: number;
}

export interface DirectoryEntry {
  readonly principalId: string;
  readonly displayName: string;
  readonly department: string;
  readonly teams: readonly { teamId: string; displayName: string }[];
  readonly status: string;
  readonly authority: string;
  /**
   * The information panel's DETAILS list. Optional, all of them: the directory is HRMS's
   * and a field it does not carry must render as an absent row, never as a blank one.
   */
  readonly employeeId?: string;
  readonly reportsTo?: string;
  readonly location?: string;
  readonly timezone?: string;
}

/** One row of a team's queue view (§23.4). No customer content — a work list. */
export interface QueueEntry {
  readonly queueEntryId: string;
  readonly conversationId: string;
  readonly priority: string;
  readonly afterHours: boolean;
  readonly enqueuedAt: string;
}

/** One person's work in flight - never anything cumulative or comparative (SL-083). */
export interface TeamMemberLoad {
  readonly principalId: string;
  readonly displayName: string;
  readonly openConversations: number;
  readonly reservedUnits: number;
  readonly capacityUnits?: number;
}

/** A team's waiting work and workload in one read (SL-083, O-07). */
export interface TeamLoad {
  readonly teamId: string;
  readonly waiting: number;
  readonly oldestWaitSeconds?: number;
  readonly afterHoursWaiting: number;
  readonly members: readonly TeamMemberLoad[];
}

export interface QueueView {
  readonly teamId: string;
  readonly entries: readonly QueueEntry[];
}

/**
 * One SLA clock, computed on read (§23.5).
 *
 * `provisional` is carried all the way to the screen on purpose: a target nobody has
 * signed off (D-22) must never be presented as a settled promise — §68 gate 8.
 */
export interface SlaClock {
  readonly clock: 'FIRST_RESPONSE' | 'RESOLUTION';
  readonly status: string;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
  readonly provisional: boolean;
}

export interface SlaView {
  readonly conversationId: string;
  readonly clocks: readonly SlaClock[];
  readonly provisional: boolean;
}

/** One search result (§30). A snippet and where it came from, never the whole message. */
export interface SearchHit {
  readonly messageId: string;
  readonly conversationId: string;
  readonly snippet: string;
  /** Who wrote it and when — see the contract for why the conversation's name is not here. */
  readonly createdAt?: string;
  readonly senderDisplayName?: string;
}

/** An in-app notification (§29.2, §19.6). Body-free by design — it points, it does not tell. */
export interface NotificationView {
  readonly notificationId: string;
  readonly event: string;
  /** §29.2's phrase for this event, sent by the API so the wording exists once. */
  readonly subject: string;
  readonly targetRef?: string;
  readonly createdAt?: string;
  /** §29.5: "3 new messages, not three notifications" — already the total, not the fold. */
  readonly count: number;
  readonly read: boolean;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const api = {
  me: () => request<MeResponse>(employeeRoutes.auth.me),

  /** Sign-in returns only the id; the shell then loads the full profile via `me()`. */
  signIn: (username: string, password: string) =>
    request<{ principalId: string }>(employeeRoutes.auth.signIn, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  signOut: () => request<void>(employeeRoutes.auth.signOut, { method: 'POST' }),

  /**
   * The caller's conversations. `scope` chooses which list — chats, or announcements.
   *
   * Two destinations over one relation, split by the server so a page is a page. Defaulted,
   * so every existing call site keeps exactly the list it had.
   */
  conversations: (options: { cursor?: string; limit?: number; scope?: 'announcements' } = {}) =>
    request<ConversationPage>(
      `${employeeRoutes.conversations.list}${query({
        cursor: options.cursor,
        limit: options.limit,
        scope: options.scope,
      })}`,
    ),

  /** Opens an announcement addressed to every active employee. */
  announce: (title: string) =>
    request<{ conversationId: string }>(employeeRoutes.conversations.announce, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  /**
   * Whether the caller may open one.
   *
   * Asked so a reader is never shown a control that answers 404. It is a convenience, not a
   * boundary: the POST decides again, and that decision is the one that counts.
   */
  mayAnnounce: () =>
    request<{ mayPost: boolean }>(employeeRoutes.conversations.announcePermission),

  /**
   * A page of a conversation — the channel's timeline, or one thread inside it.
   *
   * `thread` is a parameter rather than a second endpoint because a thread is part of the
   * conversation: same route, same authorization, same page shape.
   */
  messages: (
    conversationId: string,
    options: { cursor?: string; limit?: number; thread?: string } = {},
  ) =>
    request<MessagePage>(
      `${employeeRoutes.conversations.messages(conversationId)}${query({
        cursor: options.cursor,
        limit: options.limit,
        thread: options.thread,
      })}`,
    ),

  sendMessage: (
    conversationId: string,
    input: {
      body: string;
      visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
      /**
       * The server's idempotency key (FR-MSG-3). Named to match the API exactly: an
       * earlier version of this client sent `idempotencyKey`, which the schema silently
       * stripped — so every "retry" created a second message and nothing complained.
       */
      clientMessageId: string;
      /**
       * §28.1: an attachment becomes reachable when the message it is bound to exists,
       * so binding happens at send. A file still scanning is simply not included — the
       * response says which ones actually attached, and the send never waits for a file
       * (§34's degradation rule, brief §43 invariant 9).
       */
      attachmentIds?: readonly string[];
      /**
       * UC-E16. Scoped server-side to this conversation, so a reply cannot reference a
       * message in a thread the sender may not read.
       */
      replyToMessageId?: string;
      /**
       * Structured mentions, as offsets into `body`.
       *
       * Shape-checked by the API and MEANING-checked in the domain: every one is validated
       * against the conversation's live participants inside the send transaction, so a
       * mention of somebody who left while the message was being typed is refused rather
       * than notified.
       */
      mentions?: readonly MentionView[];
    },
  ) =>
    request<{
      messageId: string;
      seq: number;
      createdAt: string;
      duplicate: boolean;
      /**
       * Which attachments actually bound, and which did not (§28.1, §34).
       *
       * These names are the API's. The declared type here used to be
       * `attachments?: { attachmentId, bound }[]` — a shape the server has never sent, so
       * `notAttachedIds` was invisible to every caller and a file that failed to bind was
       * reported to the person as attached. A response field nobody reads is worse than a
       * missing one: it looks handled.
       *
       * Not optional. The handler returns both arrays on every successful send, and making
       * them optional invites `?? []`, which is how "nothing failed" and "I did not look"
       * become the same expression.
       */
      attachedIds: readonly string[];
      notAttachedIds: readonly string[];
    }>(employeeRoutes.conversations.messages(conversationId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Whether an upload has finished scanning and can now be bound (§28.1).
   *
   * Polled by the attachment picker between "the bytes arrived" and "this is genuinely
   * ready to send". Uploader-only server-side; a refusal is the uniform 404.
   */
  attachmentStatus: (attachmentId: string) =>
    request<{ state: string }>(employeeRoutes.attachments.status(attachmentId)),

  /** Advances the read marker. Monotonic server-side, so a late call cannot rewind it. */
  /* ---------------------------------------------------- internal conversations (SL-001/002) */

  /**
   * Starts a 1:1 or group internal conversation (SL-001, SL-002).
   *
   * The route existed, guarded and tested, from Phase 2; no client method and no screen
   * called it, so an employee could read conversations they were already in and could not
   * begin one. Found on 2026-08-29 by the route-to-client scan.
   *
   * `existing` is returned, not swallowed: a 1:1 between the same two people is idempotent
   * (BR-05), so asking twice reopens the same thread rather than making a second one, and
   * the caller should navigate to it rather than report a failure.
   */
  createConversation: (input: {
    type: 'INTERNAL_DIRECT' | 'INTERNAL_GROUP';
    participantIds: readonly string[];
    title?: string;
  }) =>
    request<{ conversationId: string; existing: boolean }>(employeeRoutes.conversations.create, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Adds someone to a conversation (SL-002, BR-07).
   *
   * `historyExposureAcknowledged` is required by the server and is not a formality: adding
   * a participant exposes everything already said. The API refuses without it, and the UI
   * must therefore have actually asked.
   *
   * Returns how many messages became readable, so the interface can say what just happened
   * rather than implying nothing did.
   */
  addParticipant: (conversationId: string, principalId: string) =>
    request<{ messagesExposed: number }>(employeeRoutes.conversations.participants(conversationId), {
      method: 'POST',
      body: JSON.stringify({ principalId, historyExposureAcknowledged: true }),
    }),

  /** Removes a participant. History already read stays read — removal is not redaction. */
  removeParticipant: (conversationId: string, principalId: string) =>
    request<void>(employeeRoutes.conversations.participant(conversationId, principalId), {
      method: 'DELETE',
    }),

  /* ---------------------------------------------------- attachments (SL-054/055/056) */

  /**
   * Asks for a scoped, pre-signed upload grant (ADR-012, §28.1-28.3).
   *
   * The API never sees the bytes — SL-054's acceptance is literally "API not byte
   * bottleneck" — so this returns a URL the browser PUTs to directly. Authorization
   * happens here, before any object exists: §28.1 rejects before bytes rather than after.
   *
   * A 503 means storage is down (§34.4). That is deliberately distinguishable from the
   * uniform 404, because a 404 would tell the person their file does not exist and invite
   * them to upload it again.
   */
  requestUpload: (
    conversationId: string,
    file: { filename: string; declaredMime: string; declaredBytes: number },
  ) =>
    request<{ attachmentId: string; uploadUrl: string; expiresAt: string }>(
      employeeRoutes.conversations.attachments(conversationId),
      { method: 'POST', body: JSON.stringify(file) },
    ),

  /**
   * PUTs the bytes to the grant's own URL — NOT to the API.
   *
   * Deliberately not routed through `request`: this call does not carry the session
   * cookie and must not, because the grant is the authorization. Sending credentials to a
   * storage origin would be handing them to a host that has no business holding them.
   *
   * The grant URL may be RELATIVE. The development driver serves its objects from the API
   * itself and returns a path, so that no process has to be told its own public origin —
   * a question it cannot answer correctly from behind a proxy. `new URL(url, base)` leaves
   * an absolute URL untouched, so a real S3 driver's pre-signed link is unaffected and no
   * caller needs to know which driver is installed.
   */
  uploadBytes: async (uploadUrl: string, file: Blob): Promise<void> => {
    const target = new URL(uploadUrl, runtimeOrigins().api).toString();
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      throw new ApiError(response.status, 'UPLOAD_FAILED', 'The file could not be uploaded.');
    }
  },

  /** The client saying "I finished" — a hint that moves the object into scanning (§28.4). */
  markUploaded: (attachmentId: string) =>
    request<{ state: string }>(employeeRoutes.attachments.uploaded(attachmentId), {
      method: 'POST',
    }),

  /**
   * A short-lived, single-object download grant, issued only after §28.4's full ladder
   * and audited at issuance (FR-ATT-5).
   */
  downloadAttachment: async (attachmentId: string) => {
    const grant = await request<{ url: string; filename: string }>(
      employeeRoutes.attachments.download(attachmentId),
    );
    // Resolved here for the same reason as `uploadBytes`: the development driver serves
    // objects from the API and returns a path. A relative URL handed to `window.open`
    // would resolve against the WEB origin and 404 — the file would read as lost.
    return { ...grant, url: new URL(grant.url, runtimeOrigins().api).toString() };
  },

  /* ---------------------------------------------------- queue and ownership (§21.7-21.9) */

  /** A team's waiting work, oldest first (§23.4). SL-006's "no invisible waiting". */
  queue: (teamId: string, limit = 50) =>
    request<QueueView>(`${employeeRoutes.queues.one(teamId)}${query({ limit })}`),

  /**
   * A team's load and waiting work (SL-083, O-07).
   *
   * One request rather than the queue plus an SLA call per conversation: the screen that
   * needs this is the one opened when the team is busiest.
   */
  teamLoad: (teamId: string) => request<TeamLoad>(employeeRoutes.queues.load(teamId)),

  /**
   * Takes a waiting conversation (SL-037, golden G-06/G-07).
   *
   * Losing the race is a 200 with `ALREADY_ASSIGNED`, not an error — the API is explicit
   * that an error status would be retried by a well-behaved client, turning one settled
   * race into a loop. The UI shows "someone else took this" and refreshes.
   */
  claim: (conversationId: string, idempotencyKey: string) =>
    request<{ outcome: 'CLAIMED' | 'ALREADY_ASSIGNED'; episodeId?: string }>(
      employeeRoutes.conversations.claim(conversationId),
      { method: 'POST', body: JSON.stringify({ idempotencyKey }) },
    ),

  /** BR-15: every ownership change carries a reason. The API refuses without one. */
  transfer: (conversationId: string, toOwner: string, reason: string) =>
    request<{ episodeId: string }>(employeeRoutes.conversations.transfer(conversationId), {
      method: 'POST',
      body: JSON.stringify({ toOwner, reason }),
    }),

  escalate: (conversationId: string, toOwner: string, reason: string) =>
    request<{ episodeId: string; level: number }>(
      employeeRoutes.conversations.escalate(conversationId),
      { method: 'POST', body: JSON.stringify({ toOwner, reason }) },
    ),

  /** §21.9 cases A and D. Ownership does NOT move, and the response says so. */
  cover: (conversationId: string, covererId: string, reason: string, untilIso: string) =>
    request<{ grantId: string; ownerUnchanged: boolean; until: string }>(
      employeeRoutes.conversations.cover(conversationId),
      { method: 'POST', body: JSON.stringify({ covererId, reason, untilIso }) },
    ),

  /* ---------------------------------------------------- lifecycle (§21.4, BR-19/BR-20) */

  /** BR-19: only the owner or a lead, and an outcome is recorded. */
  resolve: (conversationId: string, outcome: string) =>
    request<{ outcome: 'RESOLVED' | 'STATE_CHANGED'; from?: string }>(
      employeeRoutes.conversations.resolve(conversationId),
      { method: 'POST', body: JSON.stringify({ outcome }) },
    ),

  /** §21.4 requires a reason when a staff member reopens, which this always is. */
  reopen: (conversationId: string, reason: string) =>
    request<{ outcome: 'REOPENED' | 'STATE_CHANGED' }>(
      employeeRoutes.conversations.reopen(conversationId),
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /** Employee-only. §22.5 gives the customer "Never" for SLA state. */
  sla: (conversationId: string) =>
    request<SlaView>(employeeRoutes.conversations.sla(conversationId)),

  /* ---------------------------------------------------- notifications (§29.2, §19.6) */

  notifications: (limit = 20) =>
    request<{ notifications: readonly NotificationView[] }>(
      `${employeeRoutes.notifications.list}${query({ limit })}`,
    ),

  notificationCount: () => request<{ unread: number }>(employeeRoutes.notifications.count),

  /* ------------------------------------------------------------- internal chat (2026-09-01) */

  /** Renames an internal group. Refused for a 1:1 or a customer conversation. */
  renameConversation: (conversationId: string, title: string) =>
    request<{ title: string }>(employeeRoutes.conversations.rename(conversationId), {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  /**
   * Adds or removes ONE of the caller's own reactions.
   *
   * `changed: false` is a normal outcome, not an error — the primary key is the whole
   * tuple, so reacting twice is idempotent and un-reacting something you never reacted to
   * is a no-op.
   */
  react: (conversationId: string, messageId: string, emoji: string) =>
    request<{ changed: boolean }>(employeeRoutes.conversations.reactions(conversationId, messageId), {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),

  /** Corrects one of the caller's OWN messages. `edited: false` means nothing changed. */
  editMessage: (conversationId: string, messageId: string, body: string) =>
    request<{ edited: boolean; editedAt?: string }>(
      employeeRoutes.conversations.message(conversationId, messageId),
      { method: 'PATCH', body: JSON.stringify({ body }) },
    ),

  /**
   * Deletes one of the caller's OWN messages.
   *
   * A redaction, not a row removal: the message stays in the thread with its text gone, so
   * the sequence has no gap and a reply pointing at it still resolves.
   */
  deleteMessage: (conversationId: string, messageId: string) =>
    request<{ redacted: boolean }>(
      employeeRoutes.conversations.message(conversationId, messageId),
      { method: 'DELETE' },
    ),

  unreact: (conversationId: string, messageId: string, emoji: string) =>
    request<{ changed: boolean }>(employeeRoutes.conversations.reactions(conversationId, messageId), {
      method: 'DELETE',
      body: JSON.stringify({ emoji }),
    }),

  markNotificationRead: (notificationId: string) =>
    request<{ read: boolean }>(employeeRoutes.notifications.read(notificationId), {
      method: 'POST',
    }),

  markAllNotificationsRead: () =>
    request<{ read: number }>(employeeRoutes.notifications.readAll, { method: 'POST' }),

  markRead: (conversationId: string, upToSeq: number) =>
    request<{ lastReadSeq: number }>(employeeRoutes.conversations.read(conversationId), {
      method: 'POST',
      body: JSON.stringify({ upToSeq }),
    }),

  /** Sets this reader's preference for one thread. Today that is where it sits. */
  /**
   * `limitReached` is a SUCCESSFUL response, not an error.
   *
   * The server caps pinning at `MAX_PINNED_CONVERSATIONS` inside the statement that writes,
   * so the fourth pin is refused by the database rather than by a check that could race.
   * That refusal comes back as `{ pinned: false, limitReached: true }` — the request was
   * valid and the caller is allowed; they simply already have three. Throwing here would
   * make the caller render "that could not be saved", which is both wrong and unhelpful.
   */
  setConversationPreferences: (conversationId: string, preferences: { pinned: boolean }) =>
    request<{ pinned: boolean; limitReached?: boolean; maxPinned?: number }>(
      employeeRoutes.conversations.preferences(conversationId),
      {
        method: 'PUT',
        body: JSON.stringify(preferences),
      },
    ),

  /** Ends every session this account holds, including this browser's. */
  signOutEverywhere: () =>
    request<void>(employeeRoutes.auth.signOutEverywhere, { method: 'POST' }),

  /** What this account has uploaded that is still reachable. */
  storage: () => request<{ files: number; bytes: number }>(employeeRoutes.auth.storage),

  /** Everything BOUND in a conversation, newest first. */
  sharedFiles: (conversationId: string) =>
    request<{ files: readonly SharedFile[] }>(
      employeeRoutes.conversations.attachments(conversationId),
    ),

  /** The caller's own teammates, with no search term — see the route's own note. */
  colleagues: () =>
    request<{ entries: readonly DirectoryEntry[] }>(employeeRoutes.directory.colleagues),

  /**
   * One colleague, for the information panel beside a one-to-one.
   *
   * The route answers `{ employee }`, like every other projection here answers a named
   * envelope — unwrapped at the edge so the component never has to know the shape twice.
   */
  colleague: async (principalId: string): Promise<DirectoryEntry> =>
    (await request<{ employee: DirectoryEntry }>(employeeRoutes.directory.one(principalId)))
      .employee,

  directory: (search: string) =>
    request<{ entries: readonly DirectoryEntry[] }>(
      `${employeeRoutes.directory.search}${query({ q: search })}`,
    ),

  /**
   * SL-081. Scope is enforced server-side — an unscoped search does not compile there —
   * so this passes only the term and the API decides what the caller may see.
   *
   * The result is a SNIPPET, not a message: §30 returns what matched, and the thread is
   * where the message is read. The previous type here claimed `MessageView[]`, which the
   * API has never returned; nothing caught it because nothing called the method.
   *
   * `matched` is a BOOLEAN, not a count. `packages/search/src/search-messages.ts` returns
   * `matched: result.value.items.length > 0` and the controller passes it through, but
   * this declared `number` — a lie the compiler cannot catch, because the response is
   * asserted at the boundary rather than parsed. The sidebar rendered `{matched}` into
   * "N matching messages" and got a boolean, which React draws as nothing: the line read
   * " matching messages" with no number, and the zero branch (`matched === 0`) could never
   * be true, so "no results" never appeared either.
   *
   * It is the right shape for what FR-SRCH-4 actually asks — "we looked and found
   * nothing" versus "we could not look" is a yes/no — so the type is corrected to match
   * the server rather than the server changed to match the type.
   */
  /**
   * `conversationId` narrows the same search to one thread.
   *
   * A parameter rather than a second endpoint, and the server has accepted it since the
   * route was written — the client simply never sent it, so "search in this conversation"
   * was unreachable from a product that already implemented it.
   */
  /** Files by name, across the caller's own conversations. The Search screen's third tab. */
  searchFiles: (term: string) =>
    request<{ files: readonly (SharedFile & { conversationId: string })[] }>(
      `${employeeRoutes.search.files}${query({ q: term })}`,
    ),

  search: (term: string, conversationId?: string) =>
    request<{ matched: boolean; results: readonly SearchHit[] }>(
      `${employeeRoutes.search.messages}${query({ q: term, conversationId })}`,
    ),
};
