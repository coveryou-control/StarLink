/**
 * The client calls the paths the API actually serves.
 *
 * The other half of `apps/api/src/route-contract.test.ts`. That one proves the server
 * exposes every route in the shared inventory; this one proves the client asks for those
 * same paths. Between them, a renamed route breaks a test instead of a screen.
 *
 * Written after four paths in this file were wrong at once. TypeScript cannot help —
 * a URL is a string — and the symptom in a browser is an empty list, not an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { employeeRoutes } from '@starlink/shared-contracts/http/employee';

import { ApiError, api } from './api-client';

const CONVERSATION = '018f2c5a-1111-7000-8000-000000000001';
const _PRINCIPAL = '018f2c5a-1111-7000-8000-000000000002';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

const only = (): Captured => {
  expect(captured).toHaveLength(1);
  return captured[0]!;
};

describe('paths match the shared route contract', () => {
  it('me', async () => {
    await api.me();
    expect(only().url.pathname).toBe(employeeRoutes.auth.me);
  });

  it('signIn', async () => {
    await api.signIn('someone', 'secret');
    const call = only();
    expect(call.url.pathname).toBe(employeeRoutes.auth.signIn);
    expect(call.method).toBe('POST');
    // The API authenticates by username. Sending `email` produced a schema failure that
    // rendered as a generic "those details did not match".
    expect(call.body).toEqual({ username: 'someone', password: 'secret' });
  });

  it('signOut', async () => {
    await api.signOut();
    expect(only().url.pathname).toBe(employeeRoutes.auth.signOut);
    expect(only().method).toBe('POST');
  });

  it('conversations', async () => {
    await api.conversations();
    expect(only().url.pathname).toBe(employeeRoutes.conversations.list);
  });

  it('messages', async () => {
    await api.messages(CONVERSATION);
    expect(only().url.pathname).toBe(employeeRoutes.conversations.messages(CONVERSATION));
  });

  it('sendMessage', async () => {
    await api.sendMessage(CONVERSATION, {
      body: 'hello',
      visibility: 'INTERNAL',
      clientMessageId: 'local-1',
    });
    const call = only();
    expect(call.url.pathname).toBe(employeeRoutes.conversations.messages(CONVERSATION));
    expect(call.method).toBe('POST');
    // FR-MSG-3. The server's field is `clientMessageId`; an earlier version sent
    // `idempotencyKey`, which zod stripped — so every retry created a second message
    // and the duplicate-suppression this key exists for never ran.
    expect(call.body).toEqual({
      body: 'hello',
      visibility: 'INTERNAL',
      clientMessageId: 'local-1',
    });
  });

  it('markRead', async () => {
    await api.markRead(CONVERSATION, 42);
    const call = only();
    expect(call.url.pathname).toBe(employeeRoutes.conversations.read(CONVERSATION));
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ upToSeq: 42 });
  });

  it('directory', async () => {
    await api.directory('priya');
    const call = only();
    expect(call.url.pathname).toBe(employeeRoutes.directory.search);
    expect(call.url.searchParams.get('q')).toBe('priya');
  });

  it('search', async () => {
    await api.search('renewal');
    const call = only();
    expect(call.url.pathname).toBe(employeeRoutes.search.messages);
    expect(call.url.searchParams.get('q')).toBe('renewal');
  });
});

describe('request construction', () => {
  it('always sends credentials, so the HttpOnly session cookie travels', async () => {
    // The token is never readable from JS (FR-AUTH-1), so `credentials: 'include'` is
    // the only way it reaches the API. Omitting it makes every call anonymous.
    await api.me();
    expect(only().credentials).toBe('include');
  });

  it('passes a paging cursor through rather than dropping it', async () => {
    await api.conversations({ cursor: 'signed-cursor-value', limit: 25 });
    const call = only();
    expect(call.url.searchParams.get('cursor')).toBe('signed-cursor-value');
    expect(call.url.searchParams.get('limit')).toBe('25');
  });

  it('omits absent query parameters instead of sending "undefined"', async () => {
    await api.conversations();
    expect(only().url.search).toBe('');
  });

  it('encodes a cursor containing URL-significant characters', async () => {
    // Signed cursors are base64url, but a future encoding change must not silently
    // corrupt the cursor by concatenating it raw.
    await api.conversations({ cursor: 'a+b/c=d&e' });
    expect(only().url.searchParams.get('cursor')).toBe('a+b/c=d&e');
  });
});

describe('failure handling', () => {
  it('treats a network failure as unreachable, not as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    // Conflating the two would show "this conversation is unavailable" for dropped
    // wifi, inviting the reader to assume a permission problem.
    await expect(api.me()).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE', isRefusal: false });
  });

  it('classifies 404 as a refusal, since absent and forbidden are the same answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })),
    );

    await expect(api.messages(CONVERSATION)).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.isRefusal && !error.isUnauthenticated,
    );
  });

  it('classifies 401 as unauthenticated, so the shell can drop to sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })),
    );

    await expect(api.me()).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.isUnauthenticated,
    );
  });

  it('handles a 204 with no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.signOut()).resolves.toBeUndefined();
  });
});
