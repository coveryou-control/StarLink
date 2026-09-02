/**
 * Customer session and identity verification (§21.5, §26.1, ADR-019).
 *
 * The assurance ladder, in the order a customer actually walks it:
 *
 *   1. `POST /session` — an ANONYMOUS session and a real `CUSTOMER` principal. Browsing
 *      and starting a conversation precede identity (§21.5), so the principal must exist
 *      before anyone is verified: the conversation needs an author and an audit trail
 *      either way.
 *   2. `POST /verify/start` — an OTP goes to a contact detail supplied at session
 *      creation. Nothing about assurance changes here.
 *   3. `POST /verify/complete` — a correct code raises assurance and re-issues the
 *      cookie. Proving control of an unknown contact yields PSEUDONYMOUS, not
 *      VERIFIED_CUSTOMER: real evidence, but not evidence of being a customer.
 *
 * Every failure on this route tree renders identically. Distinguishing "no such session"
 * from "wrong code" from "expired challenge" hands a prober a map of what they got right
 * (§27.1), and the adapter already collapses them — this layer must not helpfully
 * un-collapse them.
 */
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { formatCanonicalRef } from '@starlink/shared-contracts';
import type { CustomerIdentityProvider, Timestamp, UUID } from '@starlink/shared-contracts';
import type { PgCustomerStore } from '@starlink/database';
import { cookieOptionsFor, type SessionService } from '@starlink/security';
import type { Logger } from '@starlink/observability';
import {
  CONFIG,
  CUSTOMER_IDENTITY,
  CUSTOMER_STORE,
  LOGGER,
  SESSION_SERVICE,
} from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { AUDIT_WRITER } from '../tokens.js';
import { Public, REFUSAL, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const startSessionSchema = z.object({
  // Where a code would be sent, if the customer later chooses to verify. Not evidence
  // of anything — assurance moves only when a code comes back (ADR-019).
  mobile: z.string().min(6).max(20).optional(),
  email: z.string().email().max(200).optional(),
});

const beginSchema = z.object({ method: z.enum(['OTP_MOBILE', 'OTP_EMAIL']) });
const completeSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().min(4).max(12),
});

const CUSTOMER_COOKIE = 'sl_cus_session';

@Controller('v1/customer/auth')
export class CustomerAuthController {
  constructor(
    @Inject(CUSTOMER_IDENTITY) private readonly identity: CustomerIdentityProvider,
    @Inject(CUSTOMER_STORE) private readonly customers: PgCustomerStore,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Starts an anonymous session.
   *
   * Public by necessity — this is the door. It is also the only unauthenticated write on
   * the customer tree, which makes it the natural target for session-farming; the
   * per-IP limit belongs at the edge (§27.5) and is not pretended at here.
   */
  @Public()
  @Post('session')
  async startSession(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = startSessionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      response.status(400);
      return REFUSAL;
    }

    const created = await this.identity.createSession('WEBSITE', {
      ...(parsed.data.mobile !== undefined ? { mobile: parsed.data.mobile } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
    });
    if (!created.ok) {
      response.status(503);
      return REFUSAL;
    }

    // The adapter's session id IS the principal id. One identifier rather than two that
    // could drift, and no mapping table to keep in step; at Phase 10 CCS owns the
    // customer session and this collapses into whatever reference it hands back.
    const principalId = created.value.sessionId;
    const at = new Date().toISOString();
    // "Guest" rather than anything derived from the hints: a mobile number is not a
    // name, and echoing it back as a display name would put it in every message header.
    await this.customers.createPrincipal({ principalId, displayName: 'Guest', at });

    this.issueCookie(response, principalId, 'ANONYMOUS', 1);

    await this.audit.record({
      actorId: principalId,
      actorKind: 'CUSTOMER',
      action: 'customer.session.start',
      targetKind: 'principal',
      targetId: principalId,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { assurance: 'ANONYMOUS', channel: 'WEBSITE' },
    });

    return {
      principalId,
      assurance: 'ANONYMOUS',
      // The customer session id is deliberately NOT returned: it is the adapter's
      // internal handle, and the browser has no use for it beyond replay.
      verificationAvailable: parsed.data.mobile !== undefined || parsed.data.email !== undefined,
    };
  }

  @RequireSurface('CUSTOMER')
  @Post('verify/start')
  async beginVerification(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = beginSchema.safeParse(body);
    if (!parsed.success) return this.refuse(response);

    const session = request.session!;
    const customerSessionId = this.customerSessionFor(session.principalId);
    const begun = await this.identity.beginVerification(customerSessionId, parsed.data.method);

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'CUSTOMER',
      action: 'customer.verification.begin',
      targetKind: 'principal',
      targetId: session.principalId,
      outcome: begun.ok ? 'SUCCEEDED' : 'REFUSED',
      correlationId: request.correlationId,
      detail: { method: parsed.data.method },
    });

    if (!begun.ok) return this.refuse(response);

    // The code itself never appears in a response or a log.
    return {
      challengeId: begun.value.challengeId,
      method: begun.value.method,
      expiresAt: begun.value.expiresAt,
      attemptsRemaining: begun.value.attemptsRemaining,
    };
  }

  @RequireSurface('CUSTOMER')
  @Post('verify/complete')
  async completeVerification(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) return this.refuse(response);

    const session = request.session!;
    const customerSessionId = this.customerSessionFor(session.principalId);
    const completed = await this.identity.completeVerification(
      customerSessionId,
      parsed.data.challengeId,
      parsed.data.code,
    );

    // A burst of failures here is what account takeover looks like, so both outcomes
    // are audited (§31.3) — and the audit records the METHOD, never the code.
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'CUSTOMER',
      action: 'customer.verification.complete',
      targetKind: 'principal',
      targetId: session.principalId,
      outcome: completed.ok ? 'SUCCEEDED' : 'REFUSED',
      correlationId: request.correlationId,
    });

    if (!completed.ok) return this.refuse(response);

    const at = new Date().toISOString();
    let version = session.sessionVersion;
    if (completed.value.customerRef !== undefined) {
      // The bind bumps the version, which kills the cookie the caller is holding. The
      // new one must carry the NEW version, or verifying would silently sign them out.
      version =
        (await this.customers.bindCustomerRef(
          session.principalId,
          formatCanonicalRef(completed.value.customerRef),
          at,
        )) ?? version;
    }

    // Re-issue at the new assurance and the current version.
    this.issueCookie(response, session.principalId, completed.value.assurance, version);

    this.logger.info('customer assurance raised', {
      correlationId: request.correlationId,
      principalId: session.principalId,
      operation: 'customer.verification.complete',
      outcome: 'SUCCEEDED',
    });

    return {
      assurance: completed.value.assurance,
      verifiedAt: completed.value.verifiedAt,
      // Whether this contact matched a known customer is visible to the customer
      // themselves — they are entitled to know they are not recognised.
      recognised: completed.value.customerRef !== undefined,
    };
  }

  @RequireSurface('CUSTOMER')
  @Post('end')
  async endSession(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const session = request.session!;
    await this.identity.invalidate(this.customerSessionFor(session.principalId));
    /**
     * The part that actually ends the session.
     *
     * `invalidate` ends the OTP provider's record and `clearCookie` asks the browser to
     * drop it; neither touches a cookie that has already been copied, and until the
     * version was checked for customers there was nothing that did. Signing out now moves
     * the version past every token in existence.
     */
    await this.customers.revokeSessions(session.principalId, new Date().toISOString() as Timestamp);
    response.clearCookie(CUSTOMER_COOKIE, { path: '/' });
    response.status(204);
    return undefined;
  }

  private issueCookie(
    response: Response,
    principalId: UUID,
    assurance: string,
    sessionVersion: number,
  ): void {
    const { token, payload } = this.sessions.issue({
      principalId,
      kind: 'CUSTOMER',
      surface: 'CUSTOMER',
      sessionVersion,
      assurance: assurance as never,
    });
    const maxAge = Math.max(
      1,
      Math.floor((Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)) / 1000),
    );
    response.cookie(CUSTOMER_COOKIE, token, {
      ...cookieOptionsFor('CUSTOMER', this.config.tls, maxAge),
    });
  }

  /**
   * The adapter's session handle, derived from the principal.
   *
   * INTERIM: the local OTP adapter keys challenges by its own session id, and this
   * surface keys everything by principal. Deriving one from the other keeps the two
   * aligned without a second table — and disappears at Phase 10, when CCS owns customer
   * identity and this mapping goes with it.
   */
  private customerSessionFor(principalId: UUID): UUID {
    return principalId;
  }

  private refuse(response: Response): typeof REFUSAL {
    // 404 for everything, matching the employee surface: "may not" and "does not exist"
    // must be indistinguishable (§27.3).
    response.status(404);
    return REFUSAL;
  }
}
