/**
 * Employee authentication (doc §26.2, §25.2).
 *
 * Authentication only. What a verified principal may DO is decided elsewhere, by the
 * domain, against the object being touched (P-02).
 */
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { IdentityAuthorizationClient } from '@starlink/shared-contracts';
import { cookieOptionsFor, type SessionService } from '@starlink/security';
import { METRICS, metrics, type Logger } from '@starlink/observability';
import type pg from 'pg';
import { CONFIG, DATABASE, IDENTITY_CLIENT, LOGGER, SESSION_SERVICE, AUDIT_WRITER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { Public, REFUSAL, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const signInSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(400),
  /**
   * "Keep me signed in on this device."
   *
   * Optional and defaulting to false, so a client that does not send it gets the short
   * session — the safe answer rather than the convenient one, which is the direction a
   * default about session length should always fall.
   */
  rememberMe: z.boolean().optional(),
});

@Controller('v1/employee/auth')
@RequireSurface('EMPLOYEE')
export class EmployeeAuthController {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(DATABASE) private readonly pool: pg.Pool,
  ) {}

  @Post('sign-in')
  @Public()
  @HttpCode(200)
  async signIn(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ principalId: string } | typeof REFUSAL> {
    const parsed = signInSchema.safeParse(body);
    // A malformed body and a wrong password are the same refusal: the shape of the
    // request must not be a probing oracle either.
    if (!parsed.success) return this.refuse(request, response, 'malformed');

    const verified = await this.identity.verifyCredential(parsed.data.username, parsed.data.password);
    if (!verified.ok) return this.refuse(request, response, 'credential');

    const claims = await this.identity.resolvePrincipal(verified.value.principalId);
    if (!claims.ok) return this.refuse(request, response, 'principal');

    /**
     * Twelve hours, or fourteen days if they asked to stay signed in on this device.
     *
     * ONE number, used for both the token and the cookie below. They must agree: a cookie
     * outliving its token leaves a dead credential on the machine, and a token outliving
     * its cookie signs somebody out while the session is still valid. Computing it here and
     * passing it to both is what makes disagreement impossible rather than unlikely.
     *
     * It does not weaken revocation. Every verification re-reads `sessionVersion`, so "sign
     * out everywhere" ends a fourteen-day session on its next request exactly as it ends a
     * twelve-hour one (FR-AUTH-2).
     */
    const ttlSeconds =
      parsed.data.rememberMe === true
        ? this.config.SL_SESSION_REMEMBER_TTL_SECONDS
        : this.config.SL_SESSION_TTL_SECONDS;

    const { token, payload } = this.sessions.issue({
      principalId: claims.value.principalId,
      kind: 'EMPLOYEE',
      surface: 'EMPLOYEE',
      // Baked in so that a later bump invalidates this cookie on the next request.
      sessionVersion: claims.value.sessionVersion,
      ttlSeconds,
    });

    /**
     * Spread, never copied field by field.
     *
     * `cookieOptionsFor` takes SECONDS and returns a `maxAge` already in the MILLISECONDS
     * Express wants — its own docstring says so, and the type carries the note. This call
     * site rebuilt the object by hand and multiplied by 1000 a second time, giving the
     * employee cookie a life of roughly 500 days instead of twelve hours.
     *
     * It was introduced while fixing the opposite defect on the customer surface (seconds
     * passed through unconverted, so a 30-minute session died in 1.8 seconds), and it
     * survived because the unit test pins the helper rather than the handler, and the
     * browser assertion was one-sided — `> 3600` is satisfied by 500 days as comfortably
     * as by twelve hours.
     *
     * The signed token still expired in twelve hours, so this was never an authentication
     * bypass: the cookie simply loitered on the machine long after it was useless, which
     * on a shared branch terminal is a real exposure and a confusing one to debug.
     *
     * Spreading is the fix that also removes the opportunity: there is now no place to
     * convert a unit, and both surfaces set the cookie the same way.
     */
    const cookie = cookieOptionsFor('EMPLOYEE', this.config.tls, ttlSeconds);
    response.cookie(cookie.name, token, { ...cookie });

    await this.audit.record({
      actorId: claims.value.principalId,
      actorKind: 'EMPLOYEE',
      action: 'auth.sign_in',
      targetKind: 'principal',
      targetId: claims.value.principalId,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      /* How long the session they just got will last. An audit entry saying somebody
         signed in, without saying whether the credential on that machine lives for half a
         day or a fortnight, omits the part an investigation would ask about. */
      detail: { sessionTtlSeconds: ttlSeconds },
    });

    this.logger.info('sign-in succeeded', {
      correlationId: request.correlationId,
      principalId: claims.value.principalId,
      operation: 'auth.sign_in',
      outcome: 'SUCCEEDED',
    });

    return { principalId: payload.principalId };
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    const cookie = cookieOptionsFor('EMPLOYEE', this.config.tls, 0);
    response.clearCookie(cookie.name, { path: cookie.path });
    if (request.session !== undefined) {
      await this.audit.record({
        actorId: request.session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'auth.sign_out',
        targetKind: 'principal',
        targetId: request.session.principalId,
        outcome: 'SUCCEEDED',
        correlationId: request.correlationId,
      });
    }
  }

  /**
   * Sign out everywhere — the control Settings' "Privacy & security" offers.
   *
   * ## It is one increment, not a list of devices
   *
   * ADR-008 makes a session a signed cookie carrying the principal's `sessionVersion`, and
   * every request re-reads that version. So revocation is a single increment: it takes
   * effect on the NEXT request from every device at once, including live sockets when the
   * gateway re-checks, and it needs no record of which devices exist.
   *
   * That is also why StarLink cannot list your devices — there is nothing to list. Making
   * one would mean a row per session, written on issue and read on every request, which is
   * precisely the lookup ADR-008 exists to avoid. The gap is real and is stated in the
   * settings screen rather than papered over with a plausible-looking device list.
   *
   * ## This browser included
   *
   * The cookie is cleared here too. Leaving it would hand the caller a token that is
   * already dead and let them discover it on their next click, which reads as a bug.
   */
  @Post('sign-out-everywhere')
  @HttpCode(204)
  async signOutEverywhere(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const session = request.session!;
    const revoked = await this.identity.revokeSessions(session.principalId, 'USER_REQUESTED');

    const cookie = cookieOptionsFor('EMPLOYEE', this.config.tls, 0);
    response.clearCookie(cookie.name, { path: cookie.path });

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'auth.sign_out_everywhere',
      targetKind: 'principal',
      targetId: session.principalId,
      outcome: revoked.ok ? 'SUCCEEDED' : 'FAILED',
      correlationId: request.correlationId,
    });
  }

  /** The one call the application shell depends on (doc §25.2). */
  @Get('me')
  async me(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return REFUSAL;

    return {
      principalId: claims.value.principalId,
      displayName: claims.value.displayName,
      department: claims.value.department,
      teams: claims.value.teams,
      roles: claims.value.roles.map((r) => ({ role: r.role, scope: r.scope })),
      // Surfaced deliberately: an interim identity source must be visible as such
      // wherever it is consumed (brief §48).
      authority: claims.value.authority,
      /**
       * This session, as far as ADR-008 can honestly describe it.
       *
       * There is no device list and there cannot be one: a session is a signed cookie
       * carrying a version number, checked against the account on every request, and
       * nothing records the individual sessions that exist. Settings used to say so and
       * show nothing; it can at least describe the session in front of it.
       *
       * `ip` is the address this request arrived from, taken from Express's own `ip`
       * (which respects `trust proxy`). It is shown back to the person it belongs to and
       * to nobody else — this is the one place in the product that reads it, and it is
       * not stored.
       *
       * There is deliberately no LOCATION. Deriving one means sending the address to a
       * geo-IP service, which is a third party receiving employee network data and a
       * data-residency question under the IRDAI record rules — not something to acquire
       * as a side effect of a settings row. And no MAC address: a browser cannot obtain
       * one, by any API, so a field for it could only ever be filled with a guess.
       */
      session: {
        startedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        ip: request.ip ?? null,
      },
    };
  }

  /**
   * One refusal shape and one code path for every failure, so timing and body are
   * identical whichever half went wrong (doc §27.1).
   */
  private async refuse(
    request: AuthenticatedRequest,
    response: Response,
    stage: string,
  ): Promise<typeof REFUSAL> {
    response.status(401);
    /**
     * §32.4: "Authentication failure rate spike — Above baseline — Credential attack
     * (§27.5)". `AuthFailureSpike` watches this counter and nothing wrote it before
     * 2026-08-29, so the alert for a credential-stuffing run could not fire.
     *
     * Counted at the single refusal funnel, which is also why §27.1 routes every failure
     * through one path: whichever half went wrong, the count is the same and the timing
     * is the same, so the metric cannot be used to distinguish "no such user" from
     * "wrong password" any more than the response can.
     */
    metrics.increment(METRICS.authFailures, 1);
    await this.audit.record({
      actorKind: 'EMPLOYEE',
      action: 'auth.sign_in',
      targetKind: 'principal',
      targetId: 'unknown',
      outcome: 'REFUSED',
      correlationId: request.correlationId,
      detail: { stage },
    });
    this.logger.info('sign-in refused', {
      correlationId: request.correlationId,
      operation: 'auth.sign_in',
      outcome: 'REFUSED',
    });
    return REFUSAL;
  }
}
