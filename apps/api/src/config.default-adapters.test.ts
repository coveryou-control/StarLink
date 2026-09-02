/**
 * The default configuration must be a configuration something actually runs on.
 *
 * ## The defect this exists to prevent recurring
 *
 * `SL_ADAPTER_WORK_ORCHESTRATOR` defaulted to `mock`. `MockWorkOrchestrator.requestRouting`
 * enqueues into a private in-memory `Map` and returns `ok`; the queue every agent reads is
 * PostgreSQL. So on the shipped default, a customer's conversation was durable, was
 * acknowledged, was counted by the routing sweep as `acted` — and appeared in nobody's
 * queue, with no warning logged and `/readyz` reporting healthy throughout.
 *
 * It survived because every integration test and `playwright.config.ts` set the variable to
 * `local` explicitly. **The configuration that was tested and the configuration that
 * shipped were not the same configuration**, and there was no test whose job was to notice
 * that. The council found the same shape in five other places (object storage, the AI
 * adapter, the CI test command, the Prometheus rule file, `.env`), which is why this file
 * checks the rule and not just the one setting.
 *
 * Two properties are asserted:
 *   1. A default that reaches a user-facing durable path is not an in-memory stand-in.
 *   2. `.env.example` — the file the setup instructions tell people to copy — both LOADS
 *      and agrees with those defaults. A template that disagrees is a second configuration
 *      nobody runs, and copying it silently re-creates the bug.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const BASE = {
  SL_ENV: 'test',
  SL_DATABASE_URL: 'postgres://starlink:starlink@localhost:5432/starlink',
  SL_SESSION_SECRET: 'config-test-session-secret-0123456789',
  SL_CURSOR_SECRET: 'config-test-cursor-secret-01234567890',
} as const;

/** `KEY=value` pairs from the template, comments and blanks dropped. */
function template(): Record<string, string> {
  const source = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match !== null && match[1] !== undefined) values[match[1]] = (match[2] ?? '').trim();
  }
  return values;
}

describe('the shipped defaults are runnable defaults', () => {
  it('routes customer work to the durable allocator by default', () => {
    /**
     * The specific regression. `local` is the PostgreSQL-backed `LocalWorkOrchestrator`;
     * `mock` loses the work silently. Asserted by name rather than by "not mock" so that
     * the failure message tells the next person what the value has to be.
     */
    const config = loadConfig({ ...BASE });
    expect(
      config.SL_ADAPTER_WORK_ORCHESTRATOR,
      'A `mock` default means every customer conversation is enqueued into an in-memory ' +
        'Map while agents read PostgreSQL. The sweep reports success and the work is gone.',
    ).toBe('local');
  });

  it('has no adapter default that silently drops user-visible work', () => {
    /**
     * The general rule. An adapter is listed here when its mock ACCEPTS a write and then
     * loses it — the failure mode that cannot be seen from the outside. Adapters whose
     * mock is a read-only stand-in (consent, event bus, search) are deliberately absent:
     * their defaults are honest about being unwired, and `/readyz` reports them.
     */
    const config = loadConfig({ ...BASE });
    const durable = ['SL_ADAPTER_WORK_ORCHESTRATOR', 'SL_ADAPTER_OBJECT_STORAGE'] as const;

    const dropping = durable.filter((name) => config[name] === 'mock');
    expect(
      dropping,
      'these default to an in-memory stand-in that accepts a write and loses it:\n' +
        dropping.join('\n'),
    ).toEqual([]);
  });

  describe('a development storage driver in a deployed environment', () => {
    /**
     * A boot refusal with no test is a control nobody has evidenced — the exact shape three
     * councils have kept finding. This one guards a real trap: `local` selects
     * `LocalObjectStorage`, whose upload grants point at `/v1/dev/objects/...`, and
     * `DevUploadController` refuses those outside `dev`/`test`. Without the refusal the
     * process starts, issues grants, and every attachment upload fails silently.
     */
    it.each(['staging', 'production'] as const)('refuses to start on %s', (env) => {
      for (const driver of ['local', 'mock'] as const) {
        expect(
          () => loadConfig({ ...BASE, SL_ENV: env, SL_ADAPTER_OBJECT_STORAGE: driver }),
          `${env} + ${driver} must refuse: its upload URLs are served by endpoints that refuse outside dev/test`,
        ).toThrow(/development driver/);
      }
    });

    it.each(['dev', 'test'] as const)('still starts on %s', (env) => {
      // The control. Without it the refusal above would pass against a build that refused
      // every environment, which would stop the browser suite and every developer.
      expect(() =>
        loadConfig({ ...BASE, SL_ENV: env, SL_ADAPTER_OBJECT_STORAGE: 'local' }),
      ).not.toThrow();
    });

    it('names the setting, the reason, and what is missing', () => {
      // An operator reading this must learn what to do next, not merely that they were
      // rejected — otherwise the next thing they try is another value that also fails.
      let message = '';
      try {
        loadConfig({ ...BASE, SL_ENV: 'production', SL_ADAPTER_OBJECT_STORAGE: 'local' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('SL_ADAPTER_OBJECT_STORAGE');
      expect(message).toContain('N-03');
    });
  });

  describe('.env.example', () => {
    const values = template();

    it('parses as a template with settings in it', () => {
      // Guards the parser: a regex that stopped matching would make every case below pass.
      expect(Object.keys(values).length).toBeGreaterThan(20);
      expect(values['SL_ADAPTER_WORK_ORCHESTRATOR']).toBeDefined();
    });

    it('produces a process that starts', () => {
      /**
       * The instructions say "copy to .env for local development". Until 2026-08-30 doing
       * so produced a process that refused to boot, because `SL_ADAPTER_AI=mock` is not in
       * that setting's enum — the template had never been loaded by anything.
       */
      expect(() => loadConfig(values)).not.toThrow();
    });

    it('agrees with the code defaults on every adapter', () => {
      const defaults = loadConfig({ ...BASE }) as unknown as Record<string, unknown>;
      const disagreements = Object.keys(values)
        .filter((name) => name.startsWith('SL_ADAPTER_'))
        .filter((name) => defaults[name] !== undefined && values[name] !== defaults[name])
        .map((name) => `${name}: template says ${values[name]}, code default is ${String(defaults[name])}`);

      expect(
        disagreements,
        'The template is what people copy. Where it disagrees with the default, one of ' +
          'the two is a configuration nobody tests:\n' + disagreements.join('\n'),
      ).toEqual([]);
    });
  });
});
