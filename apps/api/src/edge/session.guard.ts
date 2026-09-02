/**
 * Edge and route guards — layers 1 and 2 of the §18.4 authorization ladder.
 *
 *   [1] EDGE GUARD   is there a valid, unrevoked session?  -> 401
 *                    AUTHENTICATION ONLY. It says nothing about what may be read.
 *   [2] ROUTE GUARD  does this principal hold the permission this operation requires,
 *                    in principle? -> 403. Coarse: catches "customer calling an
 *                    employee-only operation".
 *
 * The check that actually matters is layer 3 — loading the object and authorizing it
 * together — and it lives in the domain, not here. Nothing in this file should ever
 * grow into a substitute for it.
 */
import {
  ForbiddenException,
  Inject,
  NotFoundException,
  ServiceUnavailableException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Surface, VerifiedSession, SessionService } from '@starlink/security';
import { SESSION_SERVICE } from '../tokens.js';

export const SURFACE_KEY = 'sl:surface';
/** Declares which surface a controller belongs to. Employee and customer route trees are disjoint. */
export const RequireSurface = (surface: Surface) => SetMetadata(SURFACE_KEY, surface);

export const PUBLIC_KEY = 'sl:public';
/** Marks an operation reachable without a session (sign-in, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export interface AuthenticatedRequest extends Request {
  correlationId: string;
  session?: VerifiedSession;
}

const COOKIE_FOR: Record<Surface, string> = {
  EMPLOYEE: 'sl_emp_session',
  CUSTOMER: 'sl_cus_session',
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]) === true) {
      return true;
    }

    const surface = this.reflector.getAllAndOverride<Surface>(SURFACE_KEY, [handler, controller]);
    if (surface === undefined) {
      // Fail closed: an operation that has not declared its surface is not reachable.
      // The same posture as FR-AUTHZ-3 — unknown is refused, never treated as open.
      throw new ForbiddenException(REFUSAL);
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[COOKIE_FOR[surface]] as string | undefined;
    if (token === undefined || token === '') throw new UnauthorizedException(REFUSAL);

    const verified = await this.sessions.verify(token, surface);
    if (!verified.ok) {
      // Every rejection reason renders identically to the caller. Distinguishing
      // "revoked" from "expired" from "no such principal" tells a prober which
      // half they got right (§27.1, §27.3).
      throw new UnauthorizedException(REFUSAL);
    }

    request.session = verified.session;
    return true;
  }
}

/**
 * One refusal shape for everything.
 *
 * "Not permitted" and "does not exist" must be indistinguishable, so existence is
 * never disclosed by the response (doc §27.3, FR-AUTHZ-5).
 */
export const REFUSAL = { error: 'request_refused' } as const;

/**
 * Refuses a request with a status code, not merely a body.
 *
 * An earlier version returned REFUSAL with HTTP 200, which meant a client could not
 * distinguish "your message was sent" from "you were denied" without inspecting the
 * body — and an end-to-end test duly read a refusal as a success. A refusal must be a
 * refusal at the protocol level.
 *
 * 404 is used for BOTH "you may not" and "it does not exist", which is the point:
 * a 403 would confirm the resource exists (§27.3).
 */
export function refuse(): never {
  throw new NotFoundException(REFUSAL);
}

/**
 * Object storage is down (doc §34.4).
 *
 * The one degradation that is deliberately NOT the uniform 404, and the reasoning is
 * worth stating because it looks like a §27.3 violation and is not.
 *
 * §34.4 is explicit about what a user must see when storage fails:
 *
 *   * upload — "Fails **explicitly**, before the message is sent. The user keeps their
 *     message and can retry — a message is never sent claiming an attachment that does
 *     not exist";
 *   * download — "Explicit error naming the attachment as **temporarily unavailable**,
 *     not a broken image or a silent blank".
 *
 * A 404 cannot say that. It says the file is not there, so a client renders "no such
 * attachment", the user believes their document was lost, and re-uploads it — which is
 * the "silent blank" §34.4 forbids, arrived at by a different route.
 *
 * §27.3 is not weakened, because of WHEN this is reachable. It is thrown only after
 * authorization has already passed: an actor who may not see the attachment gets the
 * uniform 404 from the ladder and never reaches here, whether storage is up or down. So
 * this discloses a fact about the SYSTEM, never about the resource or the actor — which
 * is the distinction §27.3 is actually drawing.
 *
 * 503 rather than 500: it is transient and the correct client behaviour is to retry.
 */
export const STORAGE_UNAVAILABLE = {
  error: 'attachment_temporarily_unavailable',
  retryable: true,
} as const;

export function storageUnavailable(): never {
  throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
}
