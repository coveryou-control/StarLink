export {
  isLifecycleBearing,
  isTerminal,
  transition,
  OPEN_STATES,
  TRANSITIONS,
  type LifecycleActor,
  type TransitionRefusal,
  type TransitionRequest,
  type TransitionResult,
  type TransitionRule,
} from './lifecycle.js';
export {
  decideReopen,
  reopenWindowExpiresAt,
  type ReopenDecision,
  type ReopenPolicy,
  type ResolvedConversation,
} from './reopen.js';
export {
  internalStatesFor,
  toCustomerStatus,
  type CustomerVisibleStatus,
  DEFAULT_STATUS_WORDING,
} from './customer-vocabulary.js';
