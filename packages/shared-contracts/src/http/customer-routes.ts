/**
 * The customer HTTP route table (§25.3).
 *
 * A SEPARATE module from the employee table, and reachable by its own subpath export,
 * because of ADR-004. `customer-web` imports only this file; importing the shared barrel
 * pulled the entire employee route map — admin account and role paths included — into
 * the public customer bundle, which the bundle-inspection guard caught.
 *
 * Route paths are not secrets, but internal structure in a customer's browser is the
 * thin end of the wedge: a barrel re-exports more over time, and nobody re-checks. Two
 * files with two entry points make the separation structural rather than incidental.
 */
export const CUSTOMER_API_BASE = '/v1/customer';

/**
 * The customer route table (§25.3).
 *
 * Kept beside the employee one so the two are visibly disjoint. A route appearing in
 * both lists would be the first sign of a surface leaking into the other, and that is
 * easier to see in one file than across two controllers.
 */
export const customerRoutes = {
  auth: {
    startSession: `${CUSTOMER_API_BASE}/auth/session`,
    verifyStart: `${CUSTOMER_API_BASE}/auth/verify/start`,
    verifyComplete: `${CUSTOMER_API_BASE}/auth/verify/complete`,
    endSession: `${CUSTOMER_API_BASE}/auth/end`,
  },
  categories: `${CUSTOMER_API_BASE}/categories`,
  conversations: {
    list: `${CUSTOMER_API_BASE}/conversations`,
    intake: `${CUSTOMER_API_BASE}/conversations`,
    messages: (conversationId: string) =>
      `${CUSTOMER_API_BASE}/conversations/${conversationId}/messages`,
    /**
     * Upload grant. Permitted only where D-07 allows — Claims, as answered 2026-08-27 —
     * and refused with the same uniform 404 as anything else a customer may not do.
     */
    attachments: (conversationId: string) =>
      `${CUSTOMER_API_BASE}/conversations/${conversationId}/attachments`,
  },
  attachments: {
    download: (attachmentId: string) => `${CUSTOMER_API_BASE}/attachments/${attachmentId}`,
    uploaded: (attachmentId: string) =>
      `${CUSTOMER_API_BASE}/attachments/${attachmentId}/uploaded`,
  },
} as const;

/**
 * Customer routes that REQUIRE a session.
 *
 * `startSession` and `categories` are public and excluded: §21.5 has the customer browse
 * topics before identity, and making it precede the SESSION too means abandoning at the
 * topic step leaves nothing behind — no principal row, no audit entry.
 */
export const CUSTOMER_ROUTE_INVENTORY: readonly { method: string; path: string }[] = [
  { method: 'POST', path: customerRoutes.auth.verifyStart },
  { method: 'POST', path: customerRoutes.auth.verifyComplete },
  { method: 'POST', path: customerRoutes.auth.endSession },
  { method: 'GET', path: customerRoutes.conversations.list },
  { method: 'POST', path: customerRoutes.conversations.intake },
  { method: 'GET', path: customerRoutes.conversations.messages(':id') },
  { method: 'POST', path: customerRoutes.conversations.messages(':id') },
  { method: 'POST', path: customerRoutes.conversations.attachments(':id') },
  { method: 'GET', path: customerRoutes.attachments.download(':aid') },
  { method: 'POST', path: customerRoutes.attachments.uploaded(':aid') },
];
