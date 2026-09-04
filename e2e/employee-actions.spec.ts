/**
 * The employee actions a conversation's owner actually performs (SL-039, SL-042, SL-043,
 * SL-016, SL-015).
 *
 * Every one of these endpoints was built, guarded and covered by API tests months before
 * anything could reach them. What had never been proven is the part in between: that an
 * agent sitting in front of the product can carry a real conversation through cover,
 * escalation, resolve, reopen and transfer, and that adding a colleague to an internal
 * thread asks BR-07's question before exposing history.
 *
 * ## Why one long chain rather than five tests
 *
 * §21.4 makes each action's precondition the previous action's effect - reopen only exists
 * on a RESOLVED conversation, resolve only on an active one, and transfer hands ownership
 * away so it has to come last. Five independent tests would each have to seed the state
 * the one before it produces, which is how a suite ends up proving its own fixtures rather
 * than the product.
 *
 * ## The colleague picker
 *
 * Transfer, escalate and cover all name a person. Until 2026-08-29 the form asked for a
 * raw `principalId`, so none of them was usable by anybody who did not know a UUID by
 * heart. These steps drive the directory search instead, which is the path an agent has.
 */
import { expect, test, type Page } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { TEAM_ID } from './support/env.js';
import { resetTeamWork } from './support/reset.js';

/** The reason each action asks for, verbatim from the composer - these ARE the labels. */
const REASON_LABEL: Record<string, string> = {
  Resolve: 'What was the outcome? The customer is told this.',
  Reopen: 'Why are you reopening it?',
  Transfer: 'Why is it moving?',
  Escalate: 'Why is it being escalated?',
  'Arrange cover': 'Why is cover needed?',
};

/** Chooses a colleague by name and confirms the action, with its mandatory reason. */
async function act(page: Page, action: string, reason: string, colleague?: string): Promise<void> {
  const actions = page.getByRole('region', { name: 'Conversation actions' });
  await actions.getByRole('button', { name: action, exact: true }).click();

  if (colleague !== undefined) {
    await actions.getByPlaceholder('Search by name').fill(colleague);
    // Scoped to the panel: the sidebar's conversation search has a 'Search' button too.
    await actions.getByRole('button', { name: 'Search' }).click();
    await actions
      .getByRole('list', { name: 'Directory matches' })
      .getByRole('button', { name: new RegExp(colleague) })
      .click();
    // The name is echoed back before anything irreversible happens - the whole point of
    // the picker is that an agent confirms a person, not an identifier.
    await expect(page.getByText(`Colleague: ${colleague}`)).toBeVisible();
  }

  // BR-15 / §21.4: the reason is part of the act, so Confirm stays disabled without it.
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await page.getByLabel(REASON_LABEL[action]!).fill(reason);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

/**
 * The queue is shared, and claiming takes the OLDEST waiting entry (§23.4).
 *
 * Per test rather than per file: every test here creates the conversation it then claims,
 * so a leftover from the previous test is the one that gets taken - which is how a test
 * ends up asserting against a thread it never wrote to. Cheap, and it removes the whole
 * class of ordering bug rather than the instance that happened to surface.
 */
test.beforeEach(async () => {
  await resetTeamWork();
});

test('an owner covers, escalates, resolves, reopens and transfers one conversation', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, 'My renewal quote looks wrong.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);
    const conversationUrl = employee.url();

    await test.step('the first reply moves it to ACTIVE so the lifecycle opens up', async () => {
      await employee.getByLabel('Reply to customer body').fill('Looking at your renewal now.');
      await employee.getByRole('button', { name: 'Send to customer' }).click();
      await expect(
        employee.getByRole('listitem').filter({ hasText: 'Looking at your renewal now.' }).filter({ hasNotText: 'Sending' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        employee.getByRole('region', { name: 'Conversation actions' }).getByRole('button', { name: 'Resolve' }),
      ).toBeVisible({ timeout: 20_000 });
    });

    await test.step('cover is granted WITHOUT moving ownership (SL-039, §21.9)', async () => {
      await act(employee, 'Arrange cover', 'On leave this afternoon.', 'E2E Lead');
      // The distinction the row exists for: the team can act, the owner is unchanged.
      await expect(employee.getByText('Cover granted. You still own this conversation.')).toBeVisible({
        timeout: 20_000,
      });
    });

    await test.step('resolve records an outcome (SL-016, BR-19)', async () => {
      await act(employee, 'Resolve', 'Corrected the renewal quote.');
      await expect(employee.getByText('Resolved.')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('reopen returns it to the owner (SL-016)', async () => {
      await expect(
        employee.getByRole('region', { name: 'Conversation actions' }).getByRole('button', { name: 'Reopen' }),
      ).toBeVisible({ timeout: 20_000 });
      await act(employee, 'Reopen', 'Customer replied with a further question.');
      await expect(employee.getByText('Reopened.')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('transfer hands ownership over, with a reason (SL-042, BR-15)', async () => {
      await act(employee, 'Transfer', 'Handing to the renewals lead.', 'E2E Lead');
      await expect(employee.getByText('Transferred.')).toBeVisible({ timeout: 20_000 });
    });

    /**
     * Escalation comes last, and is performed by the NEW owner.
     *
     * §21.7's escalate reassigns as well as raising the level (`assignmentSource:
     * 'ESCALATION'`), so whoever escalates stops being the owner immediately afterwards.
     * An earlier draft of this test escalated in the middle of the chain and then tried to
     * resolve as the original agent; the API refused, correctly, and the refusal was the
     * product telling the test it had misunderstood the model.
     *
     * SL-043's acceptance is "escalation orthogonal to state" - so the level moves and the
     * ownership moves, but the conversation is still ACTIVE and still resolvable, which is
     * what the last assertion checks.
     */
    await test.step('the new owner escalates: a level and a handover, not a state (SL-043)', async () => {
      const leadContext = await browser.newContext();
      const lead = await leadContext.newPage();
      try {
        await signIn(lead, 'lead');
        await lead.goto(conversationUrl);
        await act(lead, 'Escalate', 'Pricing dispute needs a specialist.', 'E2E Colleague');
        await expect(lead.getByText(/Escalated to level \d/)).toBeVisible({ timeout: 20_000 });
        await expect(
          lead.getByRole('region', { name: 'Conversation actions' }).getByRole('button', { name: 'Resolve' }),
        ).toBeVisible();
      } finally {
        await leadContext.close();
      }
    });

  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});

test('adding a colleague to an internal thread asks BR-07 before exposing history', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const employee = await context.newPage();

  try {
    await signIn(employee, 'agent');

    await test.step('start an internal conversation with one colleague (SL-001)', async () => {
      /*
         The dialog asks "one colleague or several?" before it asks "who?".

         It used to ask only the second and infer the first from how many people you
         happened to pick, which meant a required group-name field appeared underneath a
         form somebody thought they had finished. Choosing New chat up front is one click
         and makes the rest of the dialog honest.

         There is no Find button and no Start button in this path any more. Results appear
         as you type, and picking the person IS starting the chat — there is nothing else
         to decide, so a confirm press would be the product asking a question it already
         has the answer to.
      */
      await employee.getByRole('button', { name: 'New conversation' }).click();
      const panel = employee.getByRole('region', { name: 'Start a conversation' });
      await panel.getByRole('button', { name: /New chat/ }).click();
      await panel.getByPlaceholder(/name, department/i).fill('E2E Lead');
      await panel.getByRole('button', { name: /E2E Lead/ }).first().click();
      await expect(employee).toHaveURL(/\/conversations\/[0-9a-f-]{36}/, { timeout: 20_000 });
    });

    await test.step('an internal thread has no lifecycle at all (D-15, BR-23)', async () => {
      // §21.4 applies to service cases. An internal thread "exists and stays open
      // indefinitely", so the action panel must not be rendered - disabled buttons would
      // imply the actions exist and are merely unavailable.
      await expect(employee.getByRole('region', { name: 'Conversation actions' })).toHaveCount(0);

      /**
       * Membership is NOT shown on a one-to-one, and is one click away.
       *
       * It used to be permanent here. On a direct message the panel is about the person
       * you are talking to, and a permanent search field under their face was asked to go
       * — but deleting the control took the CAPABILITY with it, and BR-07 below is
       * precisely about the act it removed: adding a third person to an EXISTING thread,
       * where there is history for them to suddenly be able to read. Starting a new group
       * is a different act with nothing to expose.
       *
       * So this asserts both halves of the compromise: absent by default, present when
       * asked for from the header's overflow.
       */
      const membership = employee.getByRole('region', { name: 'Participants' });
      await expect(
        membership,
        'a one-to-one should not carry a permanent membership section',
      ).toHaveCount(0);

      await employee.getByRole('button', { name: 'More actions' }).click();
      await employee.getByRole('menuitem', { name: 'Add people' }).click();
      await expect(membership).toBeVisible();
    });

    await test.step('adding a third person warns that history is exposed (BR-07)', async () => {
      const participants = employee.getByRole('region', { name: 'Participants' });
      // Searched as you type here too; the Find button is gone from both fields.
      await participants.getByPlaceholder(/name, department/i).fill('E2E Colleague');
      await participants.getByRole('button', { name: /E2E Colleague/ }).first().click();

      // The acknowledgement is asked in words, in a dialog the person has to read. The
      // server refuses without the flag; this proves a human was actually shown it.
      const warning = employee.getByRole('dialog', { name: 'Confirm adding a colleague' });
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Add them anyway' }).click();

      /**
       * The server's own confirmation, which says what actually happened rather than just
       * "added". BR-07 is about history exposure, so the sentence names how much history
       * was shared - and on a thread with no messages yet, that it was none.
       */
      await expect(participants.getByRole('status')).toContainText('E2E Colleague was added', {
        timeout: 20_000,
      });
    });

    await test.step('an internal thread is a normal chat, with no customer vocabulary', async () => {
      /**
       * Stage 1 is employee-to-employee, and its composer is an ordinary chat composer.
       *
       * This step previously asserted the OPPOSITE — that the visibility radiogroup was
       * present with "Internal note" selected. That encoded an assumption from when the
       * customer workspace was the only surface: every composer was a support composer, so
       * a colleague thread inherited "🔒 Internal note — the customer cannot see this",
       * a dashed amber input and a "Save internal note" button. There is no customer on
       * this thread; the warning described a reader who does not exist.
       *
       * Superseded by an explicit product decision (2026-08-31). The requirement is not
       * weakened — it is stronger, because it now checks the ABSENCE of five specific
       * things rather than the presence of one, and BR-23's original point (no
       * CUSTOMER_VISIBLE mode on an internal thread) is still asserted first.
       *
       * ADR-021 is untouched: every one of its four signals still fires on a note inside a
       * customer conversation, which `conversation-journey.spec.ts` covers.
       */
      await expect(
        employee.getByRole('radio', { name: 'Reply to customer' }),
        'an internal thread must never offer a customer-visible mode (BR-23, D-15)',
      ).toHaveCount(0);

      // No visibility switch at all: one audience is not a choice.
      await expect(
        employee.getByRole('radiogroup', { name: 'Message visibility' }),
        'a visibility switch on a thread with one audience is a control that cannot be used',
      ).toHaveCount(0);
      await expect(employee.getByRole('radio', { name: 'Internal note' })).toHaveCount(0);

      // None of the customer-support vocabulary reaches an employee chat.
      for (const phrase of [
        'the customer cannot see this',
        'Visible to the customer',
        'Note for colleagues only',
      ]) {
        await expect(
          employee.getByText(phrase),
          `"${phrase}" is customer-support wording and there is no customer here`,
        ).toHaveCount(0);
      }
      await expect(employee.getByRole('button', { name: 'Save internal note' })).toHaveCount(0);

      // And what an employee chat SHOULD have.
      await expect(employee.getByLabel('Message', { exact: true })).toBeVisible();
      /*
         The composer names the room it writes into — "Message # E2E Colleague, E2E Lead",
         which is screens 02 and 03's own placeholder.

         It read "Type a message…" until the placeholder was addressed. The assertion is on
         the shape AND the conversation's name rather than on a fixed string, because what
         it is here to prove is unchanged: an internal thread's composer says nothing about
         a customer. "Reply to the customer…" and "Note for colleagues only…" both fail it.
      */
      await expect(employee.getByLabel('Message', { exact: true })).toHaveAttribute(
        'placeholder',
        /^Message #? ?E2E /,
      );
      await expect(employee.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      // Attachments stay available on an internal thread (SL-054).
      await expect(employee.getByLabel('Attach a file')).toBeVisible();
    });

    await test.step('and a message sent on that thread persists', async () => {
      /**
       * The composer is not merely cosmetically correct — it still sends. Worth asserting
       * here because this step rewrote the send button's name, and a renamed control that
       * no longer submits would pass every assertion above.
       */
      const text = 'Sharing the renewal figures with you both.';
      await employee.getByLabel('Message', { exact: true }).fill(text);
      await employee.getByRole('button', { name: 'Send', exact: true }).click();

      /**
       * Excludes the optimistic row, the same way `drafts-and-offline.spec.ts` does and
       * for the same reason: the composer renders a pending copy the instant Send is
       * pressed and removes it when the server confirms, so for one render BOTH carry the
       * text and a locator on the text alone trips strict mode.
       *
       * It surfaced here on 2026-08-31 rather than earlier because the suite got faster —
       * a fixture that had been inserting a duplicate role grant per run was fixed, which
       * took a third off the wall clock and moved this assertion into the overlap window.
       * The race was always there; the speed only changed which side of it we landed on.
       *
       * Filtering is what makes the assertion mean what the step says. "Persists" is a
       * claim about the DELIVERED message, and the optimistic copy is precisely the thing
       * that would satisfy it without the message having persisted at all.
       */
      await expect(
        employee
          .getByRole('list', { name: 'Messages' })
          .getByRole('listitem')
          .filter({ hasText: text })
          .filter({ hasNotText: 'Sending' }),
        'the internal message did not appear in the thread',
      ).toBeVisible({ timeout: 20_000 });

      await employee.reload();
      await expect(
        employee.getByRole('list', { name: 'Messages' }).getByText(text),
        'the internal message did not survive a reload — it was never persisted',
      ).toBeVisible({ timeout: 20_000 });
    });
  } finally {
    await context.close();
  }
});

/**
 * SL-083 / O-07 — "Leadership can see load and waiting customers".
 *
 * Asserted against a conversation this test creates, so the numbers are known rather than
 * whatever the database happened to contain: one customer waits, the agent takes it, and
 * the panel has to move from "one waiting, nobody carrying anything" to "none waiting, one
 * carried". A panel that rendered but never changed would pass a screenshot test and fail
 * the only thing O-07 asks for.
 */
test('the team load panel shows waiting work and who is carrying it (SL-083)', async ({ browser }) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, 'Can you check my no-claim bonus?');
    await signIn(employee, 'agent');

    const panel = employee.getByRole('region', { name: `Load for ${TEAM_ID}` });

    await test.step('a waiting customer is visible as load, not just as a queue row', async () => {
      await expect(panel).toBeVisible();
      // The routing sweep places it; until then the count is legitimately zero.
      await expect(panel.getByRole('definition').first()).toHaveText(/[1-9]\d*/, { timeout: 30_000 });
      // Every team member is listed, including those carrying nothing - that row is the
      // most useful one on the screen when a lead is looking for somewhere to put work.
      await expect(panel.getByRole('cell', { name: 'E2E Agent' })).toBeVisible();
      await expect(panel.getByRole('cell', { name: 'E2E Lead' })).toBeVisible();
    });

    await test.step('claiming moves it out of waiting and into somebody\u2019s column', async () => {
      await claimFromQueue(employee);
      const agentRow = panel.getByRole('row').filter({ hasText: 'E2E Agent' });
      await expect(agentRow).toContainText('1', { timeout: 30_000 });
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
