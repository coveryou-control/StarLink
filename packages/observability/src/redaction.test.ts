/**
 * Log-schema gate (STARLINK_TEST_STRATEGY.md §8, brief §39).
 *
 * Fixtures deliberately contain the things a log must never hold. If any of them
 * survives redaction the test fails — which is the only reliable way to keep this
 * rule true, because the failure mode is somebody adding one debug line under
 * deadline and nobody noticing for six months.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { REDACTED, isForbiddenKey, redact } from './redaction.js';

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: 'test', sink: (line) => lines.push(line) });
  return { logger, lines, text: () => JSON.stringify(lines) };
};

describe('forbidden keys', () => {
  it('recognises message content, contact details, credentials and payloads', () => {
    const forbidden = [
      'body',
      'message',
      'preview',
      'lastMessagePreview',
      'transcript',
      'phone',
      'mobile',
      'email',
      'emailAddress',
      'pan',
      'policyNumber',
      'displayName',
      'password',
      'sessionId',
      'authorization',
      'set-cookie',
      'access_token',
      'refreshToken',
      'otp',
      'apiKey',
      'originalFilename',
      'requestBody',
      'payload',
    ];
    for (const key of forbidden) {
      expect(isForbiddenKey(key), `${key} must be forbidden`).toBe(true);
    }
  });

  it('permits the fields a log line is REQUIRED to carry', () => {
    // Over-redaction that removed these would make logs useless and push engineers
    // back toward logging whole request bodies — the very thing this prevents.
    const permitted = [
      'correlationId',
      'principalId',
      'conversationId',
      'messageId',
      'caseId',
      'operation',
      'durationMs',
      'outcome',
      'errorCode',
      'level',
      'service',
      'team',
      'channel',
      'visibility',
      'state',
      'seq',
    ];
    for (const key of permitted) {
      expect(isForbiddenKey(key), `${key} must be permitted`).toBe(false);
    }
  });
});

describe('logger output', () => {
  it('never emits a message body', () => {
    const { logger, text } = capture();
    logger.info('message created', {
      correlationId: 'corr-1',
      conversationId: 'conv-1',
      body: 'My policy number is ABCDE1234F and I am furious',
    });
    expect(text()).not.toContain('furious');
    expect(text()).toContain(REDACTED);
    expect(text()).toContain('conv-1');
  });

  it('never emits customer contact details, even in an unexpected key', () => {
    const { logger, text } = capture();
    logger.warn('delivery failed', {
      correlationId: 'corr-2',
      // `note` is not on the forbidden list — the value-level pattern must catch it.
      note: 'could not reach customer on 9876543210 or priya@example.com',
    });
    const out = text();
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain('priya@example.com');
  });

  it('redacts nested structures rather than trusting them', () => {
    const { logger, text } = capture();
    logger.info('inbound webhook', {
      correlationId: 'corr-3',
      // `providerName` is qualified, so it survives; a bare `name` would not (see the
      // key convention in redaction.ts). `from` is not on the forbidden list at all,
      // so the value-level phone pattern is what has to catch it.
      provider: { providerName: 'whatsapp', envelope: { from: '+919876543210', text: 'secret plans' } },
    });
    const out = text();
    expect(out).not.toContain('919876543210');
    expect(out).not.toContain('secret plans');
    expect(out).toContain('whatsapp');
  });

  it('redacts a bare `name` but keeps a qualified one', () => {
    const { logger, text } = capture();
    logger.info('routing', { correlationId: 'corr-7', name: 'Priya Sharma', teamName: 'claims' });
    const out = text();
    expect(out).not.toContain('Priya');
    expect(out).toContain('claims');
  });

  it('redacts tokens and cookies wherever they appear', () => {
    const { logger, text } = capture();
    logger.error('auth failure', {
      correlationId: 'corr-4',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', cookie: 'sl_session=xyz' },
    });
    const out = text();
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('sl_session=xyz');
  });

  it('redacts an Error message that carries identifying text', () => {
    const { logger, text } = capture();
    logger.error('unhandled', {
      correlationId: 'corr-5',
      err: new Error('failed sending to rahul@example.com'),
    });
    expect(text()).not.toContain('rahul@example.com');
  });

  it('carries the required fields through to the line', () => {
    const { logger, lines } = capture();
    logger
      .child({ correlationId: 'corr-6', service: 'api' })
      .info('conversation.read', { principalId: 'p-1', operation: 'conversation.read', durationMs: 12, outcome: 'SUCCEEDED' });
    const line = lines[0];
    expect(line).toMatchObject({
      correlationId: 'corr-6',
      principalId: 'p-1',
      operation: 'conversation.read',
      durationMs: 12,
      outcome: 'SUCCEEDED',
    });
  });
});

describe('redact()', () => {
  it('does not recurse without bound on a cyclic-looking deep structure', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('leaves primitives and identifiers intact', () => {
    expect(redact({ seq: 42, ok: true, conversationId: 'conv-9' })).toEqual({
      seq: 42,
      ok: true,
      conversationId: 'conv-9',
    });
  });
});
