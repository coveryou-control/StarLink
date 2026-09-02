export { MockWorkOrchestrator } from './mock/mock-work-orchestrator.js';
export {
  LocalWorkOrchestrator,
  type CategoryRouting,
  type LocalWorkOrchestratorOptions,
  type WorkOrchestratorStore,
} from './local/local-work-orchestrator.js';
export {
  assessAvailability,
  absenceCovers,
  isAvailable,
  type Availability,
  type AvailabilityFacts,
  type Candidate,
  type DeclaredAbsence,
  type UnavailableReason,
} from './local/availability.js';
export {
  route,
  type FallbackPolicy,
  type RoutingDecision as RoutingTreeDecision,
  type RoutingInputs,
  type RoutingStep,
} from './local/route.js';
