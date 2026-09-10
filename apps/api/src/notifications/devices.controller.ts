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
});

@Controller('v1/employee/devices')
@RequireSurface('EMPLOYEE')
export class DevicesController {
  constructor(@Inject(DEVICE_TOKENS) private readonly devices: PgDeviceTokenStore) {}

  @Post()
  async register(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = registerSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse();

    await this.devices.register(
      request.session!.principalId,
      parsed.data.token,
      parsed.data.platform,
    );
    return { registered: true };
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
