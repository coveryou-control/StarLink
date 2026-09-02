/**
 * Ownership COMMANDS. Not routing decisions.
 *
 * The §21.8 decision tree and §21.9 availability semantics used to live here and now sit
 * in `adapters/work-orchestrator/src/local/`. That was not a tidy-up: the boundary law
 * (`adapters-must-not-import-domain`) refused the import when the Local orchestrator
 * tried to call the tree, and the refusal was correct. The implementation plan scopes
 * the tree to the adapter in its own words — "LocalWorkOrchestratorAdapter (full §21.8
 * tree + §21.9 availability semantics)" — and at Phase 10 CCS makes those decisions and
 * the tree is deleted with the adapter that owns it.
 *
 * What stays here outlives that. Transfer, cover, escalation and exit-reassignment are
 * domain commands with a mandatory reason and a must-succeed audit, invoked by `apps/api`
 * and unchanged by which orchestrator is in place. §38 records two paths to one state
 * change as the defect that let the reference platform's authorization diverge; these
 * are the one path.
 */
export {
  cover,
  escalate,
  reassignOnExit,
  transfer,
  type AuditPort,
  type CommandDeps,
  type CommandFailure,
  type CommandResult,
  type OwnershipPort,
} from './commands.js';
