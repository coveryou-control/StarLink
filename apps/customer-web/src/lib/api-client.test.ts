/**
 * The customer client calls the paths the API actually serves.
 *
 * Counterpart to the employee-side contract test, and to the route inventory checked
 * against a live API in `apps/api/src/route-contract.test.ts`. Written because five
 * paths in the employee client were wrong at once and nothing caught them: a URL is a
 * string, and the symptom in a browser is a blank panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerRoutes } from '@starlink/shared-contracts/http/customer';

import { ApiError, api } from './api-client';

const CONVERSATION = '018f2c5a-3a3a-7000-8000-000000000001';

interface Captured {
  url: URL;
  method: string;
  credentials: string | undefined;
  body: unknown;
}

let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      captured.push({
        url: new URL(input),
        method: init.method ?? 'GET',
        credentials: init.credentials,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const only = (): Captured => {
  expect(captured).toHaveLength(1);
  return captured[0]!;
};

describe('paths match the shared route contract', () => {
  it('startSession', async () => {
    await api.startSession({ mobile: '+919999900001' });
    const call = only();
    expect(call.url.pathname).toBe(customerRoutes.auth.startSession);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ mobile: '+919999900001' });
  });

  it('startSession with no hints sends an empty object, not undefined', async () => {
    await api.startSession();
    expect(only().body).toEqual({});
  });

  it('beginVerification', async () => {
    await api.beginVerification('OTP_MOBILE');
    const call = only();
    expect(call.url.pathname).toBe(customerRoutes.auth.verifyStart);
    expect(call.body).toEqual({ method: 'OTP_MOBILE' });
  });

  it('completeVerification', async () => {
    await api.completeVerification('challenge-1', '123456');
    const call = only();
    expect(call.url.pathname).toBe(customerRoutes.auth.verifyComplete);
    expect(call.body).toEqual({ challengeId: 'challenge-1', code: '123456' });
  });

  it('categories', async () => {
    await api.categories();
    expect(only().url.pathname).toBe(customerRoutes.categories);
  });

  it('conversations', async () => {
    await api.conversations();
    expect(only().url.pathname).toBe(customerRoutes.conversations.list);
  });

  it('startConversation', async () => {
    await api.startConversation({ categoryId: 'renewals', message: 'hello' });
    const call = only();
    expect(call.url.pathname).toBe(customerRoutes.conversations.intake);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ categoryId: 'renewals', message: 'hello' });
  });

  it('messages', async () => {
    await api.messages(CONVERSATION);
    expect(only().url.pathname).toBe(customerRoutes.conversations.messages(CONVERSATION));
  });

  it('send', async () => {
    await api.send(CONVERSATION, 'a reply', 'local-1');
    const call = only();
    expect(call.url.pathname).toBe(customerRoutes.conversations.messages(CONVERSATION));
    expect(call.body).toEqual({ message: 'a reply', clientMessageId: 'local-1' });
  });

  it('endSession', async () => {
    await api.endSession();
    expect(only().url.pathname).toBe(customerRoutes.auth.endSession);
  });
});

describe('the client cannot express an internal note', () => {
  it('sends only message and clientMessageId', async () => {
    // The customer API takes no `visibility`, and this client offers no way to supply
    // one. Belt to the server's braces: the handler hard-codes CUSTOMER_VISIBLE, and
    // nothing here can even ask for anything else (ADR-021).
    await api.send(CONVERSATION, 'text', 'local-1');
    expect(Object.keys(only().body as object).sort()).toEqual(['clientMessageId', 'message']);
  });

  it('intake sends no visibility either', async () => {
    await api.startConversation({ message: 'text' });
    expect(Object.keys(only().body as object)).not.toContain('visibility');
  });
});

describe('request construction and failure handling', () => {
  it('always sends credentials, so the HttpOnly session cookie travels', async () => {
    await api.categories();
    expect(only().credentials).toBe('include');
  });

  it('treats a network failure as unreachable, not as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await expect(api.categories()).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.isUnreachable && !e.isRefusal,
    );
  });

  it('classifies 404 as a refusal — absent and forbidden are the same answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })),
    );
    await expect(api.messages(CONVERSATION)).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.isRefusal,
    );
  });

  it('classifies 401 as unauthenticated, so the widget can restart the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })),
    );
    await expect(api.conversations()).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.isUnauthenticated,
    );
  });

  it('handles a 204 with no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.endSession()).resolves.toBeUndefined();
  });
});
