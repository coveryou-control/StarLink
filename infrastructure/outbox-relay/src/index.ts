/**
 * Transactional outbox relay (ADR-006, doc §21).
 *
 * Lives in `infrastructure/` rather than `packages/` or an app, for two reasons:
 *
 *   * It is not domain code. It polls a table and forwards rows; it holds no business
 *     rule, so `packages/` — which may not import adapters (ADR-002) — is the wrong
 *     shelf, and its tests legitimately need real adapter implementations.
 *   * It is not app code either. WHICH process hosts the relay is a deployment
 *     question that changes with the backplane: today the in-process backplane forces
 *     it into `apps/realtime-gateway`, and a shared backplane (Redis) moves it to a
 *     standalone worker. Code that two different processes may host must not live
 *     inside either of them — that was a cross-app import, and the boundary law
 *     rightly rejected it.
 */
export { OutboxRelay, type OutboxRelayOptions, type DrainResult } from './outbox-relay.js';
