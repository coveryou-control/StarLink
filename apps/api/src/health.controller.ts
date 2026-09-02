/**
 * Liveness and readiness (doc §32.5).
 *
 * "Readiness must fail if configuration is invalid, not just if the database is down.
 *  A process running with a missing secret and serving errors is worse than one that
 *  refuses to accept traffic."
 *
 * Readiness also reports WHICH authority answered for identity, so an interim adapter
 * standing in for Central IAM is visible in operations rather than only in a document.
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type pg from 'pg';
import type { AIProvider, IdentityAuthorizationClient } from '@starlink/shared-contracts';
import { metrics } from '@starlink/observability';
import { AI_PROVIDER, DATABASE, IDENTITY_CLIENT } from './tokens.js';
import { Public } from './edge/session.guard.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
  ) {}

  /** Is the process running? Used by restart supervision only. */
  @Get('healthz')
  @Public()
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Should this instance receive traffic? */
  @Get('readyz')
  @Public()
  async ready(@Res({ passthrough: true }) response: Response): Promise<unknown> {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await this.pool.query('SELECT 1');
      checks.database = 'UP';
    } catch {
      checks.database = 'DOWN';
      ready = false;
    }

    const identity = await this.identity.health();
    checks.identity = identity.status;
    // Per-dependency status, degraded rather than binary (doc §32.5).
    checks.identityAuthority = identity.authority;
    if (identity.status === 'DOWN') ready = false;

    /**
     * AI is reported and NEVER affects readiness.
     *
     * That asymmetry is Part IV §68 gate 9 in one line — "human fallback works with AI
     * entirely disabled" — and it is why the AI health check cannot be written the way
     * the identity one is. Identity DOWN means this instance must not take traffic;
     * AI DOWN means a panel is missing. An instance that refused traffic because no AI
     * provider was configured would make the assistant a hard dependency of the
     * conversation, which is the inversion §36's "advisory only" rule exists to prevent.
     *
     * Reported so that "AI is off" is an operational fact somebody can see, rather than
     * something inferred from the absence of a feature.
     */
    const ai = await this.ai.health();
    checks.ai = ai.status;
    checks.aiAuthority = ai.authority;

    response.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  /**
   * The Prometheus scrape target.
   *
   * `@Public()` because a scraper carries no session, and the same reason it must be
   * reachable is the reason it must be reachable ONLY from inside: metric names and
   * label values describe internal structure — team names, queue depths, authorization
   * refusal rates — which §25.3 keeps away from customers. Nothing here carries a
   * message, a person's name or a customer identifier, and the redaction rules do not
   * apply because no free text reaches it; but the endpoint is still bound to the
   * deployment's internal network in `infrastructure/deployment`, not published.
   *
   * Text rather than JSON: this is the exposition format Prometheus parses.
   */
  @Get('metrics')
  @Public()
  scrape(@Res({ passthrough: true }) response: Response): string {
    response.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.render();
  }
}
