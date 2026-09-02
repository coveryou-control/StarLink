/**
 * Local OTP customer identity (ADR-019, brief §7).
 *
 * TEMPORARY_AUTHORITY. The production authority for who a customer is will be CCS
 * (Phase 10); this exists so the assurance ladder can be built and tested now, behind
 * the final interface, without inventing a second customer master.
 *
 * The OTP mechanics here are the real ones rather than a placeholder, because the
 * failure modes of a sloppy OTP are the same in a stub as in production and a stub is
 * what tends to survive:
 *
 *   * **Codes are never stored.** Only an HMAC of the code is kept, so a memory dump or
 *     a log of this structure does not hand over live codes.
 *   * **Comparison is constant-time.** A `===` on a 6-digit code leaks its prefix to a
 *     timing attacker, and 10^6 is small enough for that to matter.
 *   * **Attempts are capped and the cap is on the CHALLENGE, not the code.** Five wrong
 *     guesses burn the challenge; without that, 10^6 is a few minutes of brute force.
 *   * **Codes are single-use.** A code that still works after a successful verification
 *     is a replay waiting to happen.
 *   * **Existence is never disclosed.** `beginVerification` behaves identically whether
 *     or not the mobile/email is known, so this is not a customer-enumeration oracle.
 *
 * Deliberately NOT here: any notion of who the customer *is* beyond the reference the
 * upstream directory returns. This adapter authenticates; it does not own customer data.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type {
  Assurance,
  CanonicalRef,
  ChannelKind,
  CustomerIdentityProvider,
  CustomerSession,
  HealthReport,
  IdentityHints,
  Result,
  UUID,
  VerificationChallenge,
  VerificationMethod,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

/** Delivers the code out of band. Never returns it to the caller of the API. */
export interface OtpSender {
  send(method: VerificationMethod, destination: string, code: string): Promise<void>;
}

/**
 * Resolves a verified contact detail to the upstream customer reference.
 *
 * Returning `null` means "no such customer" and MUST NOT change observable behaviour —
 * see the enumeration note above. The interim implementation is backed by whatever the
 * local directory knows; the production one is CCS.
 */
export interface CustomerLookup {
  byContact(method: VerificationMethod, destination: string): Promise<CanonicalRef | null>;
}

interface StoredChallenge {
  readonly challengeId: UUID;
  readonly sessionId: UUID;
  readonly method: VerificationMethod;
  readonly destination: string;
  readonly codeHmac: string;
  readonly expiresAtMs: number;
  attemptsRemaining: number;
  consumed: boolean;
}

interface StoredSession {
  sessionId: UUID;
  assurance: Assurance;
  channel: ChannelKind;
  customerRef?: CanonicalRef;
  issuedAtMs: number;
  expiresAtMs: number;
  verifiedAtMs?: number;
  /**
   * Where to send a code. NOT evidence of anything — a caller who could raise their own
   * assurance by asserting a mobile number has defeated the entire ladder. These only
   * ever determine the delivery address; assurance moves when a code comes back.
   */
  hints: IdentityHints;
}

export interface LocalOtpIdentityOptions {
  /** Separate from the session secret: a leak of one must not forge the other (§27.14). */
  readonly secret: string;
  readonly sender: OtpSender;
  readonly lookup: CustomerLookup;
  readonly sessionTtlSeconds?: number;
  readonly challengeTtlSeconds?: number;
  readonly maxAttempts?: number;
  readonly codeLength?: number;
  readonly now?: () => number;
  readonly newId?: () => UUID;
}

export class LocalOtpIdentity implements CustomerIdentityProvider {
  readonly #sessions = new Map<UUID, StoredSession>();
  readonly #challenges = new Map<UUID, StoredChallenge>();
  readonly #now: () => number;
  readonly #newId: () => UUID;

  constructor(private readonly options: LocalOtpIdentityOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => crypto.randomUUID() as UUID);
  }

  async createSession(channel: ChannelKind, hints?: IdentityHints): Promise<Result<CustomerSession>> {
    const at = this.#now();
    const ttl = (this.options.sessionTtlSeconds ?? 30 * 60) * 1000;
    const session: StoredSession = {
      sessionId: this.#newId(),
      // Everyone starts at the bottom of the ladder. Hints are a convenience for
      // pre-filling a verification form, NEVER evidence: a caller who could raise their
      // own assurance by asserting a policy number has defeated the whole ladder.
      assurance: 'ANONYMOUS',
      channel,
      issuedAtMs: at,
      expiresAtMs: at + ttl,
      hints: hints ?? {},
    };
    this.#sessions.set(session.sessionId, session);
    return ok(this.#project(session));
  }

  async beginVerification(
    sessionId: UUID,
    method: VerificationMethod,
  ): Promise<Result<VerificationChallenge>> {
    const session = this.#liveSession(sessionId);
    if (session === undefined) return this.#refuse();

    const target = destinationFor(method, session.hints);
    if (target === undefined || target === '') return this.#refuse();

    const at = this.#now();
    const ttl = (this.options.challengeTtlSeconds ?? 5 * 60) * 1000;
    const code = this.#generateCode();

    const challenge: StoredChallenge = {
      challengeId: this.#newId(),
      sessionId,
      method,
      destination: target,
      codeHmac: this.#hmac(code),
      expiresAtMs: at + ttl,
      attemptsRemaining: this.options.maxAttempts ?? 5,
      consumed: false,
    };
    this.#challenges.set(challenge.challengeId, challenge);

    // Send unconditionally-shaped: whether the destination is a known customer is
    // resolved only AFTER the code is proven, so this call cannot be used to ask "does
    // this mobile number belong to one of your customers?".
    await this.options.sender.send(method, target, code);

    return ok({
      challengeId: challenge.challengeId,
      method,
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      attemptsRemaining: challenge.attemptsRemaining,
    });
  }

  async completeVerification(
    sessionId: UUID,
    challengeId: UUID,
    proof: string,
  ): Promise<Result<CustomerSession>> {
    const session = this.#liveSession(sessionId);
    if (session === undefined) return this.#refuse();

    const challenge = this.#challenges.get(challengeId);
    const at = this.#now();

    // Every one of these renders as the same refusal. Telling a caller "expired" versus
    // "wrong code" versus "not your challenge" hands them a map of what they got right.
    if (
      challenge === undefined ||
      challenge.sessionId !== sessionId ||
      challenge.consumed ||
      challenge.expiresAtMs <= at ||
      challenge.attemptsRemaining <= 0
    ) {
      return this.#refuse();
    }

    // Decrement BEFORE comparing. If the comparison threw, or the process died between
    // compare and decrement, the attempt must still have cost the attacker something.
    challenge.attemptsRemaining -= 1;

    if (!this.#matches(challenge.codeHmac, proof)) return this.#refuse();

    // Single-use: burn it on success, so a replay of the same code finds nothing.
    challenge.consumed = true;
    this.#challenges.delete(challengeId);

    const customerRef = await this.options.lookup.byContact(challenge.method, challenge.destination);

    // Proving control of a contact detail is real evidence even when it matches no
    // customer record: the person is no longer anonymous, they are simply not a known
    // customer. Conflating the two would either over-grant (treating an unknown as a
    // customer) or lose the evidence entirely.
    session.assurance = customerRef !== null ? 'VERIFIED_CUSTOMER' : 'PSEUDONYMOUS';
    if (customerRef !== null) session.customerRef = customerRef;
    // The instant assurance was raised. Conversations created before this point were
    // created under a DIFFERENT identity claim and are not inherited (§27.3).
    session.verifiedAtMs = at;

    return ok(this.#project(session));
  }

  async resolveCustomer(
    sessionId: UUID,
  ): Promise<Result<{ customerRef: CanonicalRef; assurance: Assurance } | null>> {
    const session = this.#liveSession(sessionId);
    if (session === undefined) return ok(null);
    if (session.customerRef === undefined) return ok(null);
    return ok({ customerRef: session.customerRef, assurance: session.assurance });
  }

  async invalidate(sessionId: UUID): Promise<Result<void>> {
    this.#sessions.delete(sessionId);
    // Drop the session's challenges too: a challenge outliving its session is a code
    // that can still be redeemed against something that no longer exists.
    for (const [id, challenge] of this.#challenges) {
      if (challenge.sessionId === sessionId) this.#challenges.delete(id);
    }
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'UP',
      authority: 'TEMPORARY_AUTHORITY',
      checkedAt: new Date(this.#now()).toISOString(),
      detail: 'local OTP identity: interim authority, replaced by CCS in Phase 10',
    };
  }

  /** Expiry is read from the clock, so no sweep job's failure can extend a session. */
  #liveSession(sessionId: UUID): StoredSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (session.expiresAtMs <= this.#now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  #project(session: StoredSession): CustomerSession {
    return {
      sessionId: session.sessionId,
      assurance: session.assurance,
      channel: session.channel,
      ...(session.customerRef !== undefined ? { customerRef: session.customerRef } : {}),
      issuedAt: new Date(session.issuedAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      ...(session.verifiedAtMs !== undefined
        ? { verifiedAt: new Date(session.verifiedAtMs).toISOString() }
        : {}),
    };
  }

  #generateCode(): string {
    const length = this.options.codeLength ?? 6;
    // `randomInt` is drawn from the CSPRNG and is free of the modulo bias that
    // `Math.floor(Math.random() * n)` introduces — and Math.random is not cryptographic
    // in the first place.
    let code = '';
    for (let i = 0; i < length; i += 1) code += String(randomInt(0, 10));
    return code;
  }

  #hmac(code: string): string {
    return createHmac('sha256', this.options.secret).update(`otp:${code}`).digest('hex');
  }

  /**
   * Constant-time comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, which would itself be a timing
   * signal — so both sides are hashed to a fixed 32 bytes first and the comparison is
   * always over equal lengths.
   */
  #matches(expectedHmac: string, proof: string): boolean {
    const actual = Buffer.from(this.#hmac(proof), 'hex');
    const expected = Buffer.from(expectedHmac, 'hex');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  #refuse(): Result<never> {
    return err({
      code: 'VERIFICATION_REFUSED',
      message: 'verification refused',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: 'local-otp',
    });
  }
}

/**
 * Which hint a method delivers to.
 *
 * An OTP method must never fall back to a different channel: sending an "email OTP" to
 * a mobile number because the email was absent would deliver a credential to an address
 * the caller chose rather than the one the method names.
 */
function destinationFor(method: VerificationMethod, hints: IdentityHints): string | undefined {
  switch (method) {
    case 'OTP_MOBILE':
      return hints.mobile;
    case 'OTP_EMAIL':
      return hints.email;
    case 'POLICY_LOOKUP':
    case 'AUTH_PORTAL':
      // Not OTP flows. They belong to the upstream authority (Phase 10) and are refused
      // here rather than approximated — a stubbed portal login that "works" is worse
      // than one that plainly does not exist.
      return undefined;
  }
}
