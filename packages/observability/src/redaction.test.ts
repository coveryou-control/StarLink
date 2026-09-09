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
import { REDACTED, isForbiddenKey, redact, redactValueText } from './redaction.js';

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

/**
 * The gaps the 2026-09-08 audit found, and the boundary that must survive closing them.
 *
 * Content and PII keys used to match EXACTLY, so qualifying one switched the rule off:
 * `displayName` was redacted and `senderDisplayName` — a live field at six call sites —
 * was not. The convention "qualify your keys" is right for `name` and trains precisely the
 * habit that defeated everything else.
 */
describe('qualified content keys are still content', () => {
  it.each([
    'senderDisplayName',
    'customerDisplayName',
    'noteBody',
    'emailBody',
    'requestBody',
    'messagePreview',
    'callTranscript',
    'resultSnippet',
  ])('redacts %s', (key) => {
    expect((redact({ [key]: 'Archit Bali' }) as Record<string, unknown>)[key]).toBe(REDACTED);
  });

  it.each(['title', 'subject', 'note', 'internalNote', 'comment', 'searchQuery', 'username'])(
    'redacts user-authored %s',
    (key) => {
      expect((redact({ [key]: 'Salary discussion' }) as Record<string, unknown>)[key]).toBe(
        REDACTED,
      );
    },
  );

  /*
     The other half, and the reason `name` and `text` are NOT substrings. CLAUDE.md promises
     these pass; a fix that redacted them would make the logs useless and would be reverted
     by the next person to debug a queue.
  */
  it.each([
    ['teamName', 'claims'],
    ['providerName', 'twilio'],
    ['queueName', 'support'],
    ['eventName', 'message.created.v1'],
    ['contextId', 'ctx-1'],
    ['conversationId', '018f5eed-de70-7000-8000-000000000002'],
  ])('keeps operational %s', (key, value) => {
    expect((redact({ [key]: value }) as Record<string, unknown>)[key]).toBe(value);
  });
});

describe('a credential inside a URI', () => {
  it('redacts a connection string even when the host has no dotted TLD', () => {
    /* `@localhost` defeats the email pattern, so the password sailed through under an
       innocent key like `url` or `dsn`. */
    const out = redact({ url: 'postgres://starlink:S3cr3tPw@localhost:5432/starlink' }) as Record<
      string,
      unknown
    >;
    expect(String(out.url)).not.toContain('S3cr3tPw');
  });

  it('leaves an ordinary URL alone', () => {
    const url = 'https://github.com/coveryou-control/StarLink';
    expect((redact({ url }) as Record<string, unknown>).url).toBe(url);
  });
});

describe('the log message is scrubbed, not only the context', () => {
  it('removes an interpolated address and phone number', () => {
    const out = redactValueText('could not deliver to archit@coveryou.co.in on +919876543210');
    expect(out).not.toContain('archit@coveryou.co.in');
    expect(out).not.toContain('919876543210');
  });
});
