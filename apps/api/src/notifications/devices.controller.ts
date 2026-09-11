/**
 * Where this browser can be reached by a push (§29's PUSH channel).
 *
 * ## Two routes, and no way to ask about anybody else
 *
 * Register the calling principal's device, and forget one. There is deliberately no
 * "list my devices" and no route that takes a principal id: a token is an address for a
 * person's phone, and an endpoint that returned somebody's device list would be handing
 * out exactly the kind of fact §29 keeps out of notification payloads in the first place.
 *
 * The principal is always the session's. A token supplied by one person cannot be
 * registered against another, which is not a check here so much as an absence of the
 * parameter that would make it possible.
 *
 * ## Registration is idempotent, and re-registration is the normal case
 *
 * FCM hands the same browser the same token most days and a new one occasionally. The
 * client calls this on every start-up, so the common path is an UPDATE that moves
 * `last_seen_at` — which is what lets a sweep tell a device that has gone quiet from one
 * that is simply idle.
 */
import { Body, Controller, Delete, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { PgDeviceTokenStore } from '@starlink/database';

import { DEVICE_TOKENS } from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

/**
 * An FCM registration token is opaque and long, and the only useful thing to say about
 * it is that it is not empty and not absurd. Validating its SHAPE would be inventing a
 * format Google has changed before.
 */
const registerSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['WEB', 'ANDROID', 'IOS']).default('WEB'),
  /**
   * When this DEVICE should stay silent.
   *
   * Optional, and absent means always deliver. Validated to the same shapes the database
   * CHECK admits, so a malformed window is refused at the edge rather than becoming a
   * constraint violation five layers down — and because a half-written window is the
   * state that would mute somebody's phone for ever.
   *
   * The zone is an IANA name from the browser's own `Intl`, not an offset: an offset is
   * silently wrong twice a year and fails in the direction that wakes people.
   */
  quiet: z
    .object({
      from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timeZone: z.string().min(1).max(64),
    })
    .optional(),
});

@Controller('v1/employee/devices')
@RequireSurface('EMPLOYEE')
export class DevicesController {
  constructor(@Inject(DEVICE_TOKENS) private readonly devices: PgDeviceTokenStore) {}

  @Post()
  async register(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = registerSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse();

    /* The quiet window travels with the registration, so the server can decide whether
       to buzz this device. Absent means always deliver — and it is sent on EVERY
       registration, including as absent, so switching quiet hours off actually clears
       them rather than leaving yesterday's window in place. */
    const { inserted } = await this.devices.register(
      request.session!.principalId,
      parsed.data.token,
      parsed.data.platform,
      parsed.data.quiet,
    );
    /*
       `wasKnown` is how a browser discovers its token has been reaped.

       FCM invalidates a token, the transport is told `UNREGISTERED` and deletes the row,
       and the browser keeps presenting the same dead token from its own cache — client
       and server disagree silently and that device never receives another push. A client
       that REMEMBERED a token and is told the server did not have it can mint a fresh
       one. Nothing here is an error: a first registration is not known either, and the
       client only acts on this when it had a token already.
    */
    return { registered: true, wasKnown: !inserted };
  }

  /**
   * Stop sending to this device.
   *
   * Deleting by TOKEN and not checking whose it is, deliberately. A token is a secret the
   * device holds; presenting it is the proof. Requiring it to belong to the caller would
   * break the case this exists for — a browser that has been signed into by somebody else
   * and is unregistering the registration it made earlier.
   */
  @Delete(':token')
  async forget(
    @Param('token') token: string,
    @Req() _request: AuthenticatedRequest,
  ): Promise<unknown> {
    if (typeof token !== 'string' || token.trim().length < 20) return refuse();
    await this.devices.forget(token);
    return { forgotten: true };
  }
}
