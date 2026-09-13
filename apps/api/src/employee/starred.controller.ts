import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { PgStarStore } from '@starlink/database';

import { RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';
import { STAR_STORE } from '../tokens.js';

type StarStore = Pick<PgStarStore, 'listFor'>;

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Everything the caller has starred, across every conversation.
 *
 * ## Why this is not under /conversations/:id
 *
 * A star's whole value is that it survives the thread it came from. Scoped per
 * conversation you would have to remember which one you were in when you bookmarked
 * something, which is the problem the bookmark exists to solve.
 *
 * ## Authorization
 *
 * There is no object check in this handler, and that is correct rather than missing: the
 * query itself joins live participation (see `PgStarStore.listFor`), so a thread the caller
 * has left cannot appear no matter how many rows they hold. The scope is applied by the
 * join, not by filtering after — the same pattern the conversation list uses, and the
 * reason rule 2 is satisfied before any body is read.
 */
@Controller('v1/employee/starred')
@RequireSurface('EMPLOYEE')
export class StarredController {
  constructor(@Inject(STAR_STORE) private readonly stars: StarStore) {}

  @Get()
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = listSchema.safeParse(query ?? {});
    const limit = parsed.success ? parsed.data.limit : 100;
    const starred = await this.stars.listFor(request.session!.principalId, limit);
    return { starred };
  }
}
