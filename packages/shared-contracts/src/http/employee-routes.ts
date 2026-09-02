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
 * The shortest term the message search will accept (FR-SRCH-5).
 *
 * Here rather than in `@starlink/search` because it is part of the HTTP CONTRACT — it
 * describes what the endpoint accepts, so both the side that enforces it and the side
 * that must not violate it read the same number.
 *
 * They did not. The server refused at 3 and the employee web app sent at 2, so typing two
 * characters produced a uniform §27.3 refusal, which the client can only render as
 * "Search is unavailable. This is not the same as no results." — an outage message for a
 * working service, shown to somebody who had simply not finished typing. The refusal is
 * deliberately indistinguishable from any other (§27.3), so the client cannot recover by
 * reading the reason; the only fix is that the two numbers cannot differ.
 *
 * `packages/shared-contracts/src/http/contract-drift.test.ts` fails the build if either
 * side stops reading this.
 */
export const SEARCH_MINIMUM_TERM_LENGTH = 3;

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
