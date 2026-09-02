/**
 * Startup configuration (§35.3).
 *
 * These cover the rule that a misconfigured process must refuse to start rather than come
 * up and serve something other than what was asked for. The specific case here was found
 * by scanning for settings nothing reads: `SL_ADAPTER_CONSENT` and `SL_ADAPTER_EVENT_BUS`
 * were declared, validated, typed — and consulted by no code at all. Setting either to
 * `remote` produced a process that started happily on the mock, which is the exact shape
 * of "configured, therefore it must be doing it" that §35.3 is written against.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

/** The minimum a process needs before any of the interesting rules are reached. */
const BASE = {
  SL_ENV: 'test',
  SL_DATABASE_URL: 'postgres://starlink:starlink@localhost:5432/starlink',
  SL_SESSION_SECRET: 'config-test-session-secret-0123456789',
  SL_CURSOR_SECRET: 'config-test-cursor-secret-01234567890',
} as const;

describe('adapter selection refuses what it cannot honour', () => {
  it('starts on the defaults', () => {
    const config = loadConfig({ ...BASE });
    expect(config.SL_ADAPTER_CONSENT).toBe('mock');
    expect(config.SL_ADAPTER_EVENT_BUS).toBe('mock');
  });

  it.each(['SL_ADAPTER_CONSENT', 'SL_ADAPTER_EVENT_BUS'] as const)(
    'refuses to start when %s names an adapter that does not exist',
    (name) => {
      for (const mode of ['local', 'remote']) {
        expect(
          () => loadConfig({ ...BASE, [name]: mode }),
          `${name}=${mode} must refuse, not silently fall back to the mock`,
        ).toThrow(new RegExp(`${name}=${mode}`));
      }
    },
  );

  it('names the reason rather than only the setting', () => {
    // An operator reading this should learn that the adapter is blocked, not merely that
    // their value was rejected — otherwise the next thing they try is a different value.
    expect(() => loadConfig({ ...BASE, SL_ADAPTER_EVENT_BUS: 'remote' })).toThrow(
      /does not exist|blocked on an external decision/,
    );
  });

  it('still refuses a session secret below the minimum length', () => {
    // A neighbouring rule, included so this file fails if the shared validator is ever
    // dropped from `loadConfig` — the adapter checks above would keep passing without it.
    expect(() => loadConfig({ ...BASE, SL_SESSION_SECRET: 'too-short' })).toThrow();
  });
});
