/**
 * The conversation lifecycle (§21.4) and the reopen boundary (BR-21/BR-22).
 *
 * The tests that matter most here are the negative ones. §21.4 exists because v2.0 got
 * this wrong in a specific way — it listed `reassigned` and `escalated` as states — and
 * the correction only holds if something refuses to let them back in.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationState, Timestamp } from '@starlink/shared-contracts';

import {
  isLifecycleBearing,
  isTerminal,
  transition,
  OPEN_STATES,
  TRANSITIONS,
  type LifecycleActor,
} from './lifecycle.js';
import { decideReopen, reopenWindowExpiresAt } from './reopen.js';

const move = (
  from: ConversationState,
  to: ConversationState,
  actor: LifecycleActor,
  extra: { reason?: string; staffInitiated?: boolean } = {},
) => transition({ from, to, actor, ...extra });

describe('the lifecycle only permits what §21.4 lists', () => {
  it('walks the ordinary path: queued → assigned → active → resolved', () => {
    expect(move('NEW', 'QUEUED', 'SYSTEM').ok).toBe(true);
    expect(move('QUEUED', 'ASSIGNED', 'OWNER').ok).toBe(true);
    expect(move('ASSIGNED', 'ACTIVE', 'OWNER').ok).toBe(true);
    expect(move('ACTIVE', 'RESOLVED', 'OWNER', { reason: 'refund processed' }).ok).toBe(true);
  });

  it('refuses a state pair the table does not contain', () => {
    // NEW straight to RESOLVED skips every step that creates an owner and a reply.
    const result = move('NEW', 'RESOLVED', 'OWNER', { reason: 'looks fine' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('NOT_A_TRANSITION');
  });

  it('has no state for transfer, escalation or reassignment', () => {
    /**
     * The correction §21.4 makes to v2.0, enforced. Those are EVENTS — they live in
     * `packages/routing` with a mandatory reason and a must-succeed audit — and the
     * document's reason for keeping them out is operational rather than tidy:
     *
     *   "If `transferred` were a state, every query for open work would have to remember
     *    to include it, and the first one that forgot would hide a customer."
     */
     const invented = ['TRANSFERRED', 'ESCALATED', 'REASSIGNED', 'COVERED', 'BREACHED'];
    for (const state of invented) {
      expect(
        TRANSITIONS.some((r) => r.from === state || r.to === state),
        `${state} must not be a state — §21.4 makes it an event or an orthogonal axis`,
      ).toBe(false);
    }
  });

  it('refuses a permitted transition attempted by the wrong actor', () => {
    // "resolved → closed | System, on reopen-window expiry". An owner closing by hand
    // would be shortening a window the business bounded.
    const byOwner = move('RESOLVED', 'CLOSED', 'OWNER');
    expect(byOwner.ok).toBe(false);
    expect(!byOwner.ok && byOwner.refusal).toBe('ACTOR_NOT_PERMITTED');
    expect(move('RESOLVED', 'CLOSED', 'SYSTEM').ok).toBe(true);
  });

  it('never lets a customer resolve their own conversation', () => {
    // "active → resolved | Owner or lead". A customer saying "that's fine" is a message,
    // not an outcome — and BR-19 requires an outcome be recorded by staff.
    const result = move('ACTIVE', 'RESOLVED', 'CUSTOMER', { reason: 'thanks' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('ACTOR_NOT_PERMITTED');
  });

  it('requires an outcome to resolve, and does not accept whitespace as one', () => {
    expect(!move('ACTIVE', 'RESOLVED', 'OWNER').ok).toBe(true);
    const blank = move('ACTIVE', 'RESOLVED', 'OWNER', { reason: '   ' });
    expect(blank.ok).toBe(false);
    expect(!blank.ok && blank.refusal).toBe('REASON_REQUIRED');
  });

  it('requires a reason to reopen only when STAFF did it', () => {
    // "resolved → active | Owner or customer (reopen in window) | Yes, if staff-initiated"
    // A customer replying is its own reason; demanding one from them would be absurd.
    expect(move('RESOLVED', 'ACTIVE', 'CUSTOMER').ok).toBe(true);

    const staffWithout = move('RESOLVED', 'ACTIVE', 'OWNER', { staffInitiated: true });
    expect(staffWithout.ok).toBe(false);
    expect(!staffWithout.ok && staffWithout.refusal).toBe('REASON_REQUIRED');

    expect(
      move('RESOLVED', 'ACTIVE', 'OWNER', { staffInitiated: true, reason: 'customer called' }).ok,
    ).toBe(true);
  });

  it('treats CLOSED as terminal, naming the reason', () => {
    // A reply after the window is a NEW conversation on the same case (BR-22), never a
    // revival — reviving would silently extend a window the business bounded.
    const result = move('CLOSED', 'ACTIVE', 'CUSTOMER');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('CONVERSATION_IS_CLOSED');
    expect(isTerminal('CLOSED')).toBe(true);
  });

  it('reports a no-op move rather than quietly succeeding', () => {
    const result = move('ACTIVE', 'ACTIVE', 'OWNER');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('ALREADY_IN_STATE');
  });

  it('distinguishes waiting on the customer from waiting on a colleague', () => {
    // Two states, not one, because they mean opposite things about whose turn it is.
    expect(move('ACTIVE', 'WAITING_CUSTOMER', 'OWNER').ok).toBe(true);
    expect(move('ACTIVE', 'WAITING_INTERNAL', 'OWNER').ok).toBe(true);
    // Only the customer can end their own turn.
    expect(move('WAITING_CUSTOMER', 'ACTIVE', 'CUSTOMER').ok).toBe(true);
    expect(move('WAITING_CUSTOMER', 'ACTIVE', 'OWNER').ok).toBe(false);
  });

  it('lets an owner resolve a conversation the customer abandoned', () => {
    // Diagram 9 draws waiting → resolved. Without it, a customer who stops replying
    // leaves work open forever and the queue fills with the unanswerable.
    expect(move('WAITING_CUSTOMER', 'RESOLVED', 'OWNER', { reason: 'no reply after chase' }).ok).toBe(true);
  });
});

describe('OPEN_STATES is derived, not enumerated', () => {
  it('counts every state work can still leave', () => {
    // Derived from the table so a state added later joins "open work" automatically —
    // §21.4's warning is that the first query to forget one hides a customer.
    for (const state of ['NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'] as const) {
      expect(OPEN_STATES).toContain(state);
    }
    expect(OPEN_STATES).not.toContain('CLOSED');
    expect(OPEN_STATES).not.toContain('RESOLVED');
  });
});

describe('internal conversations have no lifecycle at all', () => {
  it('is true only of customer-service conversations', () => {
    // §21.4 and D-15: internal chat has no states, no resolve/close, no SLA, no case.
    // "Imposed lifecycle on internal chat produces 'closed' threads people keep talking
    // in, and a status nobody maintains."
    expect(isLifecycleBearing('CUSTOMER_SERVICE')).toBe(true);
    expect(isLifecycleBearing('DIRECT')).toBe(false);
    expect(isLifecycleBearing('GROUP')).toBe(false);
  });
});

describe('the reopen boundary — BR-21 and BR-22', () => {
  const RESOLVED_AT = '2026-08-27T10:00:00.000Z' as Timestamp;
  const OWNER = '018f2c5a-c1c1-7000-8000-00000000000a' as never;
  const CASE = '018f2c5a-c1c1-7000-8000-00000000000b' as never;
  const CONVERSATION = '018f2c5a-c1c1-7000-8000-00000000000c' as never;
  const SEVEN_DAYS = { windowSeconds: 7 * 24 * 3600 };

  const resolved = { conversationId: CONVERSATION, caseId: CASE, resolvedAt: RESOLVED_AT, ownerId: OWNER };

  it('reopens the same thread to the same owner inside the window (BR-21)', () => {
    const decision = decideReopen(resolved, SEVEN_DAYS, '2026-08-30T09:00:00.000Z' as Timestamp);

    expect(decision.outcome).toBe('REOPEN_SAME_THREAD');
    // The OWNER, not just the thread. A customer continuing a conversation is continuing
    // it with a person who already has the context.
    expect(decision.outcome === 'REOPEN_SAME_THREAD' && decision.intendedOwnerId).toBe(OWNER);
  });

  it('creates a new conversation on the same case after the window (BR-22)', () => {
    const decision = decideReopen(resolved, SEVEN_DAYS, '2026-09-10T09:00:00.000Z' as Timestamp);

    expect(decision.outcome).toBe('NEW_CONVERSATION_SAME_CASE');
    // Same case — §22.4. The customer experiences one continuous relationship; the split
    // exists so two pieces of work can be measured separately.
    expect(decision.outcome === 'NEW_CONVERSATION_SAME_CASE' && decision.caseId).toBe(CASE);
  });

  it('treats the expiry instant as OUTSIDE the window', () => {
    // Half-open, like every other effective period here. A reply at exactly the expiry
    // must not make the window one millisecond longer than configured.
    const expiry = reopenWindowExpiresAt(RESOLVED_AT, SEVEN_DAYS);
    expect(expiry).toBe('2026-09-03T10:00:00.000Z');

    expect(decideReopen(resolved, SEVEN_DAYS, expiry).outcome).toBe('NEW_CONVERSATION_SAME_CASE');
    const oneMsBefore = new Date(Date.parse(expiry) - 1).toISOString() as Timestamp;
    expect(decideReopen(resolved, SEVEN_DAYS, oneMsBefore).outcome).toBe('REOPEN_SAME_THREAD');
  });

  it('does not split a conversation because two clocks disagreed', () => {
    /**
     * A reply stamped before the resolution is clock skew, not time travel — ADR-025,
     * and this machine's clock has run a minute behind the database. The forgiving
     * reading is right when the alternative is starting a new conversation because two
     * servers disagreed by a second.
     */
    const beforeResolution = '2026-08-27T09:59:30.000Z' as Timestamp;
    expect(decideReopen(resolved, SEVEN_DAYS, beforeResolution).outcome).toBe('REOPEN_SAME_THREAD');
  });

  it('says STILL_OPEN when the conversation was never resolved', () => {
    const open = { conversationId: CONVERSATION, caseId: CASE };
    expect(decideReopen(open, SEVEN_DAYS, '2026-08-30T09:00:00.000Z' as Timestamp).outcome).toBe(
      'STILL_OPEN',
    );
  });

  it('reports no intended owner rather than inventing one', () => {
    // An unowned resolved conversation routes normally on reopen. Guessing an owner here
    // would be assignment by accident.
    const ownerless = { conversationId: CONVERSATION, resolvedAt: RESOLVED_AT };
    const decision = decideReopen(ownerless, SEVEN_DAYS, '2026-08-28T09:00:00.000Z' as Timestamp);
    expect(decision.outcome === 'REOPEN_SAME_THREAD' && decision.intendedOwnerId).toBeUndefined();
  });

  it('takes the window from configuration and has no opinion about its length', () => {
    // D-08: "7 days is arbitrary until the business gives a service standard." A-08: the
    // length changes; the model does not. Same reply, two policies, opposite outcomes.
    const at = '2026-08-28T10:00:00.000Z' as Timestamp; // one day later
    expect(decideReopen(resolved, { windowSeconds: 2 * 24 * 3600 }, at).outcome).toBe(
      'REOPEN_SAME_THREAD',
    );
    expect(decideReopen(resolved, { windowSeconds: 3600 }, at).outcome).toBe(
      'NEW_CONVERSATION_SAME_CASE',
    );
  });
});
