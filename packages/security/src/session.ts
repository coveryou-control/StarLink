/**
 * Session issuance and verification (ADR-008, doc §26.2).
 *
 * The whole design turns on one property: **revocation must be effective on the NEXT
 * request, not at a cache expiry** (FR-AUTH-2). A signed cookie needs no lookup to be
 * *read*, which is exactly why a naive implementation makes revocation impossible.
 * So every verification re-reads the principal's `sessionVersion` and compares it to
 * the one baked into the token. Deactivation and role change take effect immediately
 * because the version moved (doc §26.2: "a revocation that lags is a revocation that
 * did not happen when somebody believed it had").
 *
 * Authentication only. What a verified principal may DO is a separate decision with a
 * separate failure mode (P-02), and lives in conversation-domain/authz.
 */
import type { Assurance, PrincipalKind, Timestamp, UUID } from '@starlink/shared-contracts';
import type { IdentityAuthorizationClient } from '@starlink/shared-contracts';
import { createSignedTokenCodec, type SignedTokenCodec } from './signed-token.js';

/** Employee and customer sessions are separate flows sharing no credential path (§26.1). */
export type Surface = 'EMPLOYEE' | 'CUSTOMER';

export interface SessionPayload {
  readonly principalId: UUID;
  readonly kind: PrincipalKind;
  readonly surface: Surface;
  /** Compared against the live principal on every request. This is the revocation hook. */
  readonly sessionVersion: number;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  /** Customer sessions only; employees have no assurance ladder (ADR-019). */
  readonly assurance?: Assurance;
}

export interface VerifiedSession {
  readonly principalId: UUID;
  readonly kind: PrincipalKind;
  readonly surface: Surface;
  readonly sessionVersion: number;
  readonly expiresAt: Timestamp;
  readonly assurance?: Assurance;
}

export type SessionRejection =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  /** The principal's version moved: deactivated, role changed, or explicitly revoked. */
  | 'REVOKED'
  | 'PRINCIPAL_UNKNOWN'
  | 'PRINCIPAL_INACTIVE'
  /** An employee cookie presented to the customer surface, or the reverse. */
  | 'WRONG_SURFACE';

export type SessionVerification =
  | { readonly ok: true; readonly session: VerifiedSession }
  | { readonly ok: false; readonly reason: SessionRejection };

/**
 * Reads the CURRENT session version of a customer principal.
 *
 * Deliberately a one-method port rather than the whole customer store: this file is the
 * authentication boundary and should be able to name exactly what it needs.
 */
export interface CustomerSessionVersionReader {
  sessionVersionOf(principalId: UUID): Promise<number | undefined>;
}

export interface SessionServiceOptions {
  readonly secret: string;
  readonly identity: IdentityAuthorizationClient;
  /**
   * Required in any process that serves customers; absent is FAIL-CLOSED, not permissive.
   *
   * Optional in the type because several processes (the realtime gateway, most unit
   * suites) only ever handle employee sessions, and forcing them to supply a customer
   * reader would be ceremony. A process that does serve customers and forgets this refuses
   * every customer session immediately and visibly, which is the failure you want.
   */
  readonly customerSessions?: CustomerSessionVersionReader;
  readonly employeeTtlSeconds?: number;
  readonly customerTtlSeconds?: number;
  /** Injected so tests can control time without waiting. */
  readonly now?: () => Date;
}

export interface IssueRequest {
  readonly principalId: UUID;
  readonly kind: PrincipalKind;
  readonly surface: Surface;
  readonly sessionVersion: number;
  readonly assurance?: Assurance;
}

export class SessionService {
  private readonly codec: SignedTokenCodec<SessionPayload>;
  private readonly now: () => Date;

  constructor(private readonly options: SessionServiceOptions) {
    // Purpose-bound, and a different secret from the cursor codec (doc §27.14).
    this.codec = createSignedTokenCodec<SessionPayload>({ secret: options.secret, purpose: 'session' });
    this.now = options.now ?? (() => new Date());
  }

  issue(request: IssueRequest): { token: string; payload: SessionPayload } {
    const issuedAt = this.now();
    const ttlSeconds =
      request.surface === 'CUSTOMER'
        ? // Customer sessions are bounded and shorter (§26.1).
          (this.options.customerTtlSeconds ?? 30 * 60)
        : (this.options.employeeTtlSeconds ?? 12 * 60 * 60);

    const payload: SessionPayload = {
      principalId: request.principalId,
      kind: request.kind,
      surface: request.surface,
      sessionVersion: request.sessionVersion,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
      ...(request.assurance !== undefined ? { assurance: request.assurance } : {}),
    };

    return { token: this.codec.sign(payload), payload };
  }

  /**
   * Verifies a token for a given surface.
   *
   * Order matters: cheap local checks first, then the one lookup. A forged or expired
   * token never reaches the identity store, so a flood of junk cookies cannot be used
   * to hammer it.
   */
  async verify(token: string, surface: Surface): Promise<SessionVerification> {
    const decoded = this.codec.verify(token);
    if (!decoded.valid) {
      return { ok: false, reason: decoded.reason === 'MALFORMED' ? 'MALFORMED' : 'BAD_SIGNATURE' };
    }

    const payload = decoded.payload;

    // A cookie minted for the employee host must not authenticate on the customer
    // host, even though both are signed with the same key (§19.3).
    if (payload.surface !== surface) return { ok: false, reason: 'WRONG_SURFACE' };

    if (Date.parse(payload.expiresAt) <= this.now().getTime()) {
      return { ok: false, reason: 'EXPIRED' };
    }

    /**
     * Customer sessions are revocable too. They were not.
     *
     * This returned `ok` on signature and expiry alone, skipping the version comparison
     * that the comment two paragraphs down calls "THE check". Three things followed, all
     * live:
     *
     *   * `POST /v1/customer/auth/end` cleared the cookie and invalidated the OTP
     *     provider's session — and the cookie it had just cleared kept verifying for the
     *     rest of its TTL. Recovered from a shared or kiosk browser, it read the whole
     *     thread. There was no server-side way to stop it short of waiting out the clock.
     *   * `PgCustomerStore.bindCustomerRef` bumps `session_version` on an assurance raise,
     *     with a comment explaining that a raise which did not invalidate the old cookie
     *     "would leave the pre-verification session usable alongside the new one". Nothing
     *     read the bump, so that is exactly what happened.
     *   * `sessionVersionOf` existed, filtered `kind = 'CUSTOMER'` correctly, and had zero
     *     callers.
     *
     * The realtime gateway meanwhile DID check the version for customers, so one column
     * gave two surfaces opposite answers about whether a session was still valid (§38).
     *
     * A missing reader refuses. The alternative — treating "not configured" as "no
     * revocation" — is how the original defect would come back the first time somebody
     * wires a new process.
     */
    if (payload.kind !== 'EMPLOYEE') {
      const customers = this.options.customerSessions;
      if (customers === undefined) return { ok: false, reason: 'REVOKED' };

      const current = await customers.sessionVersionOf(payload.principalId);
      if (current === undefined) return { ok: false, reason: 'PRINCIPAL_UNKNOWN' };
      if (current !== payload.sessionVersion) return { ok: false, reason: 'REVOKED' };

      return { ok: true, session: toVerified(payload) };
    }

    const claims = await this.options.identity.resolvePrincipal(payload.principalId);
    if (!claims.ok) return { ok: false, reason: 'PRINCIPAL_UNKNOWN' };

    // THE check. Everything else in this file is scaffolding around it.
    if (claims.value.sessionVersion !== payload.sessionVersion) {
      return { ok: false, reason: 'REVOKED' };
    }
    // A deactivated principal's token may still be within its version and expiry;
    // status is checked separately so exit is effective immediately (FR-EMP-2).
    if (claims.value.status !== 'ACTIVE') return { ok: false, reason: 'PRINCIPAL_INACTIVE' };

    return { ok: true, session: toVerified(payload) };
  }
}

const toVerified = (payload: SessionPayload): VerifiedSession => ({
  principalId: payload.principalId,
  kind: payload.kind,
  surface: payload.surface,
  sessionVersion: payload.sessionVersion,
  expiresAt: payload.expiresAt,
  ...(payload.assurance !== undefined ? { assurance: payload.assurance } : {}),
});

/**
 * Cookie attributes (doc §27.1, FR-AUTH-3).
 *
 * HttpOnly so script cannot read it; SameSite so a cross-site request carries nothing;
 * Secure whenever TLS is present. Host-scoped per surface so the two never mix.
 */
export interface CookieOptions {
  readonly name: string;
  readonly httpOnly: true;
  readonly sameSite: 'strict' | 'lax';
  readonly secure: boolean;
  readonly path: string;
  /**
   * MILLISECONDS, because this object is spread straight into Express's `res.cookie`,
   * whose `maxAge` is milliseconds — unlike the HTTP `Max-Age` attribute it produces,
   * which is seconds. The two units meeting under one name is what caused the defect
   * described on `cookieOptionsFor`.
   */
  readonly maxAge: number;
}

/**
 * Takes SECONDS and returns Express cookie options whose `maxAge` is MILLISECONDS.
 *
 * ## The defect this conversion fixes
 *
 * The seconds value used to be passed through unchanged into `res.cookie`, where Express
 * reads `maxAge` as milliseconds. Every session cookie therefore expired a thousand times
 * too early: a customer's 30-minute session lasted **1.8 seconds**, and an employee's
 * 12-hour session lasted **43 seconds**. The product was unusable by anyone who paused to
 * think between clicks.
 *
 * Nothing caught it because no test used a browser. The API integration suites build the
 * `Cookie` header by hand, and a hand-built header has no expiry — only a real cookie jar
 * enforces `Max-Age`, so only a real browser could ever have noticed. It was found the
 * first time one was pointed at the running product: the customer widget's second poll,
 * eight seconds after the first, came back 401.
 */
export const cookieOptionsFor = (surface: Surface, tls: boolean, maxAgeSeconds: number): CookieOptions => ({
  name: surface === 'EMPLOYEE' ? 'sl_emp_session' : 'sl_cus_session',
  httpOnly: true,
  // Strict on the employee surface; the customer widget may be entered from a link,
  // where strict would drop the cookie on first navigation.
  sameSite: surface === 'EMPLOYEE' ? 'strict' : 'lax',
  secure: tls,
  path: '/',
  maxAge: maxAgeSeconds * 1000,
});
