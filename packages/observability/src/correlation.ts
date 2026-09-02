/**
 * Correlation identity, propagated HTTP -> outbox -> job -> audit (brief §38).
 *
 * The point of a correlation id is that an incident can be followed across records
 * that live in different stores with different retentions. It is therefore generated
 * once at the edge and carried, never regenerated downstream.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly correlationId: string;
  /** Set only once authenticated; absent for anonymous intake. */
  readonly principalId?: string;
  /** Links an event or job back to the thing that caused it. */
  readonly causationId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const newCorrelationId = (): string => crypto.randomUUID();

/** Runs `fn` with the given context bound for its entire async subtree. */
export function withContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export const currentContext = (): RequestContext | undefined => storage.getStore();

/**
 * The correlation id for the current work, creating one if this is an entry point.
 *
 * Callers never have to decide whether to generate or inherit, which is how a
 * downstream component accidentally starts a new trace mid-request.
 */
export const currentCorrelationId = (): string => storage.getStore()?.correlationId ?? newCorrelationId();
