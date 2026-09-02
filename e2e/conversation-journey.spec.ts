/**
 * One conversation, both surfaces, in a real browser.
 *
 * This is the test the repository did not have. Every previous claim about the employee
 * UI rested on a unit test of a hook or a controller — and that is exactly the shape of
 * evidence that let a socket protocol mismatch live for weeks with both halves green,
 * because no test ever connected them. Here a customer types into the customer app and an
 * employee reads it in a different browser context against the same running API.
 *
 * It covers, in order:
 *
 *   * **SL-004** — customer intake through the real widget, including the real OTP form.
 *   * **SL-006 / SL-037** — the queue is visible and "Take" claims the conversation.
 *   * **SL-013 / SL-024** — an internal note and a customer reply, told apart four ways.
 *   * **Invariant 5** — the customer never sees the internal note. This is the one
 *     assertion here that is a safety property rather than a feature: if it ever fails,
 *     the product has leaked internal deliberation to a customer.
 *   * **SL-016 / BR-19** — resolve with an outcome, and §22.5's "Outcome only" reaching
 *     the customer.
 *
 * One `test.step` chain, deliberately: each step's precondition is the previous step's
 * effect, and splitting them into independent tests would mean seeding the middle of the
 * journey — which is how a suite ends up proving its own fixtures.
 */
import { expect, test } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { TEAM_ID } from './support/env.js';
import { resetTeamWork } from './support/reset.js';

const FIRST_MESSAGE = 'My claim was rejected, can you check?';
const INTERNAL_NOTE = 'Internal: checking this with underwriting before we answer.';
const CUSTOMER_REPLY = 'Thanks for waiting — your policy covers this.';
const OUTCOME = 'Confirmed the policy covers the claim.';

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

test('a customer conversation is taken, discussed internally, answered and resolved', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await test.step('the customer starts a conversation through the widget', async () => {
      await startCustomerConversation(customer, FIRST_MESSAGE);
    });

    await test.step('the agent sees it waiting and takes it (SL-006, SL-037)', async () => {
      await signIn(employee, 'agent');
      // SL-006's acceptance criterion is "no invisible waiting; accurate counts".
      const queue = employee.getByRole('region', { name: `Queue for ${TEAM_ID}` });
      await expect(queue.getByText(/[1-9]\d* waiting/)).toBeVisible({ timeout: 30_000 });
      await claimFromQueue(employee);
    });

    await test.step('an internal note is unmistakably not a reply (SL-024)', async () => {
      const visibility = employee.getByRole('radiogroup', { name: 'Message visibility' });
      await visibility.getByRole('radio', { name: 'Internal note' }).click();

      // Four independent signals, none of them colour alone — colour is the one signal a
      // colour-blind agent or a monochrome screen does not get.
      await expect(employee.getByText('🔒 Internal note — the customer cannot see this')).toBeVisible();
      await expect(employee.getByRole('button', { name: 'Save internal note' })).toBeVisible();

      await employee.getByLabel('Internal note body').fill(INTERNAL_NOTE);
      await employee.getByRole('button', { name: 'Save internal note' }).click();

      /**
       * Excludes the optimistic bubble.
       *
       * The composer renders a pending copy the instant Send is pressed and reconciles it
       * away when the server confirms, so for a moment BOTH are on screen and a locator on
       * the body text alone matches two elements. Playwright's strict mode then fails - and
       * only sometimes, depending on which side of the reconcile the assertion lands on.
       * Filtering out the pending marker pins this to the delivered message.
       */
      const note = employee
        .getByRole('listitem')
        .filter({ hasText: INTERNAL_NOTE })
        .filter({ hasNotText: 'Sending' });
      await expect(note).toBeVisible({ timeout: 20_000 });
      await expect(note.getByText('INTERNAL — NOT VISIBLE TO CUSTOMER')).toBeVisible();
    });

    await test.step('the customer reply is a different act with a different name', async () => {
      const visibility = employee.getByRole('radiogroup', { name: 'Message visibility' });
      await visibility.getByRole('radio', { name: 'Reply to customer' }).click();

      await expect(employee.getByText('↗ Visible to the customer')).toBeVisible();
      await employee.getByLabel('Reply to customer body').fill(CUSTOMER_REPLY);
      await employee.getByRole('button', { name: 'Send to customer' }).click();

      await expect(
        employee.getByRole('listitem').filter({ hasText: CUSTOMER_REPLY }).filter({ hasNotText: 'Sending' }),
      ).toBeVisible({ timeout: 20_000 });
    });

    await test.step('the customer sees the reply and NEVER the note (invariant 5)', async () => {
      await expect(customer.getByText(CUSTOMER_REPLY)).toBeVisible({ timeout: 30_000 });

      // Asserted on the whole rendered page, not on a filtered list, so a leak through any
      // element — a bubble, a preview, a title attribute — fails it.
      await expect(customer.getByText(INTERNAL_NOTE)).toHaveCount(0);
      await expect(customer.locator('body')).not.toContainText('underwriting');
    });

    await test.step('resolving records an outcome and the customer is told it (BR-20, §22.5)', async () => {
      const actions = employee.getByRole('region', { name: 'Conversation actions' });
      await actions.getByRole('button', { name: 'Resolve' }).click();

      // §21.4 "Reason required: Yes — the outcome". The button stays disabled without it.
      await expect(employee.getByRole('button', { name: 'Confirm' })).toBeDisabled();
      await employee.getByLabel(/What was the outcome/).fill(OUTCOME);
      await employee.getByRole('button', { name: 'Confirm' }).click();

      await expect(employee.getByText('Resolved.')).toBeVisible({ timeout: 20_000 });

      // §22.5 gives the customer the outcome and withholds when it happened.
      await expect(customer.getByText(OUTCOME)).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
