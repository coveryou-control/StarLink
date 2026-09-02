/**
 * Where an agent's capacity ceiling comes from (D-05, N-52).
 *
 * ## The defect this exists to remove
 *
 * `conversation.capacity_policies` is scoped — a row carries a `scope_kind` and a
 * `scope_id` — and three separate readers hardcoded `scope_kind = 'PRINCIPAL'`:
 * `availability-reader.ts`, `routing-store.ts` (the placement check) and
 * `team-load-reader.ts`. The seed writes **TEAM** rows.
 *
 * So every one of them resolved `NULL`, and an absent ceiling is treated as "no ceiling"
 * (`availability-reader.ts` says so explicitly, and it is the right default — a missing
 * policy must not stop work being placed). The consequence was that **no agent had a
 * capacity limit at all**, on a seeded database, while the feature read as built. The
 * capacity tests passed because each one inserts its own PRINCIPAL row first.
 *
 * ## The rule, and why it is this rule
 *
 * D-05 (2026-08-31): capacity is "a weighted, configurable model — never a fixed number in
 * code", with a development baseline of four normal chats per agent. A model that is
 * configurable per person AND per team needs a precedence, and the only sensible one is
 * the narrower scope winning:
 *
 *   1. a PRINCIPAL policy for this person, if one exists — the per-person override;
 *   2. otherwise the policy for a team they belong to;
 *   3. otherwise NULL, which every caller already reads as "no ceiling configured".
 *
 * Step 3 is unchanged and deliberate. Failing closed here would mean an unconfigured team
 * could have no work placed on it at all, which turns a missing business value into an
 * outage — the opposite of what §35.3 asks for.
 *
 * ## Why a shared fragment rather than three edited queries
 *
 * The three readers must agree, or the queue view shows a ceiling the placement path does
 * not enforce. They disagreed once already, in the same direction, for the same reason.
 * One definition is what stops that recurring.
 */

/**
 * A scalar subquery yielding the effective `capacity_units` for one principal, or NULL.
 *
 * `principalExpr` is interpolated as SQL, never as a value — callers pass a column
 * reference or a bind parameter they already control (`$1`, `p.principal_id::text`).
 * Nothing user-supplied reaches it.
 */
export function effectiveCapacityUnits(principalExpr: string): string {
  return `(
    SELECT cp.capacity_units
      FROM conversation.capacity_policies cp
     WHERE (
             (cp.scope_kind = 'PRINCIPAL' AND cp.scope_id = ${principalExpr})
             OR (cp.scope_kind = 'TEAM' AND cp.scope_id IN (
                   SELECT tm.team_id FROM identity.team_memberships tm
                    WHERE tm.principal_id::text = ${principalExpr}))
           )
     -- The narrower scope wins: a per-person override beats the team default.
     ORDER BY CASE cp.scope_kind WHEN 'PRINCIPAL' THEN 0 ELSE 1 END
     LIMIT 1
  )`;
}
