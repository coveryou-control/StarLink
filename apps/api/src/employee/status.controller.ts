/**
 * What people say they are doing.
 *
 * ## Three questions this must not be confused with
 *
 * **Presence** is a realtime lease, and §21.9 forbids reading more into it than
 * "connected" — a phone entering a lift is not leave. **Availability** is
 * `identity.agent_states`, which routing reads and which decides who is given work.
 * **This** is a sentence somebody typed about themselves: nothing infers it, nothing
 * routes on it, and it has no consequences beyond telling a colleague what to expect.
 *
 * The three are rendered together and never merged. Somebody can be offline with "in a
 * meeting" set — they closed the laptop and went — and online with it too. One indicator
 * covering all three would lose exactly what the reader wants to know.
 *
 * ## Why it is not on the directory controller
 *
 * The directory is HRMS's, behind an adapter, and rule 11 keeps StarLink from growing a
 * second user authority. This fact is StarLink's own — HRMS has no opinion about whether
 * somebody is in a meeting — so serving it from the directory tree would dress a local
 * fact as an upstream one, which is the confusion the adapter boundary exists to prevent.
 *
 * ## Reading other people's is not sensitive, and is still bounded
 *
 * Any signed-in employee may read any colleague's status: it is a courtesy that only works
 * if the person about to message you can see it, and it contains nothing a directory
 * lookup does not already give. What is bounded is the COST — the id list is capped, so a
 * caller cannot turn one request into a table scan.
 */
import { Body, Controller, Get, Inject, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  DECLARED_STATUSES,
  STATUS_DURATIONS_MINUTES,
  type UUID,
} from '@starlink/shared-contracts';
import type { PgStatusStore } from '@starlink/database';

import { STATUS_STORE } from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();

/**
 * Setting your own status.
 *
 * `minutes` is a DURATION, computed against the server clock, for the same reason mute's
 * is: a browser running fast that sent an instant would set a status that had already
 * lapsed, and the person would see their own claim silently do nothing.
 *
 * It is required for everything except AVAILABLE and refused for AVAILABLE — that is not
 * fussiness. AVAILABLE is the absence of a claim; giving it an expiry would mean "I stop
 * being available in an hour", which is a different statement nobody asked to make.
 */
const setSchema = z
  .object({
    status: z.enum(DECLARED_STATUSES),
    minutes: z
      .number()
      .int()
      .refine((value) => (STATUS_DURATIONS_MINUTES as readonly number[]).includes(value))
      .optional(),
  })
  .refine((body) => (body.status === 'AVAILABLE') === (body.minutes === undefined), {
    message: 'every status except AVAILABLE carries an expiry, and AVAILABLE carries none',
  });

/**
 * Whose statuses to read.
 *
 * Fifty, matching the presence query's own cap. The two are fetched together for the same
 * set of faces on screen, and a different ceiling on each would mean one silently
 * truncating where the other did not — so half the avatars would show a status and the
 * rest would not, for no reason a person could see.
 */
const MAX_IDS = 50;

const readSchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((raw) => raw.split(',').filter((part) => part !== ''))
    .refine((ids) => ids.length <= MAX_IDS)
    .refine((ids) => ids.every((id) => uuid.safeParse(id).success)),
});

@Controller('v1/employee')
@RequireSurface('EMPLOYEE')
export class StatusController {
  constructor(@Inject(STATUS_STORE) private readonly statuses: PgStatusStore) {}

  /** Overridable in a test; see the conversations controller's own note. */
  protected now(): Date {
    return new Date();
  }

  @Get('auth/me/status')
  async mine(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    return this.statuses.mine(session.principalId as UUID, this.now().toISOString());
  }

  @Put('auth/me/status')
  async set(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = setSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;
    const at = this.now();
    /*
       AVAILABLE clears the expiry rather than keeping a stale one. Without this, going
       back to available while an old `clears_at` was still on the row would leave the
       table holding "available until 15:40", which the CHECK permits and which means
       nothing.
    */
    const clearsAt =
      parsed.data.minutes === undefined
        ? undefined
        : new Date(at.getTime() + parsed.data.minutes * 60_000).toISOString();

    await this.statuses.set(
      session.principalId as UUID,
      parsed.data.status,
      at.toISOString(),
      clearsAt,
    );

    return { status: parsed.data.status, clearsAt: clearsAt ?? null };
  }

  @Get('statuses')
  async forPeople(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    /* `request.session` is guaranteed by the surface guard; read so the handler cannot be
       mistaken for an unauthenticated one on a glance. */
    void request.session!;

    const parsed = readSchema.safeParse(query);
    if (!parsed.success) return refuse();

    return {
      statuses: await this.statuses.forPrincipals(
        parsed.data.ids as UUID[],
        this.now().toISOString(),
      ),
    };
  }
}
