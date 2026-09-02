/**
 * Adapter result and failure-classification types.
 *
 * Every adapter method declares how its failure must be handled. This turns the
 * failure invariants of brief §43 into something the type system and code review can
 * check, rather than something each call site decides for itself.
 */
import type { Timestamp } from '../domain/primitives.js';

/**
 * How a caller MUST behave when this operation fails.
 *
 * - FAIL_CLOSED   deny / refuse. Authorization and consent. An unavailable authority
 *                 is never an implicit permission (brief §43 invariant 2).
 * - FAIL_DEGRADED the feature disappears, the conversation continues. AI, search,
 *                 presence, business-object display context (invariants 8, 9, 10).
 * - FAIL_QUEUED   retry asynchronously through the job fabric. Notifications, channel
 *                 sends, event publication (invariants 3, 4).
 */
export type FailureClass = 'FAIL_CLOSED' | 'FAIL_DEGRADED' | 'FAIL_QUEUED';

export interface AdapterError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly failureClass: FailureClass;
  readonly correlationId: string;
  /** Never populated with message bodies, PII, credentials or provider payloads (brief §39). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AdapterError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: AdapterError): Result<T> => ({ ok: false, error });

/**
 * Health, including WHICH authority answered.
 *
 * `authority` is why an interim implementation can never be mistaken for canonical
 * truth in a dashboard or an incident review (INTEGRATION_CONTRACTS §1 rule 4).
 */
export interface HealthReport {
  readonly status: 'UP' | 'DEGRADED' | 'DOWN';
  readonly authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY' | 'MOCK';
  readonly checkedAt: Timestamp;
  readonly detail?: string;
}

export interface HealthReporting {
  health(): Promise<HealthReport>;
}

/**
 * Marks records produced by an interim implementation standing in for a system that
 * does not exist yet (brief §48). Surfaced in APIs and admin views so that nobody
 * builds a business process on a placeholder without knowing it.
 */
export const TEMPORARY_AUTHORITY = 'TEMPORARY_AUTHORITY' as const;
