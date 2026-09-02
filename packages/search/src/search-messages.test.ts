/**
 * Search rules.
 *
 * The valuable assertions here are the refusals and the audit, not the happy path —
 * search is an exfiltration tool as much as a feature (§30.5), so what it declines to
 * do is the security-relevant half.
 */
import { describe, expect, it } from 'vitest';
import type { AuthorizedScope, Page, Result, SearchHit, SearchProvider } from '@starlink/shared-contracts';
import { ok, err } from '@starlink/shared-contracts';
import { createRateLimiter } from './rate-limit.js';
import { searchMessages, type SearchAuditEntry } from './search-messages.js';

const PRINCIPAL = '018f2c5a-eeee-7000-8000-00000000000a';

function createProvider(
  behaviour: 'ok' | 'empty' | 'fail' = 'ok',
): SearchProvider & { lastScope?: AuthorizedScope; calls: number } {
  const provider = {
    calls: 0,
    lastScope: undefined as AuthorizedScope | undefined,
    async index() {
      return ok(undefined);
    },
    async remove() {
      return ok(undefined);
    },
    async search(scope: AuthorizedScope): Promise<Result<Page<SearchHit>>> {
      provider.calls += 1;
      provider.lastScope = scope;
      if (behaviour === 'fail') {
        return err({
          code: 'SEARCH_FAILED',
          message: 'index unavailable',
          retryable: true,
          failureClass: 'FAIL_DEGRADED',
          correlationId: 'test',
        });
      }
      if (behaviour === 'empty') return ok({ items: [] });
      return ok({
        items: [
          { documentId: 'm-1', conversationId: 'c-1', snippet: 'a <<match>> here', score: 0.4 },
        ],
      });
    },
    async health() {
      return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: new Date().toISOString() };
    },
  };
  return provider;
}

const collector = () => {
  const entries: SearchAuditEntry[] = [];
  return { entries, recordSearch: async (e: SearchAuditEntry) => void entries.push(e) };
};

const command = (over: Partial<Parameters<typeof searchMessages>[0]> = {}) => ({
  principalId: PRINCIPAL,
  principalKind: 'EMPLOYEE' as const,
  term: 'renewal documents',
  correlationId: 'corr-1',
  ...over,
});

describe('scope is decided here, never taken from the caller', () => {
  it('passes the principal as the authoritative scope', async () => {
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command(), { provider, recordSearch: audit.recordSearch });
    expect(provider.lastScope?.principalId).toBe(PRINCIPAL);
  });

  it('allows internal notes for an employee', async () => {
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command(), { provider, recordSearch: audit.recordSearch });
    expect(provider.lastScope?.includeInternal).toBe(true);
  });

  it('NEVER allows internal notes for a customer (§30.5)', async () => {
    // Derived from the principal's kind, not from anything the request supplied — a
    // customer cannot ask to be treated as staff.
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command({ principalKind: 'CUSTOMER' }), {
      provider,
      recordSearch: audit.recordSearch,
    });
    expect(provider.lastScope?.includeInternal).toBe(false);
  });

  it('treats a conversation id as narrowing, not widening', async () => {
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command({ conversationId: 'c-9' }), {
      provider,
      recordSearch: audit.recordSearch,
    });
    // The principal scope is still present alongside the narrowing.
    expect(provider.lastScope?.principalId).toBe(PRINCIPAL);
    expect(provider.lastScope?.conversationIds).toEqual(['c-9']);
  });
});

describe('short terms are refused, not answered (FR-SRCH-5)', () => {
  it('refuses a term below the minimum without touching the provider', async () => {
    const provider = createProvider();
    const audit = collector();
    for (const term of ['', ' ', 'a', 'ab']) {
      const result = await searchMessages(command({ term }), {
        provider,
        recordSearch: audit.recordSearch,
      });
      expect(result.ok, term).toBe(false);
      if (!result.ok) expect(result.reason).toBe('TERM_TOO_SHORT');
    }
    // A refused search must not reach the index at all.
    expect(provider.calls).toBe(0);
  });
});

describe('every search is audited WITH THE TERM (FR-SRCH-3)', () => {
  it('records a successful search and its result count', async () => {
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command({ term: 'policy lapse' }), {
      provider,
      recordSearch: audit.recordSearch,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      principalId: PRINCIPAL,
      term: 'policy lapse',
      outcome: 'SUCCEEDED',
      resultCount: 1,
    });
  });

  it('records a REFUSED short term too — a stream of probes is itself a signal', async () => {
    const provider = createProvider();
    const audit = collector();
    await searchMessages(command({ term: 'ab' }), { provider, recordSearch: audit.recordSearch });
    expect(audit.entries[0]).toMatchObject({ outcome: 'REFUSED', term: 'ab' });
  });

  it('records a FAILED search', async () => {
    const provider = createProvider('fail');
    const audit = collector();
    await searchMessages(command(), { provider, recordSearch: audit.recordSearch });
    expect(audit.entries[0]?.outcome).toBe('FAILED');
  });
});

describe('"no matches" and "no data" are different answers (FR-SRCH-4)', () => {
  it('an empty result is a SUCCESS with matched=false', async () => {
    const provider = createProvider('empty');
    const audit = collector();
    const result = await searchMessages(command(), { provider, recordSearch: audit.recordSearch });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched).toBe(false);
      expect(result.page.items).toHaveLength(0);
    }
  });

  it('a provider failure is a FAILURE, never an empty page', async () => {
    // Rendering these identically would tell the user "no matches" when the truth is
    // "we could not look" (§34.1).
    const provider = createProvider('fail');
    const audit = collector();
    const result = await searchMessages(command(), { provider, recordSearch: audit.recordSearch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SEARCH_UNAVAILABLE');
  });
});

describe('rate limiting (§27.5)', () => {
  it('refuses once the allowance is spent, and audits the refusal', async () => {
    const provider = createProvider();
    const audit = collector();
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const deps = { provider, recordSearch: audit.recordSearch, allowRequest: (id: string) => limiter.allow(id) };

    expect((await searchMessages(command(), deps)).ok).toBe(true);
    expect((await searchMessages(command(), deps)).ok).toBe(true);

    const third = await searchMessages(command(), deps);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('RATE_LIMITED');
    expect(audit.entries.at(-1)?.outcome).toBe('REFUSED');
    // The limited request never reached the index.
    expect(provider.calls).toBe(2);
  });

  it('limits per principal, so one heavy user cannot lock out another', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.allow('principal-a')).toBe(true);
    expect(limiter.allow('principal-a')).toBe(false);
    expect(limiter.allow('principal-b')).toBe(true);
  });

  it('recovers as the window slides', async () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1_000, now: () => clock });
    expect(limiter.allow(PRINCIPAL)).toBe(true);
    expect(limiter.allow(PRINCIPAL)).toBe(false);
    clock += 1_500;
    expect(limiter.allow(PRINCIPAL)).toBe(true);
  });
});
