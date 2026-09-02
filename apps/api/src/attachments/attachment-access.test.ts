/**
 * §28.4's authorization ladder, step by step.
 *
 * The test that matters most is the one where every earlier step PASSES and step 4 still
 * refuses: a customer, in their own conversation, reaching an attachment that hangs off
 * an internal note. §28.5's table gives that combination to customers as **"Never"**, and
 * it is the case a reviewer is most likely to think step 3 already covered.
 */
import { describe, expect, it } from 'vitest';
import type { UUID } from '@starlink/shared-contracts';

import { decideAttachmentAccess, type AccessPorts, type AttachmentForAccess } from './attachment-access.js';

const CONVERSATION = '018f2c5a-acc5-7000-8000-00000000000a' as UUID;
const MESSAGE = '018f2c5a-acc5-7000-8000-00000000000b' as UUID;
const ATTACHMENT = '018f2c5a-acc5-7000-8000-00000000000c' as UUID;
const CUSTOMER = '018f2c5a-acc5-7000-8000-00000000000d' as UUID;
const EMPLOYEE = '018f2c5a-acc5-7000-8000-00000000000e' as UUID;

const bound = (over: Partial<AttachmentForAccess> = {}): AttachmentForAccess => ({
  attachmentId: ATTACHMENT,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  state: 'BOUND',
  cleanKey: 'clean/abc',
  originalFilename: 'policy.pdf',
  ...over,
});

const ports = (over: Partial<AccessPorts> = {}): AccessPorts => ({
  mayReadConversation: async () => true,
  messageVisibility: async () => 'CUSTOMER_VISIBLE',
  ...over,
});

describe('the ladder in order', () => {
  it('lets an employee fetch a bound attachment in a conversation they may read', async () => {
    const decision = await decideAttachmentAccess(bound(), { principalId: EMPLOYEE, kind: 'EMPLOYEE' }, ports());
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.cleanKey).toBe('clean/abc');
  });

  it('[2] refuses when there is no metadata record', async () => {
    // §28.3: metadata is the authority. Bytes in storage with no row are litter.
    const decision = await decideAttachmentAccess(undefined, { principalId: EMPLOYEE, kind: 'EMPLOYEE' }, ports());
    expect(!decision.ok && decision.refusal).toBe('NOT_FOUND_OR_NOT_PERMITTED');
  });

  it('[3] refuses when the object check says no, with the SAME answer as not-found', async () => {
    // §27.3: a real refusal and a non-existent thing are indistinguishable on the wire,
    // or the difference becomes an enumeration oracle.
    const decision = await decideAttachmentAccess(
      bound(),
      { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
      ports({ mayReadConversation: async () => false }),
    );
    expect(!decision.ok && decision.refusal).toBe('NOT_FOUND_OR_NOT_PERMITTED');
  });

  it('[4] refuses a CUSTOMER an internal-note attachment in their OWN conversation', async () => {
    /**
     * Every earlier step passes: the record exists, and the customer may read this
     * conversation — it is theirs. Step 4 is the only thing standing between them and
     * staff material, which is exactly why §28.4 numbers it separately and why it is not
     * a special case of step 3.
     */
    const decision = await decideAttachmentAccess(
      bound(),
      { principalId: CUSTOMER, kind: 'CUSTOMER' },
      ports({ mayReadConversation: async () => true, messageVisibility: async () => 'INTERNAL' }),
    );
    expect(decision.ok).toBe(false);
    // Named distinctly, because a customer reaching for staff material is worth auditing
    // as that rather than as a generic miss.
    expect(!decision.ok && decision.refusal).toBe('INTERNAL_NOTE_ATTACHMENT');
  });

  it('[4] still permits an EMPLOYEE the same internal-note attachment', async () => {
    // §28.5: internal-note attachments are "visible to staff participants". The step-4
    // check is about the caller being a customer, not about the note being secret.
    const decision = await decideAttachmentAccess(
      bound(),
      { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
      ports({ messageVisibility: async () => 'INTERNAL' }),
    );
    expect(decision.ok).toBe(true);
  });

  it('refuses a customer an attachment whose message visibility is unknown', async () => {
    // Fail closed: an absent visibility is not permission. A message that cannot be read
    // is not a message that may be shown.
    const decision = await decideAttachmentAccess(
      bound(),
      { principalId: CUSTOMER, kind: 'CUSTOMER' },
      ports({ messageVisibility: async () => undefined }),
    );
    expect(!decision.ok && decision.refusal).toBe('INTERNAL_NOTE_ATTACHMENT');
  });
});

describe('nothing unbound is reachable, by anyone (§28.1)', () => {
  it('refuses every pre-bound state, even to the uploader', async () => {
    for (const state of ['UPLOAD_GRANTED', 'QUARANTINED', 'SCANNING', 'CLEAN'] as const) {
      const decision = await decideAttachmentAccess(
        bound({ state, messageId: undefined }),
        { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
        ports(),
      );
      expect(!decision.ok && decision.refusal, `${state} must be unreachable`).toBe('NOT_REACHABLE');
    }
  });

  it('refuses an infected or expired attachment', async () => {
    for (const state of ['INFECTED', 'REJECTED', 'EXPIRED'] as const) {
      const decision = await decideAttachmentAccess(
        bound({ state }),
        { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
        ports(),
      );
      expect(decision.ok, `${state} must be unreachable`).toBe(false);
    }
  });

  it('refuses a BOUND record with no clean key', async () => {
    // Belt and braces against a half-written row: bound but never promoted means the
    // bytes are still in quarantine, and quarantine is served to nobody.
    const decision = await decideAttachmentAccess(
      bound({ cleanKey: undefined }),
      { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
      ports(),
    );
    expect(!decision.ok && decision.refusal).toBe('NOT_REACHABLE');
  });

  it('refuses a customer an unbound attachment before asking about visibility', async () => {
    // An unbound attachment has no message whose visibility could permit it, so there is
    // nothing to consult — and consulting `messageVisibility(undefined)` would be a bug.
    let asked = false;
    const decision = await decideAttachmentAccess(
      bound({ messageId: undefined, state: 'CLEAN' }),
      { principalId: CUSTOMER, kind: 'CUSTOMER' },
      ports({
        messageVisibility: async () => {
          asked = true;
          return 'CUSTOMER_VISIBLE';
        },
      }),
    );
    expect(!decision.ok && decision.refusal).toBe('NOT_REACHABLE');
    expect(asked).toBe(false);
  });
});

describe('the filename is metadata, never a path (§28.3)', () => {
  it('falls back rather than returning an empty name', async () => {
    const decision = await decideAttachmentAccess(
      bound({ originalFilename: undefined }),
      { principalId: EMPLOYEE, kind: 'EMPLOYEE' },
      ports(),
    );
    expect(decision.ok && decision.filename).toBe('attachment');
  });
});
