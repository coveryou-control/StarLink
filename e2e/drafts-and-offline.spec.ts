/**
 * Draft recovery and pending-send states (`STARLINK_TEST_STRATEGY.md` §1, E2E row).
 *
 * The strategy asks the browser suite for "offline/reconnect/draft recovery; pending-send
 * states". All three are properties of a real browser and cannot be established anywhere
 * else: drafts live in IndexedDB, the pending state is a render that exists only between
 * a click and a response, and "offline" is a condition of the network stack. The unit
 * tests for `DraftStore` run against `fake-indexeddb` and prove the store; they cannot
 * prove that a reload restores what an agent typed.
 *
 * The mode-separation assertion is the important one. The plan states it as a rule: "a
 * shared machine must not surface a colleague's unsent text, and a half-written internal
 * note must never become the body of a customer reply". A draft keyed only by
 * conversation would do exactly that on a mode switch — silently, and in the direction
 * that leaks.
 */
import { expect, test } from '@playwright/test';

import { claimFromQueue, signIn, startCustomerConversation } from './support/flows.js';
import { resetTeamWork } from './support/reset.js';

const NOTE_DRAFT = 'Half-written note: ask underwriting about clause 4.';
const REPLY_DRAFT = 'Half-written reply to the customer.';

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

test('an unsent draft survives a reload, and never crosses into the other mode', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  try {
    await startCustomerConversation(customer, 'A question about my premium.');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);
    const conversationUrl = employee.url();

    await test.step('a half-written internal note is not offered as a customer reply', async () => {
      const visibility = employee.getByRole('radiogroup', { name: 'Message visibility' });
      await visibility.getByRole('radio', { name: 'Internal note' }).click();
      await employee.getByLabel('Internal note body').fill(NOTE_DRAFT);

      await visibility.getByRole('radio', { name: 'Reply to customer' }).click();
      // The composer that would send to a customer is EMPTY. If this ever fails, the next
      // click of "Send to customer" ships internal deliberation to them.
      await expect(employee.getByLabel('Reply to customer body')).toHaveValue('');

      await employee.getByLabel('Reply to customer body').fill(REPLY_DRAFT);
      await visibility.getByRole('radio', { name: 'Internal note' }).click();
      await expect(employee.getByLabel('Internal note body')).toHaveValue(NOTE_DRAFT);
    });

    await test.step('both drafts survive a full reload', async () => {
      // The autosave debounce is 400ms; this waits past it rather than racing it.
      await employee.waitForTimeout(1_200);
      await employee.goto(conversationUrl);

      const visibility = employee.getByRole('radiogroup', { name: 'Message visibility' });
      await visibility.getByRole('radio', { name: 'Internal note' }).click();
      await expect(employee.getByLabel('Internal note body')).toHaveValue(NOTE_DRAFT);

      await visibility.getByRole('radio', { name: 'Reply to customer' }).click();
      await expect(employee.getByLabel('Reply to customer body')).toHaveValue(REPLY_DRAFT);
    });

    await test.step('sending clears only the draft that was sent', async () => {
      await employee.getByRole('button', { name: 'Send to customer' }).click();
      await expect(
        employee.getByRole('listitem').filter({ hasText: REPLY_DRAFT }).filter({ hasNotText: 'Sending' }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(employee.getByLabel('Reply to customer body')).toHaveValue('');

      const visibility = employee.getByRole('radiogroup', { name: 'Message visibility' });
      await visibility.getByRole('radio', { name: 'Internal note' }).click();
      await expect(employee.getByLabel('Internal note body')).toHaveValue(NOTE_DRAFT);
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});

test('a customer message sent with no network is shown as not sent, and the text is kept', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const customer = await context.newPage();

  try {
    await startCustomerConversation(customer, 'Is my renewal due this month?');

    await test.step('offline, the message is marked not sent rather than vanishing', async () => {
      await context.setOffline(true);

      await customer.getByLabel('Your message').fill('Sent while the train was in a tunnel.');
      await customer.getByRole('button', { name: 'Send' }).click();

      // The failure is stated in the thread where the person is looking. Silence here
      // would read as "delivered", which is the one thing it must never mean.
      await expect(customer.getByText('⚠ Not sent')).toBeVisible({ timeout: 20_000 });
      // The words survive, in the bubble that failed — nothing is silently dropped.
      await expect(
        customer.getByRole('listitem').filter({ hasText: 'Sent while the train was in a tunnel.' }),
      ).toBeVisible();
      // §19.4 asks for a retry, and it must be ON the failed message: retyping into the
      // composer would resend under a fresh idempotency key and could post it twice.
      await expect(customer.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(customer.getByLabel('Your message')).toHaveValue('');
    });

    await test.step('back online, retry reconciles the pending message', async () => {
      await context.setOffline(false);
      await customer.getByRole('button', { name: 'Retry' }).click();

      // "Reconciled by server id": the failed row disappears rather than lingering
      // beside the delivered copy of the same words.
      await expect(customer.getByText('⚠ Not sent')).toHaveCount(0, { timeout: 30_000 });
      await expect(
        customer.getByRole('listitem').filter({ hasText: 'Sent while the train was in a tunnel.' }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the server kept exactly one copy of it', async () => {
      /**
       * The point of reusing the idempotency key. The widget re-reads the thread from the
       * server every 8 seconds, so waiting past one poll replaces the optimistic list with
       * the server's own — and what is counted below is therefore what was actually
       * written, not what this tab believes.
       *
       * A retry under a fresh key would show two.
       */
      await customer.waitForTimeout(9_000);
      await expect(
        customer.getByRole('listitem').filter({ hasText: 'Sent while the train was in a tunnel.' }),
      ).toHaveCount(1);
    });

  } finally {
    await context.close();
  }
});

/**
 * Reconnect (TEST_STRATEGY §1 E2E row — "offline / reconnect / draft recovery";
 * note: no markdown emphasis around "reconnect" here - the closing asterisks followed
 * by a slash would end this comment block.
 * NFR-MOB-3 — "Realtime must tolerate mobile network interruption and background
 * suspension").
 *
 * The offline and draft-recovery halves of that row were covered above. Reconnect was not,
 * and it is the half where the interesting invariant lives: §19.5 and invariant 9 say
 * recovery is a **re-fetch**, never a replay — "no state exists only in an event". A client
 * that came back and applied a buffered stream would be relying on the transport to be the
 * source of truth, which is precisely what the architecture refuses.
 *
 * So this drops the network under a live conversation, has the customer say something while
 * the agent is unreachable, and then restores it. The message must appear **without a
 * reload**, because the agent did not press anything — the socket reconnected and the page
 * re-read the thread.
 *
 * This is NOT G-18. That is a reconnect *storm* under load (a thundering-herd bound across
 * thousands of sockets) and needs the load harness and a target environment. This is one
 * client losing its network, which is the journey NFR-MOB-3 describes.
 */
test('a dropped connection recovers by re-reading the thread, not by replaying (NFR-MOB-3)', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const employeeContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const employee = await employeeContext.newPage();

  const WHILE_OFFLINE = 'Sent while the agent was in a lift.';

  try {
    await startCustomerConversation(customer, 'Is my address change done?');
    await signIn(employee, 'agent');
    await claimFromQueue(employee);

    await test.step('the agent is reading the thread when the network drops', async () => {
      await expect(employee.getByRole('list', { name: 'Messages' })).toBeVisible();
      await employeeContext.setOffline(true);
    });

    await test.step('the customer writes while the agent is unreachable', async () => {
      await customer.getByLabel('Your message').fill(WHILE_OFFLINE);
      await customer.getByRole('button', { name: 'Send' }).click();
      await expect(
        customer.getByRole('listitem').filter({ hasText: WHILE_OFFLINE }).filter({ hasNotText: 'Sending' }),
      ).toBeVisible({ timeout: 30_000 });

      // The agent cannot have it yet - and must not be shown a half-truth in the meantime.
      await expect(employee.getByText(WHILE_OFFLINE)).toHaveCount(0);
    });

    await test.step('coming back online re-reads the thread, with no reload', async () => {
      await employeeContext.setOffline(false);

      /**
       * Deliberately no `page.reload()`. A reload would prove only that the API returns
       * the message, which the customer surface has already demonstrated. What is under
       * test is that the CLIENT notices it is connected again and re-reads on its own -
       * socket.io reconnects with backoff and jitter, and the page re-fetches on connect.
       *
       * The wait is generous because the backoff is deliberately not instant: reconnection
       * delay starts at 500ms and grows, with full jitter, precisely so a fleet of clients
       * does not return in lockstep.
       */
      await expect(employee.getByText(WHILE_OFFLINE)).toBeVisible({ timeout: 60_000 });
    });

    await test.step('live delivery RESUMES — the socket rejoined the room, not just reconnected', async () => {
      /**
       * The step this test was missing, and the reason it has to be here.
       *
       * The previous step passes whether or not the socket re-subscribed: the page
       * re-fetches on every `connect`, so a single `onRefetch` produces the message even
       * on a socket that is in no room at all. That is exactly what was happening. Room
       * membership is per-connection, kept by the gateway against a socket id, and the
       * subscribe was emitted from an effect keyed on the conversation id — which never
       * re-ran, because Socket.IO reuses the `Socket` object across reconnects.
       *
       * So the thread went permanently deaf after any network blip while still displaying
       * LIVE, and this file's own reconnect test reported success. The conversation page
       * has no polling fallback — the queue, bell and load panels all poll, this does not —
       * so nothing else recovered it.
       *
       * A message sent AFTER the reconnect has settled can only arrive by delivery. The
       * agent does nothing here: no reload, no click, no navigation, nothing that would
       * trigger another re-fetch.
       */
      const AFTER_RECONNECT = 'And one more thing, now that you are back.';

      await customer.getByLabel('Your message').fill(AFTER_RECONNECT);
      await customer.getByRole('button', { name: 'Send' }).click();

      await expect(
        employee.getByText(AFTER_RECONNECT),
        'the reconnected socket never rejoined the conversation room, so the thread is ' +
          'silently receiving nothing while showing LIVE',
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step('and the agent can reply immediately, on the same session', async () => {
      // The session survived the outage: an expired or dropped cookie would surface here
      // as a refusal rather than a send.
      await employee.getByLabel('Reply to customer body').fill('Yes, the address change is done.');
      await employee.getByRole('button', { name: 'Send to customer' }).click();
      await expect(customer.getByText('Yes, the address change is done.')).toBeVisible({
        timeout: 30_000,
      });
    });
  } finally {
    await customerContext.close();
    await employeeContext.close();
  }
});
