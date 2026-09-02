/**
 * Stage 1 is employee-to-employee, and the employee app must not present a customer
 * workspace it is not yet running.
 *
 * ## What this guards, and why a test rather than a comment
 *
 * The rollout was sequenced on 2026-08-31: Stage 1 internal, Stage 2 customer. That is a
 * release decision — the customer implementation is untouched and stays wired. What
 * changes is what the employee application *renders*.
 *
 * The failure mode this exists to prevent is subtle. Somebody hides the customer panels
 * with CSS, or with a `display: none`, and the components still mount — still polling
 * `/queues/:teamId` and `/queues/:teamId/load` on a timer against a stage where no
 * customer conversation exists. The surface looks scoped and the dependency is still
 * there, which is precisely what "Stage 1 does not depend on customer flows" is supposed
 * to rule out.
 *
 * So this checks two things a stylesheet cannot fake: the flag defaults to OFF, and the
 * layout gates the panels on it rather than styling them away.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNTIME_ORIGINS_KEY, customerWorkspaceEnabled } from './runtime-origins';

const here = dirname(fileURLToPath(import.meta.url));
const layout = readFileSync(join(here, '..', 'app', 'conversations', 'layout.tsx'), 'utf8');
const thread = readFileSync(
  join(here, '..', 'app', 'conversations', '[id]', 'page.tsx'),
  'utf8',
);

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY];
});

describe('Stage 1 customer-workspace scope', () => {
  it('is OFF when nothing is injected', () => {
    // The default is the stage we are actually in. A missing config must not open Stage 2.
    expect(customerWorkspaceEnabled()).toBe(false);
  });

  it('is OFF for every value except the exact string true', () => {
    /**
     * `Boolean('false')` is `true`. A flag that switches itself on when an operator writes
     * the word "false" is worse than having no flag, so the script compares the string and
     * this pins that it keeps doing so.
     */
    for (const value of [false, 'false', 'FALSE', '0', '', 'yes', 1, null, undefined]) {
      (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY] = {
        customerWorkspace: value,
      };
      expect(customerWorkspaceEnabled(), `${String(value)} must not enable Stage 2`).toBe(false);
    }
  });

  it('is ON only for boolean true — Stage 2 must still be reachable', () => {
    /**
     * The positive control. Without it every case above is satisfied by a function that
     * returns false unconditionally, which would make Stage 2 a code change rather than
     * the configuration flip it is meant to be.
     */
    (globalThis as Record<string, unknown>)[RUNTIME_ORIGINS_KEY] = { customerWorkspace: true };
    expect(customerWorkspaceEnabled()).toBe(true);
  });

  it('gates the customer panels on the flag, not on styling', () => {
    /**
     * Both panels must sit behind `showCustomerWorkspace` so they do not mount in Stage 1.
     * A CSS rule would leave them polling; this asserts the structural gate exists.
     */
    expect(layout).toContain('showCustomerWorkspace');
    for (const panel of ['TeamQueue', 'TeamLoadPanel']) {
      const gated = new RegExp(String.raw`showCustomerWorkspace[\s\S]{0,400}<${panel}`);
      expect(
        gated.test(layout),
        `${panel} is rendered without the Stage 1 gate — it will mount and poll a customer ` +
          'endpoint in an internal-only stage',
      ).toBe(true);
    }
  });

  it('gates the customer lifecycle toolbar on the flag, not only on the conversation', () => {
    /**
     * Resolve, transfer, escalate, arrange-cover and SLA are customer-workspace controls.
     * `ConversationActions` already returns null for a stateless conversation on its own,
     * so the lifecycle test alone was never the Stage 1 gate — the flag is.
     */
    expect(
      /lifecycleState !== undefined && showCustomerWorkspace/.test(thread),
      'the lifecycle toolbar is not gated on the Stage 1 flag',
    ).toBe(true);
  });

  it('shows only internal conversations in the Stage 1 inbox', () => {
    expect(
      /showCustomerWorkspace[\s\S]{0,200}startsWith\('INTERNAL'\)/.test(layout),
      'the inbox is not scoped to internal conversations in Stage 1',
    ).toBe(true);
  });

  it('does not hide the customer panels with CSS instead of unmounting them', () => {
    /**
     * The specific wrong fix, named. If someone replaces the gate with a style, the
     * assertion above may still pass while the component mounts and fetches.
     */
    expect(
      /display:\s*['"]?none/.test(layout),
      'the layout hides something with display:none — Stage 1 scoping must unmount, not hide',
    ).toBe(false);
  });
});
