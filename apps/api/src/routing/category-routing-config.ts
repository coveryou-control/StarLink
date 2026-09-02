/**
 * The business values the §21.8 tree needs, read from configuration (§21.8, ADR-017).
 *
 * The Local orchestrator takes every business decision as an injected function precisely
 * so that this file — the one place that reads configuration — is where they can be
 * audited. Each of the four below is an unanswered question, and each is answered here in
 * the narrowest way that is not an invention:
 *
 * | What                    | Where it comes from                     | Open as |
 * |-------------------------|-----------------------------------------|---------|
 * | category → team         | `categories.owning_team_id`             | D-17    |
 * | relationship-shaped?    | `categories.relationship_shaped`        | D-17    |
 * | weight of one unit      | `capacity_policies.work_weights`        | D-05    |
 * | fallback when unavailable | see the note on `fallbackPolicy`      | D-05    |
 *
 * Cached for the lifetime of a sweep tick rather than the process: category
 * configuration is administered through an API (brief §57) and a process-lifetime cache
 * would mean a lead changes a mapping and nothing happens until someone restarts a
 * server, which is exactly how configuration stops being configuration.
 */
import type pg from 'pg';
import type { FallbackPolicy } from '@starlink/adapter-work-orchestrator';

export interface CategoryRouting {
  readonly teamId?: string;
  readonly relationshipShaped: boolean;
  readonly weight: number;
}

export class CategoryRoutingConfig {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Everything the tree needs about one category.
   *
   * An unknown category returns `teamId: undefined`, which the orchestrator turns into a
   * FAIL_CLOSED refusal rather than a guess. "Routing to some team is how work
   * disappears" (§21.8).
   */
  async forCategory(categoryId: string): Promise<CategoryRouting> {
    const result = await this.pool.query(
      `SELECT c.owning_team_id,
              c.relationship_shaped,
              (SELECT cp.work_weights
                 FROM conversation.capacity_policies cp
                WHERE cp.scope_kind = 'CATEGORY' AND cp.scope_id = c.category_id
                LIMIT 1) AS weights
         FROM conversation.categories c
        WHERE c.category_id = $1 AND c.active`,
      [categoryId],
    );

    const row = result.rows[0];
    if (row === undefined) return { relationshipShaped: false, weight: 1 };

    const weights = (row.weights ?? {}) as Record<string, unknown>;
    const configured = weights[categoryId] ?? weights.default;

    return {
      ...(row.owning_team_id !== null ? { teamId: row.owning_team_id as string } : {}),
      relationshipShaped: row.relationship_shaped as boolean,
      /**
       * ONE, when no weight is configured.
       *
       * Not a staffing judgement — the identity. Weights only mean anything relative to
       * a ceiling, and where no ceiling is configured the number is never compared to
       * anything. Where a ceiling IS configured but weights are not, treating every unit
       * of work as one unit is the only reading that does not silently rank categories
       * against each other on our own authority. The real weights are D-05.
       */
      weight: typeof configured === 'number' && configured > 0 ? configured : 1,
    };
  }
}

/**
 * The fallback ladder when a designated advisor is unavailable (§21.8 step 5, D-05).
 *
 * `TEAM_QUEUE` — and it is worth being explicit that this is a choice made in the absence
 * of an answer rather than an answer.
 *
 * The other two rungs cannot be expressed at all without configuration nobody has
 * supplied: `NAMED_BACKUP` needs a named backup per advisor, and `LEAD_REASSIGNS` needs a
 * lead per team. Neither exists as a configuration entity yet. `TEAM_QUEUE` is the one
 * §21.8 itself calls *"the safe default a business may still choose"*, and it is the
 * least-promising of the three: the conversation stays visible and claimable by anyone on
 * the team, which is what would have happened anyway had the tree never run.
 *
 * When D-05 is answered this becomes a per-team configuration read, not an edit here.
 */
export const DEFAULT_FALLBACK: FallbackPolicy = { kind: 'TEAM_QUEUE' };
