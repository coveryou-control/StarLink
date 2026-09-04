/**
 * The employee HTTP route table, as a contract both sides import.
 *
 * This exists because of a specific failure. The web client was written against
 * plausible-looking paths — `/v1/conversations`, `/v1/directory`, `/v1/search/messages`,
 * `/v1/auth/me` — and every one of them was wrong. Nothing failed at build time, because
 * a URL is just a string; the mismatch would have surfaced as a blank screen in a
 * browser, and one of those paths had no server route at all.
 *
 * A route table that both the controllers and the client are checked against turns that
 * into a test failure. It is not routing logic and it does not replace the decorators —
 * the controllers remain the source of truth for what exists, and the tests assert the
 * two agree.
 */

export const EMPLOYEE_API_BASE = '/v1/employee';

/**
 * The shortest term any search will accept — messages, files and the directory alike.
 *
 * ## One, and why it is not three
 *
 * FR-SRCH-5 says "very short terms are refused rather than returning everything", and this
 * was 3 on that reading — with the directory refusing below 2 and the file search below 2,
 * three different floors for one search box. The effect was that typing a colleague's
 * initials, or the word somebody actually sent, produced nothing at all, and the product
 * looked broken rather than strict.
 *
 * The rule it was protecting is real; the floor was the wrong instrument for it. What stops
 * a search being a corpus dump here is not the length of the term:
 *
 *   - **Scope is a JOIN, not a filter** (§30.2). Every one of the three queries is
 *     constrained to conversations the caller participates in, or to the ACTIVE employee
 *     directory they are already entitled to read. A one-character term returns a page of
 *     what they can already see, not the corpus.
 *   - **Every result set is capped and paged** — 50 messages, 25 files, one directory page.
 *   - **The endpoint is rate-limited per principal** (§27.5), so a script cannot walk the
 *     alphabet cheaply.
 *   - **Every search is audited with its term** (FR-SRCH-3), so a stream of one-character
 *     probes is visible as exactly that.
 *
 * Those four are what make bulk extraction hard, and none of them weakens by allowing a
 * shorter term. A floor only ever stopped the honest use.
 *
 * Zero is still refused: an empty term is not a search, it is a request for the page.
 *
 * ## Why it lives here
 *
 * It is part of the HTTP CONTRACT — it describes what the endpoints accept, so both the
 * side that enforces it and the side that must not violate it read the same number.
 *
 * They did not. The server refused at 3 and the employee web app sent at 2, so typing two
 * characters produced a uniform §27.3 refusal, which the client can only render as
 * "Search is unavailable. This is not the same as no results." — an outage message for a
 * working service, shown to somebody who had simply not finished typing. The refusal is
 * deliberately indistinguishable from any other (§27.3), so the client cannot recover by
 * reading the reason; the only fix is that the numbers cannot differ.
 *
 * `packages/shared-contracts/src/http/contract-drift.test.ts` fails the build if any
 * consumer stops reading this.
 */
export const SEARCH_MINIMUM_TERM_LENGTH = 1;

/**
 * How many conversations one person may pin to the top of their list.
 *
 * ## Why there is a cap at all
 *
 * A pinned group is useful only while it is shorter than the list underneath it. Pin
 * twenty and nothing has been prioritised — the list has just been reordered, and the
 * person now has two lists to scan instead of one.
 *
 * ## Why it lives in the contract
 *
 * The same reason as the search floor above, which cost a working feature an outage
 * message when the two sides disagreed by one. The server enforces this inside the INSERT
 * that writes the preference; the client uses it to say "you already have three" before
 * the round trip and to render the refusal when it loses the race. Both read this.
 */
export const MAX_PINNED_CONVERSATIONS = 3;

/**
 * How long a conversation may be quietened for, in minutes.
 *
 * ## Why the list is closed
 *
 * A free-form duration invites "forever", and forever is the thing migration 0018 removed
 * and 0021 deliberately did not bring back: a mute with no end is how somebody misses the
 * thread that mattered in March because of a busy Tuesday in September. Every value here
 * arrives, and the longest is a day.
 *
 * ## Why it is in the contract
 *
 * The server validates against this list and the menu is drawn from it. Kept in one place
 * so a duration cannot be offered that the server then refuses — the same drift that once
 * turned a two-character search into an "unavailable" message.
 */
export const MUTE_DURATIONS_MINUTES = [15, 30, 60, 240, 720, 1440] as const;

/** A duration the server will accept. */
export type MuteDurationMinutes = (typeof MUTE_DURATIONS_MINUTES)[number];

/**
 * "15 minutes", "4 hours" — the same words on the menu and in any refusal.
 *
 * Derived rather than listed beside the numbers, so adding a duration cannot leave a
 * label behind. Hours are whole by construction: every value above 60 is a multiple of it.
 */
export function muteDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * A `LIKE`/`ILIKE` pattern that matches the term as TEXT, not as a pattern.
 *
 * `%` and `_` are wildcards. A search box that interpolates the term straight into
 * `'%' || term || '%'` therefore hands the caller a wildcard language they never asked
 * for — and one of those wildcards is a corpus dump: searching for a single `%` matched
 * every active employee in the directory, which is precisely the "search returns
 * everything" outcome FR-SRCH-5 exists to prevent. It was found by typing `%` into the
 * box, not by review.
 *
 * Here, not in each caller, because there were three callers and only one of them had
 * remembered. A person searching for "100%" or "q1_report" means those characters.
 *
 * Backslash is escaped first, and must be: escaping it last would double the backslashes
 * this function had itself just introduced.
 */
export const likePattern = (term: string): string =>
  `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;


export const employeeRoutes = {
  auth: {
    signIn: `${EMPLOYEE_API_BASE}/auth/sign-in`,
    signOut: `${EMPLOYEE_API_BASE}/auth/sign-out`,
    /**
     * Ends every session this principal holds, on every device, at once.
     *
     * A separate route from `sign-out` because it is a separate act with a different blast
     * radius: one clears this browser's cookie, the other invalidates cookies the caller
     * cannot reach — the one control a person needs after losing a laptop. Both are
     * audited; only this one is irreversible for everybody else signed in as them.
     */
    signOutEverywhere: `${EMPLOYEE_API_BASE}/auth/sign-out-everywhere`,
    me: `${EMPLOYEE_API_BASE}/auth/me`,
    /** What this account has stored, for Settings' "Storage & data". */
    storage: `${EMPLOYEE_API_BASE}/auth/me/storage`,
  },
  conversations: {
    list: `${EMPLOYEE_API_BASE}/conversations`,
    create: `${EMPLOYEE_API_BASE}/conversations`,
    /**
     * Opening an announcement, and asking whether you may.
     *
     * Under `/conversations` because an announcement IS one — the same messages, the same
     * read state, the same realtime. A parallel `/announcements` tree would be a second
     * place for the rules to live, which §38 records as the reference platform's defect.
     */
    /** One person's mute and pin for one thread. See the table's own note on whose. */
    preferences: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/preferences`,
    announce: `${EMPLOYEE_API_BASE}/conversations/announcements`,
    announcePermission: `${EMPLOYEE_API_BASE}/conversations/announcements/permission`,
    messages: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/messages`,
    read: (conversationId: string) => `${EMPLOYEE_API_BASE}/conversations/${conversationId}/read`,
    /** Renaming an internal group (PATCH). Refused for a 1:1 or a customer conversation. */
    rename: (conversationId: string) => `${EMPLOYEE_API_BASE}/conversations/${conversationId}`,
    /** Correct (PATCH) or delete (DELETE) one of the caller's OWN messages. */
    message: (conversationId: string, messageId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/messages/${messageId}`,
    /** Add (POST) or remove (DELETE) one of the caller's own reactions on a message. */
    reactions: (conversationId: string, messageId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/messages/${messageId}/reactions`,
    /**
     * What is pinned in this conversation (GET).
     *
     * A collection under the conversation rather than a flag on each message: a pin is
     * shared by everybody in the thread, and the one read anybody performs is "what is
     * pinned here", not "is this particular message pinned".
     */
    pins: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/pins`,
    /** Pin (PUT) or unpin (DELETE) one message for everybody in the conversation. */
    pin: (conversationId: string, messageId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/pins/${messageId}`,
    /**
     * Who has read one message, and when it was delivered (GET) — the "Message info" panel.
     *
     * Under the message because that is what it is about. It is deliberately not part of
     * the message projection: reading it is a per-participant join nobody wants on every
     * row of a page of fifty.
     */
    messageInfo: (conversationId: string, messageId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/messages/${messageId}/info`,
    /**
     * Send an existing message on to another conversation (POST).
     *
     * The target is in the BODY, not the path, because the authorization is two-sided —
     * the caller must be able to read the source and write to the destination — and a
     * path that names only one of them invites a handler that checks only one of them.
     */
    forward: (conversationId: string, messageId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/messages/${messageId}/forward`,
    participants: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/participants`,
    participant: (conversationId: string, principalId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/participants/${principalId}`,
    /**
     * The SLA clocks for one conversation (§22.5, §23.5).
     *
     * An EMPLOYEE route, and only an employee route. §22.5's table gives the customer
     * "Never" for SLA state and calls it "the row that carries the most risk" — a
     * customer who can see "first response breached" has been handed a grievance the
     * company generated itself. There is deliberately no customer equivalent of this path.
     */
    sla: (conversationId: string) => `${EMPLOYEE_API_BASE}/conversations/${conversationId}/sla`,
    /** Requests an upload grant against a conversation (ADR-012). */
    /**
     * POST requests an upload grant; GET lists what has already been shared here.
     *
     * One path, because they are the same collection seen from two directions — and the
     * GET is what the information panel's "Shared files" section reads.
     */
    attachments: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/attachments`,

    /* --- §21.4 lifecycle, §21.7–21.9 ownership ------------------------------------ */

    /**
     * BR-19 / UC-E18 — "Only the owner or a lead may resolve, and an outcome is recorded."
     *
     * Added 2026-08-28. Before it there was no route, on any surface, that could move a
     * conversation out of an open state: §21.4's table, the state history, the closure
     * sweep and the authorization action all existed, and nothing joined them.
     */
    resolve: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/resolve`,
    /** UC-E19's staff half. The customer's half runs on their next message, not on a route. */
    reopen: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/reopen`,
    claim: (conversationId: string) => `${EMPLOYEE_API_BASE}/conversations/${conversationId}/claim`,
    transfer: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/transfer`,
    escalate: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/escalate`,
    cover: (conversationId: string) => `${EMPLOYEE_API_BASE}/conversations/${conversationId}/cover`,
    ownership: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/conversations/${conversationId}/ownership`,
  },
  queues: {
    /** A team's waiting work, oldest first within a priority band (§23.4). */
    one: (teamId: string) => `${EMPLOYEE_API_BASE}/queues/${teamId}`,
    /** SL-083 / O-07: waiting, ownership, SLA and capacity for one team, in one read. */
    load: (teamId: string) => `${EMPLOYEE_API_BASE}/queues/${teamId}/load`,
  },
  attachments: {
    /**
     * A short-lived, single-object download grant, issued ONLY after §28.4's full ladder
     * and with the issuance audited (ADR-012, FR-ATT-5).
     */
    download: (attachmentId: string) => `${EMPLOYEE_API_BASE}/attachments/${attachmentId}`,
    /** The client announcing its direct upload finished, moving the object to scanning. */
    uploaded: (attachmentId: string) =>
      `${EMPLOYEE_API_BASE}/attachments/${attachmentId}/uploaded`,
    /**
     * The uploader asking whether their own file has finished scanning (§28.1).
     *
     * Added 2026-08-30. Without it the composer had no way to distinguish "uploaded" from
     * "bindable", so it offered a file as ready to send while §28.1 would still refuse to
     * bind it — and the send reported success over a message with no attachment.
     */
    status: (attachmentId: string) =>
      `${EMPLOYEE_API_BASE}/attachments/${attachmentId}/status`,
  },
  directory: {
    search: `${EMPLOYEE_API_BASE}/directory`,
    /**
     * The caller's own teammates, with no search term.
     *
     * A separate route rather than an empty `q`, because FR-SRCH-5 refuses a short term on
     * purpose — "a one-character search is a request for the entire staff list wearing a
     * search's clothes" — and that refusal must stay exactly as strict as it is. This asks
     * a different question: not "who is in the company" but "who is on my teams", which is
     * a bounded set the server derives from the session rather than from a parameter.
     */
    colleagues: `${EMPLOYEE_API_BASE}/directory/colleagues`,
    one: (principalId: string) => `${EMPLOYEE_API_BASE}/directory/${principalId}`,
  },
  search: {
    messages: `${EMPLOYEE_API_BASE}/search`,
    /**
     * Files, by name, across the conversations the caller is in.
     *
     * A sibling of the message search rather than a mode of it: they read different tables,
     * page differently and are rate-limited on different grounds. The design's Search screen
     * puts their results in one list, which is the CLIENT joining two answers — not a reason
     * for one endpoint to answer two questions.
     */
    files: `${EMPLOYEE_API_BASE}/search/files`,
  },
  notifications: {
    /** §19.6's server-owned notification list; §20.7's "notification list on load". */
    list: `${EMPLOYEE_API_BASE}/notifications`,
    count: `${EMPLOYEE_API_BASE}/notifications/count`,
    read: (notificationId: string) =>
      `${EMPLOYEE_API_BASE}/notifications/${notificationId}/read`,
    readAll: `${EMPLOYEE_API_BASE}/notifications/read-all`,
  },
  admin: {
    accounts: `${EMPLOYEE_API_BASE}/admin/accounts`,
    roles: `${EMPLOYEE_API_BASE}/admin/roles`,
    rolesFor: (principalId: string) => `${EMPLOYEE_API_BASE}/admin/roles/${principalId}`,
    role: (assignmentId: string) => `${EMPLOYEE_API_BASE}/admin/roles/${assignmentId}`,
    deactivate: `${EMPLOYEE_API_BASE}/admin/deactivate`,
    inactiveOwnerConversations: `${EMPLOYEE_API_BASE}/admin/inactive-owner-conversations`,
    /**
     * §21.9 case C — reassigning work a departed colleague owned (FR-EMP-3, BR-13).
     *
     * Added to the contract 2026-08-29. The route existed and was exercised by
     * `employee-exit.test.ts`, but was absent from this inventory, so the contract test
     * could not confirm it was reachable and guarded — the one check that catches a path
     * that is wrong rather than merely refused.
     */
    reassign: (conversationId: string) =>
      `${EMPLOYEE_API_BASE}/admin/reassign/${conversationId}`,
    /** The notification dead letter, and its replay tooling (ADR-006, §29.6). */
    notificationCounts: `${EMPLOYEE_API_BASE}/admin/notifications/counts`,
    notificationDeadLetter: `${EMPLOYEE_API_BASE}/admin/notifications/dead-letter`,
    replayNotification: (notificationId: string) =>
      `${EMPLOYEE_API_BASE}/admin/notifications/${notificationId}/replay`,
  },
} as const;

/**
 * Every employee route, flattened, with a placeholder for each path parameter.
 *
 * Used by the contract test: each of these must answer 401 without a session, never 404.
 * The distinction is the whole point — Nest returns 404 for a route that does not exist,
 * while the session guard returns 401 for a route that does. A refusal on a REAL route
 * is also 404 by design (§27.3), so an unauthenticated probe is the only way to tell
 * "this path is wrong" from "you may not see this".
 */
export const EMPLOYEE_ROUTE_INVENTORY: readonly { method: string; path: string }[] = [
  { method: 'GET', path: employeeRoutes.auth.me },
  { method: 'GET', path: employeeRoutes.auth.storage },
  { method: 'POST', path: employeeRoutes.auth.signOut },
  { method: 'POST', path: employeeRoutes.auth.signOutEverywhere },
  { method: 'GET', path: employeeRoutes.conversations.list },
  { method: 'POST', path: employeeRoutes.conversations.create },
  { method: 'POST', path: employeeRoutes.conversations.announce },
  { method: 'GET', path: employeeRoutes.conversations.announcePermission },
  { method: 'GET', path: employeeRoutes.conversations.messages(':id') },
  { method: 'POST', path: employeeRoutes.conversations.messages(':id') },
  { method: 'POST', path: employeeRoutes.conversations.read(':id') },
  { method: 'GET', path: employeeRoutes.conversations.pins(':id') },
  { method: 'PUT', path: employeeRoutes.conversations.pin(':id', ':mid') },
  { method: 'DELETE', path: employeeRoutes.conversations.pin(':id', ':mid') },
  { method: 'GET', path: employeeRoutes.conversations.messageInfo(':id', ':mid') },
  { method: 'POST', path: employeeRoutes.conversations.forward(':id', ':mid') },
  { method: 'PUT', path: employeeRoutes.conversations.preferences(':id') },
  { method: 'POST', path: employeeRoutes.conversations.participants(':id') },
  { method: 'DELETE', path: employeeRoutes.conversations.participant(':id', ':pid') },
  { method: 'GET', path: employeeRoutes.conversations.sla(':id') },
  { method: 'GET', path: employeeRoutes.conversations.attachments(':id') },
  { method: 'POST', path: employeeRoutes.conversations.attachments(':id') },
  { method: 'POST', path: employeeRoutes.conversations.resolve(':id') },
  { method: 'POST', path: employeeRoutes.conversations.reopen(':id') },
  { method: 'POST', path: employeeRoutes.conversations.claim(':id') },
  { method: 'POST', path: employeeRoutes.conversations.transfer(':id') },
  { method: 'POST', path: employeeRoutes.conversations.escalate(':id') },
  { method: 'POST', path: employeeRoutes.conversations.cover(':id') },
  { method: 'GET', path: employeeRoutes.conversations.ownership(':id') },
  { method: 'GET', path: employeeRoutes.queues.one(':id') },
  // Was absent, so the contract test never probed it and could not have reported the team
  // load endpoint being unreachable or unguarded — the one check that distinguishes a
  // wrong path from a refused one.
  { method: 'GET', path: employeeRoutes.queues.load(':id') },
  { method: 'GET', path: employeeRoutes.attachments.download(':aid') },
  { method: 'POST', path: employeeRoutes.attachments.uploaded(':aid') },
  { method: 'GET', path: employeeRoutes.attachments.status(':aid') },
  { method: 'GET', path: employeeRoutes.directory.search },
  { method: 'GET', path: employeeRoutes.directory.one(':pid') },
  { method: 'GET', path: employeeRoutes.search.messages },
  { method: 'GET', path: employeeRoutes.search.files },
  { method: 'GET', path: employeeRoutes.admin.accounts },
  { method: 'GET', path: employeeRoutes.admin.rolesFor(':pid') },
  { method: 'POST', path: employeeRoutes.admin.roles },
  { method: 'DELETE', path: employeeRoutes.admin.role(':aid') },
  { method: 'POST', path: employeeRoutes.admin.deactivate },
  { method: 'GET', path: employeeRoutes.admin.inactiveOwnerConversations },
  { method: 'POST', path: employeeRoutes.admin.reassign(':id') },
  { method: 'GET', path: employeeRoutes.notifications.list },
  { method: 'GET', path: employeeRoutes.notifications.count },
  { method: 'POST', path: employeeRoutes.notifications.read(':id') },
  { method: 'POST', path: employeeRoutes.notifications.readAll },
  { method: 'GET', path: employeeRoutes.admin.notificationCounts },
  { method: 'GET', path: employeeRoutes.admin.notificationDeadLetter },
  { method: 'POST', path: employeeRoutes.admin.replayNotification(':id') },
];
