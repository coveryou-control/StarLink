/**
 * The Socket.IO gateway (ADR-005, doc §20.6, §20.9).
 *
 * Transport only. Every access decision belongs to ConnectionManager, and every event
 * originates from the outbox relay — nothing here invents state. That separation is
 * what makes "realtime is additive" (FR-RT-1) enforceable: this file can be deleted
 * and the product still works over HTTP, which is the property NFR-AVL-2 demands.
 *
 * One backplane subscription is held per CHANNEL, not per socket. Ten agents watching
 * one conversation cost one subscription; the fan-out to their sockets happens here.
 */
import type { Server as HttpServer } from 'node:http';
import { hostname } from 'node:os';
import { Server, type Socket } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import type { SessionService, Surface } from '@starlink/security';
import { METRICS, metrics, type Logger } from '@starlink/observability';
import { isUuid, SOCKET_EVENTS } from '@starlink/shared-contracts';
import {
  channelKey,
  type PresenceSnapshot,
  type PresenceStore,
  type RealtimeBackplane,
  type RealtimeChannel,
  type RealtimeEvent,
  type UUID,
} from '@starlink/shared-contracts';
import { ConnectionManager } from './connection-manager.js';

const COOKIE_FOR: Record<Surface, string> = {
  EMPLOYEE: 'sl_emp_session',
  CUSTOMER: 'sl_cus_session',
};

export interface GatewayOptions {
  readonly httpServer: HttpServer;
  readonly sessions: SessionService;
  readonly backplane: RealtimeBackplane;
  readonly connections: ConnectionManager;
  readonly logger: Logger;
  readonly allowedOrigins: readonly string[];
  /** How often to re-check every connection's session version (§20.10 rule 2). */
  readonly revalidateIntervalMs?: number;
  readonly maxConnectionsPerPrincipal?: number;
  /**
   * Presence and typing (§21.9). Optional: the gateway must work without it, because
   * presence is decoration and losing it may never take realtime down with it.
   */
  readonly presence?: PresenceStore;
  /**
   * Lease length. Must exceed the heartbeat interval by enough that one missed tick
   * does not flap someone offline — but stay short enough that a hard-killed node does
   * not leave ghosts online for minutes.
   */
  readonly presenceTtlSeconds?: number;
  readonly presenceHeartbeatMs?: number;
  /** How long a single "still typing" signal stays true without a refresh. */
  readonly typingTtlSeconds?: number;
  /** Floor between accepted typing signals from one socket. */
  readonly typingMinIntervalMs?: number;
  /**
   * Identifies THIS gateway instance on the socket gauge (§33's multi-node topology).
   *
   * Falls back to the hostname. Deliberately not a generated id: a fresh label on every
   * restart mints a new time series each deploy, so a dashboard would show a forest of
   * dead series and no continuous line for any node.
   */
  readonly nodeId?: string;
  readonly now?: () => number;
}

/** What a client may say about typing. Anything else is dropped. */
interface TypingSignal {
  readonly conversationId: UUID;
  readonly visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
}

interface ChannelSubscription {
  readonly unsubscribe: () => void;
  readonly sockets: Set<string>;
}

export class RealtimeGateway {
  private readonly io: Server;
  private readonly subscriptions = new Map<string, ChannelSubscription>();
  /** In-flight backplane subscribes, so concurrent joiners share one attempt. */
  private readonly pendingSubscriptions = new Map<string, Promise<void>>();
  private readonly perPrincipal = new Map<UUID, Set<string>>();
  private revalidateTimer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  /** socketId -> last accepted typing signal, for the per-socket throttle. */
  private readonly lastTypingAt = new Map<string, number>();
  private draining = false;
  private readonly now: () => number;
  private readonly nodeId: string;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => Date.now());
    this.nodeId = options.nodeId ?? hostname();
    this.io = new Server(options.httpServer, {
      cors: { origin: [...options.allowedOrigins], credentials: true },
      // Reconnection with backoff and jitter is the CLIENT's responsibility, but the
      // server must tolerate the resulting storm: a deploy disconnects everyone at
      // once, and a synchronised retry would arrive as a thundering herd (§20.9).
      pingInterval: 25_000,
      pingTimeout: 20_000,
      // Bodies never travel over realtime, so the payload ceiling can be small — which
      // also bounds what a hostile client can push at us.
      maxHttpBufferSize: 64 * 1024,
    });

    /**
     * A rejection here must become a refusal, not a hung handshake.
     *
     * `void this.authenticate(...)` discarded the promise, so anything `authenticate`
     * threw — `sessions.verify` reaching a database that is down, a pool timeout, an
     * identity adapter raising — became an unhandled rejection and `next()` was never
     * called. The client received no `connect_error`; socket.io simply held the `Client`
     * and its pre-connect `Socket` until `connectTimeout` (45s by default) expired.
     *
     * That path never reaches the per-principal ceiling, which is enforced further down,
     * so it is entirely unbudgeted: during a database blip every reconnecting client parks
     * a socket for 45 seconds with nothing counting them — precisely the reconnect storm
     * §32.4 exists to catch, made worse by the failure that triggered it.
     *
     * `settled` is not defensive padding. `authenticate` can throw AFTER calling `next()`,
     * and calling it twice makes socket.io run `_doConnect` twice for one client.
     */
    this.io.use((socket, next) => {
      let settled = false;
      const once = (error?: Error): void => {
        if (settled) return;
        settled = true;
        next(error);
      };

      this.authenticate(socket, once).catch((error: unknown) => {
        this.options.logger.error('realtime handshake failed', {
          operation: 'realtime.connect',
          outcome: 'FAILED',
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          detail: { reason: error instanceof Error ? error.message : String(error) },
        });
        // The slot, if one was taken before the throw. `releaseConnection` is idempotent.
        this.releaseConnection(socket.id);
        once(new Error('unauthorized'));
      });
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  /**
   * Handshake authentication (§27.13).
   *
   * Uses the SAME session mechanism as HTTP. A separate realtime auth path would be a
   * second implementation to get wrong, and §38 records exactly that divergence as a
   * defect in the reference platform.
   */
  private async authenticate(socket: Socket, next: (err?: Error) => void): Promise<void> {
    if (this.draining) {
      next(new Error('draining'));
      return;
    }

    /**
     * Watch the transport from BEFORE the first await, not after the slot is taken.
     *
     * socket.io 4.8.3, `Namespace._add`, is explicit (dist/namespace.js:221-227): when the
     * middleware calls `next()` it checks `client.conn.readyState` on the next tick and, if
     * the transport has closed meanwhile, calls `socket._cleanup()` and RETURNS — `_doConnect`
     * never runs, so neither `connection` nor `disconnect` is ever emitted.
     *
     * The slot is claimed below, after `sessions.verify` — which for an EMPLOYEE is a real
     * database round trip. A client that navigates away or loses its network during that
     * await therefore had its `close` fire before any listener existed, and no `disconnect`
     * afterwards to release it: the slot was held for the life of the process. After
     * `SL_RT_MAX_CONN_PER_PRINCIPAL` such aborts that employee is refused every socket until
     * the gateway restarts.
     *
     * A previous attempt attached the listener AFTER `register` and concluded from a test
     * that the leak did not exist. The test was the thing that was wrong — it released its
     * gate in the same tick as the close, so the middleware always resumed first and took the
     * benign path. The library source above is the evidence.
     *
     * ## Which line actually closes the leak — measured, because the first answer was wrong
     *
     * This docblock used to credit the listener below. It is not what fixes it. Deleting the
     * listener and the flag entirely leaves all 81 gateway tests GREEN; deleting the
     * post-`register` re-check at the end of this method turns two red, including the
     * ceiling-exhaustion case. The guarantee is the re-check, and the listener is
     * defence-in-depth.
     *
     * It is redundant by construction today, not merely untested: engine.io sets
     * `readyState = 'closed'` BEFORE it emits `'close'`, so any close that could set the
     * flag also fails the `readyState` test below; and this is the only `io.use` in the
     * process, so nothing can interleave between `next()` and socket.io's nextTick check.
     * It is kept because both of those are properties of the current arrangement — add a
     * second middleware after this one and the window reopens, at which point the listener
     * becomes the thing that covers it and nothing tests that it does.
     *
     * ## The ordering that makes it safe to release from two places
     *
     * `Client.setup()` registers socket.io's own `conn.on('close')` at Client construction,
     * before any middleware — so on a hard transport close socket.io's handler runs FIRST,
     * `disconnect` fires, `onDisconnect` leaves the backplane channels, and the listener
     * below runs second as a no-op. That order is load-bearing: if it were reversed,
     * `releaseConnection` would empty `joined` before `onDisconnect` read it, and the
     * gateway would keep one backplane subscription per conversation ever opened, forever.
     */
    let closedDuringHandshake = false;
    socket.conn.once('close', () => {
      closedDuringHandshake = true;
      this.releaseConnection(socket.id);
    });
    const surface: Surface = socket.handshake.auth?.surface === 'CUSTOMER' ? 'CUSTOMER' : 'EMPLOYEE';
    const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
    const token = cookies[COOKIE_FOR[surface]];

    if (token === undefined || token === '') {
      next(new Error('unauthorized'));
      return;
    }

    const verified = await this.options.sessions.verify(token, surface);
    if (!verified.ok) {
      // One refusal for every reason. Distinguishing "revoked" from "expired" tells a
      // prober which half they got right (§27.1).
      next(new Error('unauthorized'));
      return;
    }

    const principalId = verified.session.principalId;
    const existing = this.perPrincipal.get(principalId) ?? new Set<string>();
    const ceiling = this.options.maxConnectionsPerPrincipal ?? 8;
    if (existing.size >= ceiling) {
      // Connection-exhaustion guard (§27.5). One principal opening tabs without limit
      // is indistinguishable from one principal attacking the gateway.
      next(new Error('too_many_connections'));
      return;
    }

    this.options.connections.register({
      connectionId: socket.id,
      principalId,
      principalKind: verified.session.kind,
      sessionVersion: verified.session.sessionVersion,
      // Carried from the session, not looked up. Assurance describes how this person
      // proved themselves on THIS connection; the principal record cannot know it, and
      // dropping it made every customer socket look anonymous to `decide()`.
      ...(verified.session.assurance !== undefined
        ? { assurance: verified.session.assurance }
        : {}),
    });
    existing.add(socket.id);
    this.perPrincipal.set(principalId, existing);

    /**
     * If the transport went while we were authenticating, give the slot straight back.
     *
     * The listener above may have fired before `register` ran, in which case it had nothing
     * to release — the flag is what carries that across. Refusing rather than calling a bare
     * `next()` is not cosmetic: socket.io would drop this socket silently anyway, and saying
     * so keeps the log honest about why no connection appeared.
     */
    if (closedDuringHandshake || socket.conn.readyState !== 'open') {
      this.releaseConnection(socket.id);
      next(new Error('unauthorized'));
      return;
    }

    next();
  }

  /**
   * Frees everything a connection holds. Safe to call more than once, and called from both
   * the namespace `disconnect` and the transport `close`.
   */
  private releaseConnection(socketId: string): void {
    const identity = this.options.connections.get(socketId);
    if (identity === undefined) {
      // Already released. Nothing to do, and no metric to move.
      return;
    }

    const sockets = this.perPrincipal.get(identity.principalId);
    sockets?.delete(socketId);
    if (sockets === undefined || sockets.size === 0) {
      this.perPrincipal.delete(identity.principalId);
      // Only the LAST socket clears presence. Closing one of three tabs must not
      // show a colleague as offline while they are still working.
      this.detach(
        'realtime.presence',
        // Discards the adapter's Result: presence is decoration, and a presence outage
        // must never become a realtime outage (§21.9). `detach` covers the rejection.
        Promise.resolve(this.options.presence?.clear(identity.principalId)).then(() => undefined),
      );
    }
    this.options.connections.unregister(socketId);
    this.emitConnectionMetrics();
  }

  private onConnection(socket: Socket): void {
    const identity = this.options.connections.get(socket.id);
    this.options.logger.info('realtime connected', {
      operation: 'realtime.connect',
      outcome: 'SUCCEEDED',
      ...(identity !== undefined ? { principalId: identity.principalId } : {}),
    });

    /**
     * Part IV §68 gate 7 asks for dashboards and alerts covering sockets, and §32.4's
     * "realtime reconnect storm -- above baseline -- instability, or a deploy going
     * wrong" is the alert. Both had no source: the gauge was defined in
     * `@starlink/observability` and nothing set it, and this process had no scrape
     * endpoint either (added the same day, in `main.ts`).
     *
     * The COUNTER counts every connection established, not only re-establishments. That
     * is a deliberate approximation and worth stating plainly: this gateway has no resume
     * protocol to distinguish the two, because recovery here is re-fetch over HTTP
     * (invariant 9 -- "no state exists only in an event"), so nothing tells it whether a
     * client has been here before. During the event the alert exists to catch -- a deploy
     * or a network blip reconnecting everyone at once -- the two counts are the same
     * shape, and at steady state both sit near zero. If a resume protocol ever arrives
     * with the multi-instance work, this becomes exact rather than approximate.
     */
    this.emitConnectionMetrics();
    metrics.increment(METRICS.reconnectRate, 1);

    /**
     * Names come from the shared contract, never from a literal here.
     *
     * A socket event name fails SILENTLY when it drifts — there is no 404 for an event
     * nobody is listening for — and it duly drifted: `employee-web` emitted
     * `conversation.subscribe` against this `subscribe` for as long as both existed, so
     * the employee surface never received a realtime event and nothing failed.
     */
    socket.on(SOCKET_EVENTS.subscribe, (raw: unknown, ack?: (response: unknown) => void) => {
      this.detach('realtime.subscribe', this.onSubscribe(socket, raw, ack), () => ack?.({ ok: false }));
    });

    socket.on(SOCKET_EVENTS.unsubscribe, (raw: unknown) => {
      const channel = parseChannel(raw);
      if (channel === undefined) return;
      this.leaveChannel(socket, channelKey(channel));
    });

    socket.on(SOCKET_EVENTS.typing, (raw: unknown) => {
      this.detach('realtime.typing', this.onTyping(socket, raw));
    });

    socket.on(SOCKET_EVENTS.read, (raw: unknown) => {
      this.detach('realtime.read', this.onRead(socket, raw));
    });

    socket.on(SOCKET_EVENTS.presenceQuery, (raw: unknown, ack?: (response: unknown) => void) => {
      this.detach(
        'realtime.presence',
        this.onPresenceQuery(socket, raw, ack),
        // A presence failure answers "nobody is online" rather than nothing at all: the
        // client would otherwise wait out its timeout on every poll, and presence going
        // quiet must never look like the socket going quiet (§21.9).
        () => ack?.({ online: [] }),
      );
    });

    socket.on('disconnect', () => this.onDisconnect(socket));

    // Take the presence lease as soon as the connection is authenticated. Failure is
    // logged and swallowed: presence is decoration, and a presence outage must never
    // become a realtime outage (§21.9).
    if (identity !== undefined) {
      this.detach('realtime.presence', this.touchPresence(identity.principalId));
    }
  }

  /**
   * Runs a socket handler whose result nobody awaits, without letting a rejection reach
   * the process.
   *
   * Socket.IO listeners are synchronous, so every async handler here is started and
   * abandoned. Written as `void handler(...)` that is a live process-kill switch: an
   * unhandled rejection terminates Node, and these handlers take untrusted input from
   * anyone holding a session. `parseChannel` now rejects the specific packet that was
   * reaching Postgres, but the class of bug is "an async socket handler threw", and the
   * fix for a class is not a fix for one input.
   *
   * `onFailure` exists so a caller that owes the client an acknowledgement still sends
   * one. A client that gets no ack waits forever, which is a worse failure than a refusal.
   */
  private detach(operation: string, work: Promise<void>, onFailure?: () => void): void {
    void work.catch((error: unknown) => {
      this.options.logger.error('realtime handler failed', {
        operation,
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
      try {
        onFailure?.();
      } catch {
        // The socket is already gone. Nothing further to do, and certainly not a throw
        // from inside the handler that exists to stop throws escaping.
      }
    });
  }

  /**
   * A client-originated typing signal.
   *
   * Everything here is defensive because this is the ONLY message a client can send
   * that causes a broadcast to other people. In order: the payload is parsed rather
   * than trusted, the socket must already have joined the conversation, the rate is
   * floored per socket, and an internal-note signal is withheld from customers.
   */
  /**
   * Which of these colleagues currently hold a presence lease.
   *
   * ## Why this exists on the socket rather than as an HTTP route
   *
   * The lease store is the gateway's. With the in-process backplane it lives in this
   * process's memory, so the API cannot answer this question without a network hop to
   * here — and the socket asking is already authenticated, already open, and already the
   * thing whose lifetime defines the answer. An HTTP route would have meant a second
   * session-verification path on a process that has exactly one.
   *
   * ## What it will and will not say
   *
   * Only membership of the online set. `PresenceState` has four values and the gateway
   * writes one of them, so AWAY and BUSY are types with no producer; reporting either
   * would be inventing an availability signal. §21.9 is explicit that presence is not
   * availability — "a phone entering a lift is not leave" — and this answers the narrow
   * question it can actually answer.
   *
   * ## Employees only
   *
   * A customer must not be able to enumerate staff connectivity. The check is on the
   * authenticated principal kind, not on anything in the payload.
   */
  private async onPresenceQuery(
    socket: Socket,
    raw: unknown,
    ack?: (response: unknown) => void,
  ): Promise<void> {
    const presence = this.options.presence;
    const identity = this.options.connections.get(socket.id);

    if (presence === undefined || identity === undefined || identity.principalKind !== 'EMPLOYEE') {
      ack?.({ online: [] });
      return;
    }

    const ids = parsePresenceQuery(raw);
    if (ids === undefined) {
      ack?.({ online: [] });
      return;
    }

    const records = await presence.get(ids);
    if (!records.ok) {
      this.options.logger.warn('presence query failed', {
        operation: 'realtime.presence',
        outcome: 'FAILED',
        errorCode: records.error.code,
      });
      ack?.({ online: [] });
      return;
    }

    /**
     * Filtered on the lease being unexpired as well as present.
     *
     * The store's own expiry is what stops a crashed node leaving somebody online
     * forever, but a record read in the same tick its lease lapses would otherwise be
     * reported as online. Cheap, and it makes the answer a function of the clock rather
     * than of sweep timing.
     */
    const now = new Date(this.now()).toISOString();
    const online = records.value
      .filter((record) => record.state !== 'OFFLINE' && record.expiresAt > now)
      .map((record) => record.principalId);

    ack?.({ online } satisfies PresenceSnapshot);
  }

  private async onTyping(socket: Socket, raw: unknown): Promise<void> {
    const presence = this.options.presence;
    if (presence === undefined) return;

    const signal = parseTypingSignal(raw);
    if (signal === undefined) return;

    const identity = this.options.connections.get(socket.id);
    if (identity === undefined) return;

    // A customer cannot be composing an internal note; claiming otherwise is either a
    // broken client or someone probing what the flag does.
    if (signal.visibility === 'INTERNAL' && identity.principalKind !== 'EMPLOYEE') return;

    const key = channelKey({ kind: 'CONVERSATION', conversationId: signal.conversationId });
    if (!this.options.connections.hasJoined(socket.id, key)) return;

    // Typing arrives per keystroke from a naive client. Throttling here bounds both the
    // presence writes and the fan-out, without the client having to be well-behaved.
    const at = this.now();
    const last = this.lastTypingAt.get(socket.id) ?? 0;
    const minInterval = this.options.typingMinIntervalMs ?? 1_000;
    if (at - last < minInterval) return;
    this.lastTypingAt.set(socket.id, at);

    const ttl = this.options.typingTtlSeconds ?? 5;
    const stored = await presence.setTyping(signal.conversationId, identity.principalId, ttl);
    if (!stored.ok) {
      this.options.logger.warn('typing not recorded', {
        operation: 'realtime.typing',
        outcome: 'FAILED',
        errorCode: stored.error.code,
      });
      return;
    }

    this.broadcastTyping(key, socket.id, {
      conversationId: signal.conversationId,
      principalId: identity.principalId,
      visibility: signal.visibility,
      expiresInSeconds: ttl,
    });
  }

  /**
   * Somebody has read up to a point in a conversation.
   *
   * ## What this is allowed to assert, and what it is not
   *
   * The client supplies a conversation and a position. It does NOT supply whose reading
   * this is — that comes from the connection, the same way the typing signal works — and
   * it reaches nobody unless this socket has actually joined the room. So the worst a
   * misbehaving client can do is overstate its OWN position, which it can already do by
   * calling `POST /conversations/:id/read` with any sequence. No new capability, which is
   * the bar a client-originated frame has to clear.
   *
   * ## Why there is no throttle here
   *
   * Typing arrives per keystroke and needed one. Reading is marked once per thread open
   * and then on a debounce as new messages land, so the natural rate is already low, and
   * the frame writes nothing — it is a fan-out of a number. A throttle would add a way for
   * the tick to arrive late without adding a bound worth having.
   *
   * ## Why a customer connection is refused
   *
   * The read watermark is drawn as a tick on an employee's own message. A customer surface
   * neither sends this nor renders it, so a frame claiming to be one is either a broken
   * client or somebody probing — and §21.9's caution about presence applies doubly to
   * telling staff when a customer has read something, which is a product decision nobody
   * has taken.
   */
  private async onRead(socket: Socket, raw: unknown): Promise<void> {
    const signal = parseReadSignal(raw);
    if (signal === undefined) return;

    const identity = this.options.connections.get(socket.id);
    if (identity === undefined) return;
    if (identity.principalKind !== 'EMPLOYEE') return;

    const key = channelKey({ kind: 'CONVERSATION', conversationId: signal.conversationId });
    if (!this.options.connections.hasJoined(socket.id, key)) return;

    this.broadcastRead(key, socket.id, {
      conversationId: signal.conversationId,
      principalId: identity.principalId,
      lastReadSeq: signal.lastReadSeq,
    });
  }

  /**
   * Fan out a read position to the room, per socket.
   *
   * Never echoed to the sender: a thread showing its own reader's watermark would tick
   * their own messages the moment they opened it, which is the one reading that says
   * nothing about whether anybody else saw them.
   *
   * Employee connections only, for the reason in `onRead`.
   */
  private broadcastRead(
    key: string,
    fromSocketId: string,
    payload: { conversationId: UUID; principalId: UUID; lastReadSeq: number },
  ): void {
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;

    for (const socketId of subscription.sockets) {
      if (socketId === fromSocketId) continue;
      if (!this.options.connections.isEmployeeConnection(socketId)) continue;
      this.io.to(socketId).emit(SOCKET_EVENTS.readSignal, payload);
    }
  }

  /**
   * Fan out a typing signal to the room, per socket.
   *
   * Never echoed to the sender — a composer showing "you are typing" is noise — and an
   * INTERNAL signal reaches employee connections only, the same rule `mayReceive`
   * applies to staff-only events.
   */
  private broadcastTyping(
    key: string,
    fromSocketId: string,
    payload: {
      conversationId: UUID;
      principalId: UUID;
      visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
      expiresInSeconds: number;
    },
  ): void {
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;

    for (const socketId of subscription.sockets) {
      if (socketId === fromSocketId) continue;
      if (payload.visibility === 'INTERNAL' && !this.options.connections.isEmployeeConnection(socketId)) {
        continue;
      }
      this.io.to(socketId).emit(SOCKET_EVENTS.typingSignal, payload);
    }
  }

  /** Renews the principal's presence lease. Never throws into the caller. */
  private async touchPresence(principalId: UUID): Promise<void> {
    const presence = this.options.presence;
    if (presence === undefined) return;

    const ttl = this.options.presenceTtlSeconds ?? 45;
    try {
      await presence.heartbeat(principalId, 'ONLINE', ttl);
    } catch (cause) {
      this.options.logger.warn('presence heartbeat failed', {
        operation: 'realtime.presence',
        outcome: 'FAILED',
      });
    }
  }

  private async onSubscribe(
    socket: Socket,
    raw: unknown,
    ack?: (response: unknown) => void,
  ): Promise<void> {
    const channel = parseChannel(raw);
    if (channel === undefined) {
      ack?.({ ok: false });
      return;
    }

    const outcome = await this.options.connections.authorizeJoin(socket.id, channel);
    if (!outcome.ok) {
      this.options.logger.info('realtime subscribe refused', {
        operation: 'realtime.subscribe',
        outcome: 'REFUSED',
        errorCode: outcome.reason,
      });
      // Acknowledge BEFORE closing. Disconnecting first drops the ack with the socket,
      // and the client sits waiting for a callback that can never arrive — a hang
      // rather than a refusal. Caught by the socket test; invisible to a unit test.
      ack?.({ ok: false });

      // A revoked session does not merely fail the join — the socket goes (rule 3).
      // Deferred a tick so the acknowledgement is flushed first.
      if (outcome.reason === 'SESSION_REVOKED') {
        setImmediate(() => socket.disconnect(true));
      }
      return;
    }

    const key = channelKey(channel);
    await this.ensureChannelSubscription(channel, key);
    this.subscriptions.get(key)?.sockets.add(socket.id);
    await socket.join(key);
    this.options.connections.recordJoin(socket.id, key, channel);

    // Hand the joiner whoever is ALREADY typing. Without this, opening a thread shows
    // nothing until the next keystroke, so a colleague mid-sentence looks idle.
    // Withheld from customer connections: the store does not record which visibility
    // each typist is composing at, so the safe reading is that any of them might be
    // writing an internal note.
    const typists =
      this.options.presence !== undefined &&
      channel.kind === 'CONVERSATION' &&
      this.options.connections.isEmployeeConnection(socket.id)
        ? await this.options.presence.getTyping(channel.conversationId)
        : undefined;

    ack?.({
      ok: true,
      ...(typists?.ok === true
        ? { typing: typists.value.filter((id) => id !== this.options.connections.get(socket.id)?.principalId) }
        : {}),
    });
  }

  /**
   * One backplane subscription per channel, shared by every socket watching it.
   *
   * Single-flight, and that is not an optimisation. Subscribing is async, so two
   * sockets joining the same conversation in the same tick BOTH saw no subscription,
   * both created one, and the second overwrote the first's entry — taking the first
   * socket's membership with it. That socket then received nothing at all, messages
   * included, while every log line said it had joined successfully.
   *
   * Two people opening the same thread at the same moment is not an exotic case; it is
   * a queue being picked up. Sequential tests never reproduce it.
   */
  private async ensureChannelSubscription(channel: RealtimeChannel, key: string): Promise<void> {
    if (this.subscriptions.has(key)) return;

    const inFlight = this.pendingSubscriptions.get(key);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }

    const attempt = (async () => {
      const result = await this.options.backplane.subscribe(channel, (event) =>
        this.fanOut(key, event),
      );
      if (!result.ok) {
        this.options.logger.error('backplane subscribe failed', {
          operation: 'realtime.subscribe',
          outcome: 'FAILED',
          errorCode: result.error.code,
        });
        return;
      }
      // Belt to the single-flight braces: if a winner registered while we were awaiting,
      // release OUR subscription rather than leaking it or clobbering theirs.
      if (this.subscriptions.has(key)) {
        result.value();
        return;
      }
      this.subscriptions.set(key, { unsubscribe: result.value, sockets: new Set() });
    })();

    this.pendingSubscriptions.set(key, attempt);
    try {
      await attempt;
    } finally {
      this.pendingSubscriptions.delete(key);
    }
  }

  /**
   * Fan-out, with the staff-only check applied PER SOCKET.
   *
   * Emitting to the room wholesale would be simpler and wrong: a customer legitimately
   * occupies the conversation channel, so the room contains connections that must not
   * receive every event on it (§27.16).
   */
  private fanOut(key: string, event: RealtimeEvent): void {
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;

    for (const socketId of subscription.sockets) {
      if (!this.options.connections.mayReceive(socketId, event)) continue;
      this.io.to(socketId).emit(SOCKET_EVENTS.event, {
        eventId: event.eventId,
        name: event.name,
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        occurredAt: event.occurredAt,
        // Identifiers and classifications only — never a body (FR-RT-4).
        payload: event.payload,
      });
    }
  }

  private leaveChannel(socket: Socket, key: string): void {
    const subscription = this.subscriptions.get(key);
    subscription?.sockets.delete(socket.id);
    void socket.leave(key);
    this.options.connections.recordLeave(socket.id, key);

    // Release the backplane subscription once nobody is watching, so a long-lived
    // gateway does not accumulate one per conversation ever opened.
    if (subscription !== undefined && subscription.sockets.size === 0) {
      subscription.unsubscribe();
      this.subscriptions.delete(key);
    }
  }

  private onDisconnect(socket: Socket): void {
    for (const key of this.options.connections.channelsFor(socket.id)) {
      this.leaveChannel(socket, key);
    }
    this.lastTypingAt.delete(socket.id);

    // The slot itself is freed by `releaseConnection`, which the transport's `close` also
    // calls — see the note where that listener is attached. Idempotent, so whichever
    // arrives first does the work and the other returns immediately.
    this.releaseConnection(socket.id);
  }

  /** Closes every connection belonging to a principal whose session ended (rule 3). */
  revokePrincipal(principalId: UUID): number {
    const doomed = this.options.connections.connectionsToRevoke(principalId);
    for (const connectionId of doomed) {
      this.io.sockets.sockets.get(connectionId)?.disconnect(true);
    }
    return doomed.length;
  }

  start(): void {
    const interval = this.options.revalidateIntervalMs ?? 60_000;
    this.revalidateTimer = setInterval(() => {
      void this.options.connections.revalidateAll().then(({ doomed, revoked }) => {
        for (const connectionId of doomed) {
          this.options.logger.info('closing socket for revoked session', {
            operation: 'realtime.revoke',
            outcome: 'SUCCEEDED',
          });
          this.io.sockets.sockets.get(connectionId)?.disconnect(true);
        }

        /**
         * Access that lapsed without the session changing: leave the room, keep the socket.
         *
         * Disconnecting would be wrong — the person is still signed in and may hold other
         * conversations legitimately. What has ended is their access to THIS channel, so
         * that is what ends. Recovery is re-fetch over HTTP (invariant 9), which will
         * refuse them too, so the surface stays consistent with the gateway.
         */
        for (const { connectionId, channelKey } of revoked) {
          const socket = this.io.sockets.sockets.get(connectionId);
          if (socket === undefined) continue;
          this.options.logger.info('leaving channel after access lapsed', {
            operation: 'realtime.revoke',
            outcome: 'SUCCEEDED',
            detail: { channelKey },
          });
          this.leaveChannel(socket, channelKey);
        }
      });
    }, interval);
    // Never hold the process open for a housekeeping timer.
    this.revalidateTimer.unref?.();

    if (this.options.presence !== undefined) {
      // Leases must be renewed from the server, not from client pings. A client that
      // stops sending is indistinguishable from one that crashed, and we would rather
      // let the lease lapse than trust the browser to tell us it is still there.
      const every = this.options.presenceHeartbeatMs ?? 15_000;
      this.presenceTimer = setInterval(() => {
        for (const principalId of this.perPrincipal.keys()) {
          void this.touchPresence(principalId);
        }
      }, every);
      this.presenceTimer.unref?.();
    }
  }

  /**
   * Graceful drain (Part IV §52).
   *
   * Refuse new connections first, then close existing ones, so a rolling deploy sheds
   * load instead of dropping it. Clients reconnect with backoff and jitter and
   * re-fetch — no state is lost because none of it lived here (FR-RT-1).
   */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.revalidateTimer !== undefined) clearInterval(this.revalidateTimer);
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer);

    // Release the leases this node holds rather than leaving every connected principal
    // to look online until their TTL lapses. A rolling deploy should not blank the
    // whole team's presence for 45 seconds.
    if (this.options.presence !== undefined) {
      await Promise.all(
        [...this.perPrincipal.keys()].map((principalId) =>
          this.options.presence?.clear(principalId).catch(() => undefined),
        ),
      );
    }

    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    await this.io.close();
  }

  /**
   * Publishes the live socket count, labelled by node.
   *
   * Labelled because §33's target topology is several gateway nodes behind a load
   * balancer: an unlabelled gauge would have each node overwrite the others and report
   * one node's connections as the whole system's. The label is the instance id where the
   * platform supplies one, and the hostname otherwise -- never a generated id, which
   * would mint a new time series on every restart.
   */
  private emitConnectionMetrics(): void {
    metrics.set(METRICS.activeConnections, this.options.connections.connectionCount(), {
      node: this.nodeId,
    });
  }

  metrics(): { connections: number; channels: number } {
    return {
      connections: this.options.connections.connectionCount(),
      channels: this.subscriptions.size,
    };
  }
}

/**
 * Parses an untrusted client message into a channel, or nothing.
 *
 * ## Why the identifiers are validated here and not at the query
 *
 * This accepted ANY string as a conversation id. The value went on to
 * `PgRealtimeAuthzReader`, whose predicate is `WHERE c.conversation_id = $1` against a
 * `uuid` primary key, so Postgres raised a type error — and the `subscribe` listener
 * invokes this path as a floating `void` promise, so the rejection had nowhere to go and
 * Node exited. `{"kind":"CONVERSATION","conversationId":"x"}` killed the node, and a
 * customer session — obtainable anonymously from a `@Public()` endpoint — could send it in
 * a loop.
 *
 * Validating at the parse boundary rather than at the query is the deliberate choice: this
 * is the point where an untrusted value becomes a typed one, and everything downstream is
 * entitled to assume the type is real. A check at the query would have to be repeated in
 * every reader that grows a channel argument later.
 *
 * `teamId` is text in the schema, not uuid, so its constraint is a length bound rather
 * than a shape — an unbounded string reaching a query is its own problem.
 */
function parseChannel(raw: unknown): RealtimeChannel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;

  if (value.kind === 'CONVERSATION' && isUuid(value.conversationId)) {
    return { kind: 'CONVERSATION', conversationId: value.conversationId };
  }
  if (value.kind === 'PRINCIPAL' && isUuid(value.principalId)) {
    return { kind: 'PRINCIPAL', principalId: value.principalId };
  }
  if (
    value.kind === 'TEAM' &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    value.teamId.length <= 120
  ) {
    return { kind: 'TEAM', teamId: value.teamId };
  }
  // CONTROL is deliberately unparseable from a client message: nobody subscribes to it.
  return undefined;
}

/** Parses an untrusted typing message. An unrecognised shape is dropped, never guessed. */
function parseTypingSignal(raw: unknown): TypingSignal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;

  if (typeof value.conversationId !== 'string' || value.conversationId === '') return undefined;
  // Defaulting an unrecognised visibility to CUSTOMER_VISIBLE would be the fail-open
  // direction: it would fan an internal signal out to a customer. Refuse instead.
  if (value.visibility !== 'INTERNAL' && value.visibility !== 'CUSTOMER_VISIBLE') return undefined;

  return { conversationId: value.conversationId, visibility: value.visibility };
}

/**
 * Parses an untrusted read position. An unrecognised shape is dropped, never guessed.
 *
 * A non-integer or negative sequence is refused rather than coerced: the receiving client
 * keeps the HIGHEST watermark it has seen, so one `Infinity` on the wire would mark every
 * message in the conversation as read, permanently, for everybody in the room.
 */
function parseReadSignal(raw: unknown): { conversationId: UUID; lastReadSeq: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;

  if (typeof value.conversationId !== 'string' || value.conversationId === '') return undefined;
  if (typeof value.lastReadSeq !== 'number') return undefined;
  if (!Number.isSafeInteger(value.lastReadSeq) || value.lastReadSeq < 0) return undefined;

  return { conversationId: value.conversationId as UUID, lastReadSeq: value.lastReadSeq };
}

/**
 * Parses an untrusted presence query. An unrecognised shape is dropped, never guessed.
 *
 * Bounded at fifty ids because the caller is a browser asking about what is on its
 * screen, and an unbounded list would let one socket ask the lease store about every
 * principal in the company on a timer.
 */
const PRESENCE_QUERY_MAX = 50;

function parsePresenceQuery(raw: unknown): readonly UUID[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.principalIds)) return undefined;

  const ids = value.principalIds.filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
  if (ids.length === 0) return undefined;
  return ids.slice(0, PRESENCE_QUERY_MAX) as readonly UUID[];
}
