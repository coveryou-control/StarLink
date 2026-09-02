/**
 * Customer API client.
 *
 * Paths come from the shared route table rather than being written out here, for the
 * reason recorded in `employee-routes.ts`: five paths in the employee client were wrong
 * at once, TypeScript could not help because a URL is a string, and the symptom in a
 * browser is an empty screen rather than an error.
 *
 * The session cookie is HttpOnly and set by the API. It is never read, written or stored
 * by this file — `credentials: 'include'` is the whole mechanism (FR-AUTH-1).
 */
// The CUSTOMER subpath only. Importing the barrel pulls the employee route map —
// admin paths included — into this public bundle (ADR-004, customer-bundle.test.ts).
import { customerRoutes } from '@starlink/shared-contracts/http/customer';

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
   * The API refuses with an indistinguishable 404 (§27.3), so "not yours" and "does not
   * exist" arrive identically — deliberately. The UI must therefore say "unavailable"
   * and never "you do not have permission", which would disclose the existence the 404
   * was protecting.
   */
  get isRefusal(): boolean {
    return this.status === 404 || this.status === 403;
  }

  /** The session lapsed or was ended; the widget starts a new one. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Distinguished from a refusal so a dropped connection does not read as a denial. */
  get isUnreachable(): boolean {
    return this.status === 0;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    // Read per request, not once — see `runtime-origins.ts`.
    response = await fetch(`${runtimeOrigins().api}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
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

export interface Category {
  readonly categoryId: string;
  readonly displayName: string;
  readonly parentId?: string;
  /** Seeded scaffolding, not signed-off taxonomy (D-17/D-18). Shown as such. */
  readonly provisional: boolean;
}

/**
 * The four words D-26 proposes. Restated here rather than imported: a browser bundle may
 * not import `packages/` server code (ADR-026), and the API is the contract between them.
 *
 * If these drift from `@starlink/service-case`'s vocabulary the surface renders a raw
 * status string instead of a word — see STATUS_LABEL in `chat.tsx`, which is why the
 * fallback there shows something honest rather than a state name.
 */
export type CustomerStatus = 'RECEIVED' | 'BEING_LOOKED_AT' | 'WAITING_FOR_YOU' | 'RESOLVED';

export interface ConversationSummary {
  readonly conversationId: string;
  readonly subject: string | null;
  readonly status: CustomerStatus;
  /**
   * BR-20: the customer is told the conversation was resolved **and why**.
   *
   * Free text written by the resolving agent, `null` until there is one. §22.5 pairs it
   * with a deliberate omission — the customer gets the outcome and never the resolution
   * timestamp — so there is no `resolvedAt` here and there should not be one.
   */
  readonly outcome: string | null;
  readonly lastActivityAt: string;
}

export interface CustomerMessage {
  readonly messageId: string;
  readonly seq: number;
  readonly body: string;
  readonly author: { readonly kind: 'YOU' | 'AGENT' | 'SYSTEM'; readonly displayName: string };
  readonly createdAt: string;
}

export interface SessionStarted {
  readonly principalId: string;
  readonly assurance: string;
  readonly verificationAvailable: boolean;
}

export const api = {
  /**
   * Starts an ANONYMOUS session.
   *
   * Called when the customer opens the widget, not when the page loads. A session per
   * page view would create a principal row and an audit entry for every visitor who
   * never intended to talk to anyone — a data footprint nobody asked for, and noise in
   * the very ledger that is supposed to make real activity legible.
   */
  startSession: (hints: { mobile?: string; email?: string } = {}) =>
    request<SessionStarted>(customerRoutes.auth.startSession, {
      method: 'POST',
      body: JSON.stringify(hints),
    }),

  endSession: () => request<void>(customerRoutes.auth.endSession, { method: 'POST' }),

  beginVerification: (method: 'OTP_MOBILE' | 'OTP_EMAIL') =>
    request<{ challengeId: string; expiresAt: string; attemptsRemaining: number }>(
      customerRoutes.auth.verifyStart,
      { method: 'POST', body: JSON.stringify({ method }) },
    ),

  completeVerification: (challengeId: string, code: string) =>
    request<{ assurance: string; recognised: boolean; verifiedAt?: string }>(
      customerRoutes.auth.verifyComplete,
      { method: 'POST', body: JSON.stringify({ challengeId, code }) },
    ),

  categories: () => request<{ categories: readonly Category[] }>(customerRoutes.categories),

  conversations: () =>
    request<{ conversations: readonly ConversationSummary[] }>(customerRoutes.conversations.list),

  /** Intake: creates the conversation AND its opening message in one call. */
  startConversation: (input: { categoryId?: string; subject?: string; message: string }) =>
    request<{ conversationId: string; status: CustomerStatus }>(
      customerRoutes.conversations.intake,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  messages: (conversationId: string) =>
    request<{ conversation: ConversationSummary; messages: readonly CustomerMessage[] }>(
      customerRoutes.conversations.messages(conversationId),
    ),

  /**
   * Sends a reply, and reports WHICH conversation it landed in.
   *
   * `conversationId` is not decoration. BR-22 says a reply arriving after the reopen window
   * continues on a NEW conversation against the same case, and the API returns the id it
   * chose precisely so the widget can follow it — its handler says so: *"the widget follows
   * the id it is given rather than the one it sent."*
   *
   * This type omitted the field, so the widget could not follow, refreshed the conversation
   * it had sent to, and the customer watched their own message fail to appear. Then they
   * retyped it, and because the fork had cleared `resolved_at` the second copy was written
   * into the OLD conversation — resolved, unowned, and in nobody's queue.
   *
   * Nothing about the fork is disclosed to the customer (§21.4: "No — it simply continues").
   * This is a mechanical redirect, not a message.
   */
  send: (conversationId: string, message: string, clientMessageId: string) =>
    request<{ conversationId: string; messageId: string; seq: number; duplicate: boolean }>(
      customerRoutes.conversations.messages(conversationId),
      { method: 'POST', body: JSON.stringify({ message, clientMessageId }) },
    ),
};
