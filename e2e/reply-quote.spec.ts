/**
 * Reply / quote reply (SL-008, UC-E16 — "Reply to a specific message · Quote in long threads").
 *
 * The write path accepted `replyToMessageId` from the day messaging was built, and scoped
 * it server-side so a reply cannot point at another conversation. Two things were missing,
 * and both had to be true before anyone could use it: the read projection never returned
 * the reference, so a stored reply rendered as an ordinary message, and no surface offered
 * a way to make one.
 *
 * SL-008's acceptance is that **the reply reference remains valid**. What can be proven
 * today is that it survives the round trip — written, read back, and resolved to the right
 * parent after a full reload. Edits and archive (SL-025, retention) do not exist yet, so
 * the "after edits/archive" half of that criterion is not yet exercisable and is not
 * claimed here.
 */
import { expect, test } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

const FIRST = 'My policy number is wrong on the renewal notice.';
const NOTE = 'Internal: underwriting confirmed the number was mistyped at import.';
const REPLY = 'You are right — we have corrected the policy number.';

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

test('an employee replies to a specific message and the quote survives a reload', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, FIRST);
    await signIn(employee, 'agent');
    await claimFromQueue(employee);
    const conversationUrl = employee.url();

    await test.step('replying quotes the message it answers', async () => {
      const target = employee.getByRole('listitem').filter({ hasText: FIRST });
      await target.getByRole('button', { name: /^Reply to/ }).click();

      // What is being answered is shown while composing - a reply aimed at the wrong
      // message is invisible once sent.
      await expect(employee.getByText(/Replying to/)).toBeVisible();

      await employee.getByLabel('Reply to customer body').fill(REPLY);
      await employee.getByRole('button', { name: 'Send to customer' }).click();

      const sent = employee
        .getByRole('listitem')
        .filter({ hasText: REPLY })
        .filter({ hasNotText: 'Sending' });
      await expect(sent).toBeVisible({ timeout: 20_000 });
      // The quote renders inside the reply, naming who was answered.
      await expect(sent.locator('blockquote')).toContainText(FIRST);
    });

    await test.step('the reference survives a full reload (SL-008)', async () => {
      // Reloading proves the reference came back from the SERVER, not from state this tab
      // happened to hold - the projection returning it is the half that was missing.
      await employee.goto(conversationUrl);
      const sent = employee.getByRole('listitem').filter({ hasText: REPLY });
      await expect(sent.locator('blockquote')).toContainText(FIRST, { timeout: 20_000 });
    });

    await test.step('a customer-visible reply may not quote an internal note (invariant 5)', async () => {
      await employee.getByRole('radiogroup', { name: 'Message visibility' })
        .getByRole('radio', { name: 'Internal note' })
        .click();
      await employee.getByLabel('Internal note body').fill(NOTE);
      await employee.getByRole('button', { name: 'Save internal note' }).click();

      const note = employee
        .getByRole('listitem')
        .filter({ hasText: NOTE })
        .filter({ hasNotText: 'Sending' });
      await expect(note).toBeVisible({ timeout: 20_000 });

      // Reply to the NOTE, then switch the composer to customer-visible. Quoting staff-only
      // text into a customer message would launder it past every layer that inspects the
      // message rather than what it points at - so the send is refused before it happens.
      await note.getByRole('button', { name: /^Reply to/ }).click();
      await employee.getByRole('radiogroup', { name: 'Message visibility' })
        .getByRole('radio', { name: 'Reply to customer' })
        .click();
      await employee.getByLabel('Reply to customer body').fill('This is what underwriting said.');

      // Pinned to the composer's own warning: Next renders a route announcer with
      // role=alert, so an unqualified alert locator matches two elements.
      await expect(
        employee.getByRole('alert').filter({ hasText: 'internal note' }),
      ).toBeVisible();
      await expect(employee.getByRole('button', { name: 'Send to customer' })).toBeDisabled();
    });

    await test.step('the customer never sees the note, quoted or otherwise', async () => {
      await expect(customer.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
      await expect(customer.locator('body')).not.toContainText('underwriting');
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
