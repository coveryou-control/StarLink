/**
 * Category taxonomy reads (§21.5, D-17/D-18).
 *
 * The categories themselves are a BUSINESS decision that has not been made. D-17 and
 * D-18 are open, and nothing in this file invents one: it reads whatever
 * `conversation.categories` holds and reports each row's `is_seed_placeholder` flag
 * outward as `provisional`.
 *
 * That flag is the whole point. The seed script installs a placeholder taxonomy so the
 * system can be built and demonstrated, and the pilot gate checks that no placeholder
 * survives into production. If this reader dropped the flag, placeholder categories
 * would look exactly like signed-off ones — and the first person to notice would be a
 * customer choosing "General enquiry (placeholder)" from a live widget.
 *
 * A conversation category is also NOT a conversation type. The type enum comes from the
 * brief (§5); the taxonomy is configuration layered on top, and mapping one to the other
 * is part of the same unmade decision.
 */
import type pg from 'pg';

export interface CategoryView {
  readonly categoryId: string;
  readonly displayName: string;
  readonly parentId?: string;
  readonly owningTeamId?: string;
  /**
   * True while this row is seeded scaffolding rather than a signed-off category
   * (D-17/D-18). Surfaces MUST show it as provisional rather than presenting it as
   * settled taxonomy.
   */
  readonly provisional: boolean;
}

export class PgCategoryReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The categories a customer may choose from, before any identity is established
   * (§21.5 — browsing precedes verification).
   *
   * Inactive categories are excluded by the query, not filtered afterwards: a
   * deactivated category must not be selectable, and a post-filter is how one
   * eventually is.
   */
  async listSelectable(): Promise<readonly CategoryView[]> {
    const result = await this.pool.query(
      `SELECT category_id, display_name, parent_id, owning_team_id, is_seed_placeholder
         FROM conversation.categories
        WHERE active
        ORDER BY parent_id NULLS FIRST, display_name`,
    );
    return result.rows.map(toView);
  }

  /**
   * Resolves one category for intake.
   *
   * Returns undefined for an unknown or inactive id rather than falling back to a
   * default. A silent default would file the customer's request under a category
   * nobody chose, and routing (Phase 5) would then send it to the wrong team.
   */
  async findSelectable(categoryId: string): Promise<CategoryView | undefined> {
    const result = await this.pool.query(
      `SELECT category_id, display_name, parent_id, owning_team_id, is_seed_placeholder
         FROM conversation.categories
        WHERE category_id = $1 AND active`,
      [categoryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toView(row);
  }

  /**
   * How many selectable categories are still placeholders.
   *
   * Exposed as a number so the pilot gate (§68) and an operator read the same value from
   * the same place, rather than someone eyeballing a table before go-live.
   */
  async provisionalCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS c FROM conversation.categories WHERE active AND is_seed_placeholder`,
    );
    return result.rows[0].c as number;
  }
}

function toView(row: Record<string, unknown>): CategoryView {
  return {
    categoryId: row.category_id as string,
    displayName: row.display_name as string,
    ...(row.parent_id !== null ? { parentId: row.parent_id as string } : {}),
    ...(row.owning_team_id !== null ? { owningTeamId: row.owning_team_id as string } : {}),
    provisional: row.is_seed_placeholder as boolean,
  };
}
