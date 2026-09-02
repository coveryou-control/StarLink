export * from './authz/index.js';
/**
 * §21.4's transition table is NOT here. It lives in `@starlink/service-case`, and this
 * package depends on that one.
 *
 * There used to be a second copy in `./state-machine.js` — exported from this barrel,
 * imported by nothing, and never tested. It was deleted on 2026-08-28 because a dead
 * duplicate of a decision table is worse than no copy: `import { TRANSITIONS } from
 * '@starlink/conversation-domain'` compiled, and returned a table that DISAGREED with the
 * real one. It omitted LEAD from `new → assigned` and from `resolved → active`, flattened
 * §21.4's "reason required if staff-initiated" to "not required", and had no CLOSED
 * terminal guard. Its one unique export, `pausesResolutionClock`, restated a rule the SLA
 * clock already implements properly — as pause spans read from `case_state_episodes`
 * (§23.5, §24.11), which the restatement could not have supplied.
 */
export * from './ports.js';
export * from './conversations.js';
export * from './mentions.js';
export * from './visibility/customer-projection.js';
