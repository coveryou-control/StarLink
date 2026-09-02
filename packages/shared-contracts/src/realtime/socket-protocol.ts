/**
 * The socket wire protocol, as a contract both sides import.
 *
 * ## Why this exists
 *
 * `employee-routes.ts` exists because four HTTP paths were written twice and drifted —
 * "a URL is just a string; nothing checks it". The socket protocol was in exactly that
 * state until 2026-08-29, and worse, because a socket event name fails silently: there is
 * no 404 for an event nobody is listening for.
 *
 * The gateway listened for `subscribe` and emitted `event`. `employee-web` emitted
 * `conversation.subscribe` and listened for `conversation.event`. The payloads disagreed
 * too — the gateway sends `{ eventId, name, seq, occurredAt, payload }` and the client
 * expected `{ conversationId, seq, kind }`. **The employee surface had never received a
 * single realtime event**, and nothing failed: the gateway's own tests used the correct
 * names, and no test drove the client's names at all.
 *
 * Everything here is imported by both the gateway and the web client. A rename is now a
 * compile error on both sides rather than a silence on one.
 *
 * ## Why the frame is not the domain event
 *
 * §20.4: the gateway publishes a NOTIFICATION, never content. The frame carries
 * identifiers, a name and a sequence; the body is fetched over the authorised REST path.
 * That is what makes a mis-routed frame harmless (FR-RT-4), and it is why
 * {@link toConversationEvent} can only ever produce a reference — there is nothing else in
 * the frame to produce.
 */
import type { RealtimeChannel } from '../adapters/realtime.js';
import type { Timestamp, UUID } from '../domain/primitives.js';

/**
 * Every socket event name, in one place.
 *
 * Client-to-server and server-to-client are separated because they are different
 * permissions: a client may ask to join a room and may say it is typing, and that is the
 * whole of what it may originate (§20.10). Anything else it sends is ignored.
 */
export const SOCKET_EVENTS = {
  /** Client → server. Payload is a {@link RealtimeChannel}; acked with {@link SubscribeAck}. */
  subscribe: 'subscribe',
  /** Client → server. Payload is a {@link RealtimeChannel}. */
  unsubscribe: 'unsubscribe',
  /** Client → server. The only message a client can send that reaches other people. */
  typing: 'typing',
  /**
   * Client → server. Reports that this principal has read up to a sequence, so the
   * sender's tick turns over immediately instead of on their next re-fetch.
   *
   * The second thing a client can originate that reaches other people, and the bar it had
   * to clear is that it adds no capability: the same claim is already writable over
   * `POST /conversations/:id/read`, which is where the DURABLE record is made. The client
   * emits this only after that call has committed, and with the sequence the SERVER
   * returned — which is clamped by `GREATEST` — so the frame reports state rather than
   * asserting it.
   */
  read: 'read',
  /**
   * Client → server. Asks whether a set of colleagues currently hold a presence lease;
   * acked with a {@link PresenceSnapshot}. Reaches nobody else — see the type's own note
   * on why this is a query and not a broadcast.
   */
  presenceQuery: 'presence.query',
  /** Server → client. One domain event, as a reference (§20.4). */
  event: 'event',
  /** Server → client. Someone else is typing in a conversation this socket has joined. */
  typingSignal: 'typing',
  /**
   * Server → client. Someone else has read up to a sequence in a conversation this socket
   * has joined. Carries no body and no message ids — a position, and nothing else.
   */
  readSignal: 'read',
} as const;

/**
 * The ack a `subscribe` returns.
 *
 * A refusal is `{ ok: false }` and NOT an error: §20.10 has a refused join simply never
 * deliver events, and the client must not be able to tell "no such conversation" from
 * "not yours" here any more than it can over HTTP (§27.3).
 */
export interface SubscribeAck {
  readonly ok: boolean;
}

/**
 * Who is currently connected, out of the people the caller asked about.
 *
 * ## Why a query rather than a broadcast
 *
 * A presence broadcast means every employee's connect and disconnect reaches every other
 * employee's socket — for five hundred staff that is a fan-out nobody asked for, and it
 * would make presence, which §21.9 calls "a hint", the busiest thing on the wire. A query
 * asks about the handful of people currently on screen and is answered from the lease
 * store the gateway already keeps.
 *
 * ## Why only two states
 *
 * `PresenceState` admits ONLINE, AWAY, BUSY and OFFLINE, and the gateway writes exactly
 * one of them: `heartbeat(principalId, 'ONLINE', ttl)` on connect. Nothing anywhere sets
 * AWAY or BUSY, so this reports only what is actually known — a principal holding a lease,
 * or not. Reporting a state the system cannot produce would be inventing an availability
 * signal, and §21.9 is explicit that presence is not availability: "a phone entering a
 * lift is not leave."
 */
export interface PresenceSnapshot {
  /** The subset of the requested ids that currently hold a lease. Order is not meaningful. */
  readonly online: readonly UUID[];
}

/** Exactly what the gateway puts on the wire for {@link SOCKET_EVENTS.event}. */
export interface RealtimeFrame {
  readonly eventId: UUID;
  /** The catalogue name, e.g. `message.created.v1`. */
  readonly name: string;
  /** Per-conversation monotonic sequence, where the channel has one (§20.8). */
  readonly seq?: number;
  readonly occurredAt: Timestamp;
  /** Identifiers and classifications only — never a body (FR-RT-4). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * What the gateway puts on the wire for a typing signal, and what a client sends.
 *
 * `expiresInSeconds` rather than an absolute instant, deliberately: the two ends have
 * different clocks (ADR-025 — this project has already been bitten by a minute of skew),
 * and a relative TTL cannot be wrong about when it started.
 *
 * A client sends `{ conversationId, visibility }`; the gateway adds the principal and the
 * TTL, because neither is a client's to assert.
 */
export interface TypingFrame {
  readonly conversationId: UUID;
  readonly principalId: UUID;
  readonly visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
  readonly expiresInSeconds: number;
}

/** What a client emits on {@link SOCKET_EVENTS.typing}. */
export interface TypingRequest {
  readonly conversationId: UUID;
  readonly visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
}

/**
 * How far somebody has read — the frame behind the second tick.
 *
 * ## Why this carries a position and not a list of message ids
 *
 * §20.4 keeps content off the wire, and a set of ids somebody has read is a description of
 * content. A watermark is one integer, it is the shape the read-state table already stores,
 * and it is monotonic — so a frame arriving out of order is harmless: the receiver keeps
 * the higher number.
 *
 * ## Why it is additive
 *
 * Rule 9. The tick is computed from `readWatermark` on the page read; this frame only makes
 * it immediate. Drop every one of these on the floor and the feature still works, one
 * refresh behind — which is what a `readWatermark` in the REST response is for.
 *
 * A client sends `{ conversationId, lastReadSeq }`; the gateway adds the principal, because
 * whose reading this is was never a client's to assert.
 */
export interface ReadFrame {
  readonly conversationId: UUID;
  readonly principalId: UUID;
  readonly lastReadSeq: number;
}

/** What a client emits on {@link SOCKET_EVENTS.read}. */
export interface ReadRequest {
  readonly conversationId: UUID;
  readonly lastReadSeq: number;
}

/**
 * What a conversation view needs from a frame.
 *
 * `kind` is derived from the catalogue name rather than sent, because the name is already
 * the contract (§10) and a second classification on the wire would be a second thing to
 * keep in step.
 */
export interface ConversationEvent {
  readonly conversationId: UUID;
  readonly seq: number;
  readonly kind: 'MESSAGE_CREATED' | 'PARTICIPANT_CHANGED' | 'CONVERSATION_UPDATED';
}

const KIND_BY_EVENT: Readonly<Record<string, ConversationEvent['kind']>> = Object.freeze({
  'message.created.v1': 'MESSAGE_CREATED',
  'conversation.resolved.v1': 'CONVERSATION_UPDATED',
  'conversation.reopened.v1': 'CONVERSATION_UPDATED',
  'conversation.assigned.v1': 'CONVERSATION_UPDATED',
  'conversation.transferred.v1': 'CONVERSATION_UPDATED',
  'conversation.escalated.v1': 'CONVERSATION_UPDATED',
  'conversation.closed.v1': 'CONVERSATION_UPDATED',
  'customer.reply.received.v1': 'MESSAGE_CREATED',
});

/**
 * Interprets a frame for a conversation view, or returns `undefined` if it is not one.
 *
 * Shared rather than duplicated in the client so that the gateway's integration test can
 * assert on the SAME interpretation the UI applies. That is what makes an end-to-end
 * socket test meaningful without the gateway importing the web app, which the boundary law
 * forbids and should.
 *
 * An unrecognised event name yields `undefined` rather than a default kind. A frame the
 * client cannot interpret must not be applied to a thread — the honest response is to
 * ignore it and let the next re-fetch reconcile, which is invariant 9 working as intended.
 */
export function toConversationEvent(frame: RealtimeFrame): ConversationEvent | undefined {
  const kind = KIND_BY_EVENT[frame.name];
  if (kind === undefined) return undefined;

  const conversationId = frame.payload.conversationId;
  if (typeof conversationId !== 'string' || conversationId === '') return undefined;

  // A conversation event without a sequence cannot be ordered, and §20.8's whole model is
  // apply/discard/refetch on the sequence. Treated as uninterpretable rather than applied
  // at a guessed position.
  if (typeof frame.seq !== 'number') return undefined;

  return { conversationId: conversationId as UUID, seq: frame.seq, kind };
}

/** The subscribe payload for one conversation. Typed so the `kind` cannot be forgotten. */
export const conversationChannel = (conversationId: UUID): RealtimeChannel => ({
  kind: 'CONVERSATION',
  conversationId,
});

/** §20.7's team room — a team's queue view, joined on team scope. */
export const teamChannel = (teamId: string): RealtimeChannel => ({ kind: 'TEAM', teamId });

/** §20.7's personal room — one principal's own notifications. Never joined by anyone else. */
export const principalChannel = (principalId: UUID): RealtimeChannel => ({
  kind: 'PRINCIPAL',
  principalId,
});
